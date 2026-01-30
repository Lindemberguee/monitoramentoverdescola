import { CONFIG } from "./config.mjs";

export class UnifiApi {
  constructor() {
    this.base = CONFIG.unifiBaseUrl.replace(/\/$/, "");
    this.key = CONFIG.unifiApiKey;
  }

  async get(path) {
    const url = `${this.base}${path}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-KEY": this.key,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`UniFi GET ${path} -> HTTP ${res.status} ${text}`);
    }
    return res.json();
  }

  async listSites() {
    return this.get(`/proxy/network/integration/v1/sites`);
  }

  async listDevices(siteId, { limit = 200, offset = 0 } = {}) {
    return this.get(
      `/proxy/network/integration/v1/sites/${siteId}/devices?limit=${limit}&offset=${offset}`
    );
  }

  // UniFi Network (v2) - WAN network groups (backs the UniFi UI "Internet" view)
  // Example path: /proxy/network/v2/api/site/default/wan/networkgroups
  async listWanNetworkGroups(siteId) {
    try {
      return await this.get(`/proxy/network/v2/api/site/${siteId}/wan/networkgroups`);
    } catch (e) {
      // Alguns firmwares esperam "default" aqui, mesmo quando o integration API usa UUID.
      if (siteId && siteId !== "default") {
        try {
          return await this.get(`/proxy/network/v2/api/site/default/wan/networkgroups`);
        } catch {
          // rethrow original
        }
      }
      throw e;
    }
  }

  async getAllDevices(siteId) {
    const out = [];
    let offset = 0;
    const limit = 200;

    for (;;) {
      const page = await this.listDevices(siteId, { limit, offset });
      const data = Array.isArray(page?.data) ? page.data : [];
      out.push(...data);

      if (data.length < limit) break;
      offset += limit;
    }

    return out;
  }
}

export function pickPrimaryWanGroup(groups) {
  if (!Array.isArray(groups) || !groups.length) return null;

  // Prefer the canonical "WAN" group id when present.
  const byId = groups.find((g) => String(g?.id ?? "").toUpperCase() === "WAN");
  if (byId) return byId;

  // Otherwise pick the lowest priority.
  const withPrio = groups
    .map((g) => ({ g, p: Number.isFinite(Number(g?.priority)) ? Number(g.priority) : 9999 }))
    .sort((a, b) => a.p - b.p);

  return withPrio[0]?.g ?? groups[0] ?? null;
}

export function readWanStatusFromGroups(groups) {
  const primary = pickPrimaryWanGroup(groups);
  if (!primary) return { up: null, primary: null };

  const disabled = Boolean(primary?.port_info?.disabled);
  const uptime = Number(primary?.uptime);

  // NOTE: UniFi's "uptime" in this endpoint appears to map to the UI "Tempo de At" (%).
  // Treat "disabled" as down; otherwise infer up when uptime is a finite number.
  let up = null;
  if (disabled) up = false;
  else if (Number.isFinite(uptime)) up = uptime > 0;

  return { up, primary };
}

export function pickGateway(devices) {
  // Para seu caso (USG-Pro-4), o Integration API trouxe:
  // model: "USG-Pro-4", name: "USG-Pro-4"
  return (
    devices.find((d) => d?.type === "gateway") ||
    devices.find((d) => String(d?.model ?? "").toUpperCase().includes("USG")) ||
    devices.find((d) => String(d?.name ?? "").toUpperCase().includes("USG")) ||
    devices.find((d) => String(d?.productLine ?? "").toLowerCase().includes("gateway")) ||
    null
  );
}

export function readWanUp(gw) {
  if (!gw) return null;

  // 1) Campos diretos (quando existem)
  const direct = [
    gw?.uplink?.up,
    gw?.wan?.up,
    gw?.internet?.up,
    gw?.internet?.connected,
    gw?.connectivity?.internet,
    gw?.status?.wanUp,
    gw?.wanUp,
  ];

  for (const v of direct) {
    if (typeof v === "boolean") return v;
  }

  // 2) Uplink como array (quando existe)
  const upl = gw?.uplink;
  if (Array.isArray(upl)) {
    const wan = upl.find((x) => String(x?.name ?? "").toLowerCase().includes("wan")) ?? upl[0];
    if (typeof wan?.up === "boolean") return wan.up;
    if (typeof wan?.linkUp === "boolean") return wan.linkUp;
    if (typeof wan?.connected === "boolean") return wan.connected;
  }

  // 3) Integration API: interfaces.ports (seu payload mostra interfaces -> ports)
  const ports =
    gw?.interfaces?.ports ??
    gw?.interfaces?.ethernetPorts ??
    (Array.isArray(gw?.interfaces) ? gw.interfaces : null) ??
    [];

  if (Array.isArray(ports) && ports.length) {
    const isWanPort = (p) => {
      const name = String(p?.name ?? p?.portName ?? p?.displayName ?? "").toLowerCase();
      const role = String(p?.role ?? p?.purpose ?? p?.usage ?? "").toLowerCase();
      return p?.isWan === true || role === "wan" || name.includes("wan");
    };

    const wanPorts = ports.filter(isWanPort);
    const candidates = wanPorts.length ? wanPorts : ports;

    for (const p of candidates) {
      // flags booleanos comuns
      const bools = [p?.up, p?.linkUp, p?.hasLink, p?.connected, p?.link];
      for (const b of bools) {
        if (typeof b === "boolean") return b;
      }

      // status/state string comuns
      const st = String(p?.status ?? p?.state ?? "").toLowerCase();
      if (st) {
        if (["up", "online", "connected", "ok"].includes(st)) return true;
        if (["down", "offline", "disconnected", "no_link"].includes(st)) return false;
      }
    }
  }

  return null;
}
