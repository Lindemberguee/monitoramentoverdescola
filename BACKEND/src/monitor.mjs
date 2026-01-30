// src/monitor.mjs
import { CONFIG } from "./config.mjs";
import { UnifiApi, pickGateway, readWanUp, readWanStatusFromGroups } from "./unifi.mjs";
import { probeInternet } from "./probe.mjs";

function iso() {
  return new Date().toISOString();
}

export function stateLabel(s) {
  if (s === "DOWN") return "🔴 INTERNET DOWN";
  if (s === "DEGRADED") return "🟠 INSTÁVEL";
  if (s === "UNKNOWN") return "⚪ DESCONHECIDO";
  return "🟢 OK";
}

export class Monitor {
  constructor() {
    this.api = new UnifiApi();

    this.state = "UNKNOWN"; // OK | DEGRADED | DOWN | UNKNOWN
    this.fail = 0;
    this.succ = 0;

    this.degradedAfterFails = Number(process.env.DEGRADED_AFTER_FAILS ?? 2);
    this.downAfterFails = Number(process.env.DOWN_AFTER_FAILS ?? 4);
    this.okAfterSucc = Number(process.env.OK_AFTER_SUCCESSES ?? 2);

    this.history = [];
    this.maxHistory = Number(process.env.MAX_HISTORY ?? 300);

    // callback opcional (server assina)
    this.onChange = () => {};

    // último entry gerado
    this.lastEntry = null;
  }

  snapshot() {
    return { ts: iso(), state: this.state, history: this.history };
  }

  pushHistory(entry) {
    this.history.unshift(entry);
    this.lastEntry = entry;
    if (this.history.length > this.maxHistory) this.history.length = this.maxHistory;
  }

  setState(next, details) {
    const prev = this.state;
    this.state = next;

    const entry = { ts: iso(), state: next, ...details };
    this.pushHistory(entry);

    if (prev !== next) {
      this.onChange({ prev, next, entry });
    }

    return { entry, prev, next, changed: prev !== next };
  }

  async tick() {
    const ts = iso();

    // UniFi devices pode falhar: não mata o tick
    let devices = [];
    let unifiError = null;
    try {
      devices = await this.api.getAllDevices(CONFIG.siteId);
    } catch (e) {
      unifiError = e?.message ?? String(e);
    }

    const probe = await probeInternet();
    const gw = pickGateway(devices);
    // 1) Fallback simples (depende do payload de devices)
    let wanUp = readWanUp(gw); // pode vir null dependendo da API/versão

    // 2) Fonte "oficial" do UI (WAN network groups, traz porta/uptime/prioridade...)
    let wan = null;
    let wanGroups = null;
    try {
      const resp = await this.api.listWanNetworkGroups(CONFIG.siteId);
      const groups =
        resp?.wan_network_groups ??
        resp?.wanNetworkGroups ??
        resp?.data ??
        (Array.isArray(resp) ? resp : null);

      if (Array.isArray(groups)) {
        wanGroups = groups;
        const status = readWanStatusFromGroups(groups);
        wan = status.primary;
        if (status.up !== null) wanUp = status.up;
      }
    } catch (e) {
      // silencioso: WAN rica é "best effort"; mantém o monitor vivo
    }

    const base = {
      ts,
      probe,
      wanUp,
      wan,
      wanGroups,
      unifiError,
      gateway: gw ? { id: gw.id, name: gw.name, model: gw.model, type: gw.type } : null,
    };

    // 1) Se WAN explícito DOWN -> DOWN imediato
    if (wanUp === false) {
      this.fail = 0;
      this.succ = 0;
      return {
        ...this.setState("DOWN", { ...base, reason: "WAN_LINK_DOWN" }),
        snapshot: { state: this.state, history: this.history },
      };
    }

    // 2) Probe FAIL
    if (!probe.ok) {
      this.fail += 1;
      this.succ = 0;

      if (this.fail >= this.downAfterFails) {
        const r = this.setState("DOWN", { ...base, reason: "PROBE_DOWN", note: `failCount=${this.fail}` });
        return { ...r, snapshot: { state: this.state, history: this.history } };
      }

      if (this.fail >= this.degradedAfterFails) {
        const r = this.setState("DEGRADED", { ...base, reason: "PROBE_DEGRADED", note: `failCount=${this.fail}` });
        return { ...r, snapshot: { state: this.state, history: this.history } };
      }

      // ainda não mudou estado: registra entry “soft”
      const entry = { ...base, state: this.state, reason: "PROBE_FAIL_SOFT", note: `failCount=${this.fail}` };
      this.pushHistory(entry);
      return {
        entry,
        prev: this.state,
        next: this.state,
        changed: false,
        snapshot: { state: this.state, history: this.history },
      };
    }

    // 3) Probe OK
    this.succ += 1;
    this.fail = 0;

    if (this.state === "UNKNOWN" || this.succ >= this.okAfterSucc) {
      const r = this.setState("OK", { ...base, reason: "PROBE_OK", note: `okCount=${this.succ}` });
      return { ...r, snapshot: { state: this.state, history: this.history } };
    }

    // ainda não “confirmou” OK: entry soft
    const entry = { ...base, state: this.state, reason: "PROBE_OK_SOFT", note: `okCount=${this.succ}` };
    this.pushHistory(entry);
    return {
      entry,
      prev: this.state,
      next: this.state,
      changed: false,
      snapshot: { state: this.state, history: this.history },
    };
  }
}
