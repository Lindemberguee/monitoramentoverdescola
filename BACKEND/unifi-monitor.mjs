import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * UniFi Monitor - USG WAN/Internet monitoring (UniFi OS + legacy controller)
 * - AUTO mode: tries UniFi OS first; if fails, falls back to legacy (8443)
 * - Detects WAN link up/down from USG device fields when available
 * - Uses active probe URLs to detect "internet down/unstable even if link is up"
 * - Hysteresis to reduce flapping alerts
 */

// =========================
// Env & Defaults
// =========================
const ENV = {
  UNIFI_BASE_URL: process.env.UNIFI_BASE_URL?.trim(),
  UNIFI_USERNAME: process.env.UNIFI_USERNAME?.trim(),
  UNIFI_PASSWORD: process.env.UNIFI_PASSWORD?.trim(),
  UNIFI_SITE: (process.env.UNIFI_SITE ?? "default").trim(),
  INTERVAL_MS: Number(process.env.INTERVAL_MS ?? 15000),
  ALERT_WEBHOOK: process.env.ALERT_WEBHOOK?.trim() || "",
  MODE: (process.env.UNIFI_MODE ?? "auto").trim().toLowerCase(), // auto | unifios | legacy
  PROBE_URLS: (process.env.PROBE_URLS ??
    "https://one.one.one.one/cdn-cgi/trace,https://www.google.com/generate_204")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  PROBE_TIMEOUT_MS: Number(process.env.PROBE_TIMEOUT_MS ?? 3000),
  PROBE_FAILS_FOR_DEGRADED: Number(process.env.PROBE_FAILS_FOR_DEGRADED ?? 2),
  PROBE_SUCCESSES_FOR_OK: Number(process.env.PROBE_SUCCESSES_FOR_OK ?? 2),
};

function requireEnv(name, value) {
  if (!value) throw new Error(`Defina ${name} no .env`);
}
try {
  requireEnv("UNIFI_BASE_URL", ENV.UNIFI_BASE_URL);
  requireEnv("UNIFI_USERNAME", ENV.UNIFI_USERNAME);
  requireEnv("UNIFI_PASSWORD", ENV.UNIFI_PASSWORD);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

function normalizeBaseUrl(url) {
  let u = url.endsWith("/") ? url.slice(0, -1) : url;
  // If user provided something like 192.168.1.200, add https://
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function withPort(url, port) {
  // If already has explicit port, keep it
  const m = url.match(/^(https?:\/\/[^\/:]+)(:\d+)?(\/.*)?$/i);
  if (!m) return url;
  const host = m[1];
  const existingPort = m[2];
  const path = m[3] ?? "";
  if (existingPort) return `${host}${existingPort}${path}`;
  return `${host}:${port}${path}`;
}

const BASE_URL = normalizeBaseUrl(ENV.UNIFI_BASE_URL);

// =========================
// Helpers
// =========================
function nowIso() {
  return new Date().toISOString();
}

function labelState(state) {
  if (state === "DOWN") return "🔴 WAN/INTERNET DOWN";
  if (state === "DEGRADED") return "🟠 INSTABILIDADE / PROBE FALHANDO";
  if (state === "UNKNOWN") return "⚪ STATUS DESCONHECIDO";
  return "🟢 OK";
}

async function postWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(nowIso(), "Falha webhook:", err?.message ?? err);
  }
}

function getSetCookies(res) {
  // Node fetch (undici) supports getSetCookie() in newer versions
  const anyRes = res;
  const setCookies = anyRes.headers?.getSetCookie?.() ?? [];
  if (setCookies.length) return setCookies;

  const sc = res.headers.get("set-cookie");
  return sc ? [sc] : [];
}

function mergeCookies(setCookies) {
  return setCookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function httpProbe(urls, timeoutMs) {
  // Probe "internet ok" using multiple targets (any success => ok)
  for (const url of urls) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: "*/*" } });
      if (res.ok) return { ok: true, url };
    } catch {
      // ignore
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, url: urls[0] ?? "" };
}

function pickUSG(devices) {
  const arr = Array.isArray(devices) ? devices : [];
  return (
    arr.find((d) => d?.type === "ugw") ||
    arr.find((d) => String(d?.model ?? "").toUpperCase().includes("USG")) ||
    null
  );
}

function readWanUpFromUSG(usg) {
  // common patterns: usg.uplink.up (boolean) or uplink array with .up
  const u = usg?.uplink;
  if (typeof u?.up === "boolean") return u.up;

  if (Array.isArray(u)) {
    const wan = u.find((x) => String(x?.name ?? "").toLowerCase().includes("wan")) ?? u[0];
    if (typeof wan?.up === "boolean") return wan.up;
  }
  return null; // unknown
}

function parseDataEnvelope(json) {
  // UniFi often returns { meta, data: [...] }
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.rows)) return json.rows;
  return [];
}

function wanHealthFromHealth(healthArr) {
  const wan = healthArr.find((h) => String(h?.subsystem ?? "").toLowerCase() === "wan");
  return wan ?? null;
}

// =========================
// UniFi API Client (supports UniFi OS + legacy)
// =========================
class UniFiClient {
  constructor({ baseUrl, mode }) {
    this.baseUrl = baseUrl;
    this.mode = mode; // auto|unifios|legacy
    this.cookie = "";
    this.effectiveMode = null; // unifios|legacy
    this.baseUrlEffective = null;
  }

  async loginUniFiOS(baseUrl) {
    const url = `${baseUrl}/api/auth/login`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: ENV.UNIFI_USERNAME, password: ENV.UNIFI_PASSWORD }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`UniFiOS login falhou: HTTP ${res.status} ${text}`);
    }
    const cookies = getSetCookies(res);
    this.cookie = mergeCookies(cookies);
    if (!this.cookie) throw new Error("UniFiOS login OK, mas sem cookie (Set-Cookie ausente).");
    this.effectiveMode = "unifios";
    this.baseUrlEffective = baseUrl;
  }

  async loginLegacy(baseUrlLegacy) {
    // Legacy controllers typically listen on 8443 and use /api/login
    const url = `${baseUrlLegacy}/api/login`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: ENV.UNIFI_USERNAME, password: ENV.UNIFI_PASSWORD }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Legacy login falhou: HTTP ${res.status} ${text}`);
    }
    const cookies = getSetCookies(res);
    this.cookie = mergeCookies(cookies);
    if (!this.cookie) throw new Error("Legacy login OK, mas sem cookie (Set-Cookie ausente).");
    this.effectiveMode = "legacy";
    this.baseUrlEffective = baseUrlLegacy;
  }

  async ensureLogin() {
    if (this.cookie && this.effectiveMode && this.baseUrlEffective) return;

    const base = this.baseUrl;
    const base8443 = withPort(base, 8443);

    if (this.mode === "unifios") {
      await this.loginUniFiOS(base);
      return;
    }
    if (this.mode === "legacy") {
      await this.loginLegacy(base8443);
      return;
    }

    // auto: try UniFi OS first; if fails, try legacy
    try {
      await this.loginUniFiOS(base);
      return;
    } catch (e1) {
      try {
        await this.loginLegacy(base8443);
        return;
      } catch (e2) {
        throw new Error(
          `Falhou login em auto.\n- UniFi OS: ${e1.message}\n- Legacy(8443): ${e2.message}`
        );
      }
    }
  }

  async request(path, { method = "GET", body } = {}) {
    await this.ensureLogin();
    const url = `${this.baseUrlEffective}${path}`;
    const headers = { Accept: "application/json", Cookie: this.cookie };
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });

    if (res.status === 401 || res.status === 403) {
      // session expired -> relogin once
      this.cookie = "";
      await this.ensureLogin();
      return this.request(path, { method, body });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} em ${path}: ${text}`);
    }

    return res.json();
  }

  // Endpoints differ between UniFi OS and legacy
  async statDevices(site) {
    if (this.effectiveMode === "unifios") {
      return this.request(`/proxy/network/api/s/${site}/stat/device`);
    }
    return this.request(`/api/s/${site}/stat/device`);
  }

  async statHealth(site) {
    if (this.effectiveMode === "unifios") {
      return this.request(`/proxy/network/api/s/${site}/stat/health`);
    }
    return this.request(`/api/s/${site}/stat/health`);
  }

  async statEvent(site) {
    if (this.effectiveMode === "unifios") {
      return this.request(`/proxy/network/api/s/${site}/stat/event`);
    }
    return this.request(`/api/s/${site}/stat/event`);
  }

  async statAlarm(site) {
    if (this.effectiveMode === "unifios") {
      return this.request(`/proxy/network/api/s/${site}/stat/alarm`);
    }
    return this.request(`/api/s/${site}/stat/alarm`);
  }
}

// =========================
// State machine (hysteresis)
// =========================
class HealthStateMachine {
  constructor() {
    this.state = "UNKNOWN"; // OK | DEGRADED | DOWN | UNKNOWN
    this.failCount = 0;
    this.successCount = 0;
  }

  update({ wanUp, probeOk }) {
    // Hard DOWN if WAN link is explicitly down
    if (wanUp === false) {
      this.state = "DOWN";
      this.failCount = 0;
      this.successCount = 0;
      return this.state;
    }

    // If wanUp is true or unknown, use probe hysteresis to decide DEGRADED vs OK
    if (!probeOk) {
      this.failCount += 1;
      this.successCount = 0;

      if (this.failCount >= ENV.PROBE_FAILS_FOR_DEGRADED) {
        // If link is up but probes failing: DEGRADED (internet problem)
        // If wanUp is unknown, still consider degraded (best-effort)
        this.state = "DEGRADED";
      }
      return this.state;
    }

    // probe ok
    this.successCount += 1;
    this.failCount = 0;

    if (this.successCount >= ENV.PROBE_SUCCESSES_FOR_OK) {
      this.state = "OK";
    }

    // If we were UNKNOWN and got a success, promote to OK faster
    if (this.state === "UNKNOWN") this.state = "OK";

    return this.state;
  }
}

// =========================
// Main loop
// =========================
async function main() {
  const client = new UniFiClient({ baseUrl: BASE_URL, mode: ENV.MODE });

  const sm = new HealthStateMachine();
  let lastNotifiedState = null;

  console.log(nowIso(), "Iniciando UniFi Monitor…");
  console.log("Base:", BASE_URL);
  console.log("Modo:", ENV.MODE, "| Site:", ENV.UNIFI_SITE, "| Interval:", ENV.INTERVAL_MS, "ms");

  for (;;) {
    const ts = nowIso();
    try {
      const [devicesJson, healthJson, probe] = await Promise.all([
        client.statDevices(ENV.UNIFI_SITE),
        client.statHealth(ENV.UNIFI_SITE),
        httpProbe(ENV.PROBE_URLS, ENV.PROBE_TIMEOUT_MS),
      ]);

      const devices = parseDataEnvelope(devicesJson);
      const healthArr = parseDataEnvelope(healthJson);

      const usg = pickUSG(devices);
      const wanUp = readWanUpFromUSG(usg);
      const wanHealth = wanHealthFromHealth(healthArr);

      const nextState = sm.update({ wanUp, probeOk: probe.ok });

      // log enxuto
      const usgName = usg?.name ?? usg?.model ?? "USG?";
      console.log(
        ts,
        labelState(nextState),
        `mode=${client.effectiveMode}`,
        `usg=${usgName}`,
        `wanUp=${wanUp}`,
        `probeOk=${probe.ok}`,
        probe.ok ? "" : `probeUrl=${probe.url}`
      );

      // notify only on state changes
      if (nextState !== lastNotifiedState) {
        lastNotifiedState = nextState;

        await postWebhook(ENV.ALERT_WEBHOOK, {
          text: `${labelState(nextState)} | usg=${usgName} | wanUp=${wanUp} | probeOk=${probe.ok} | mode=${client.effectiveMode}`,
          ts,
          state: nextState,
          details: {
            baseUrl: BASE_URL,
            site: ENV.UNIFI_SITE,
            mode: client.effectiveMode,
            probe,
            wanUp,
            wanHealth,
            usg: usg
              ? {
                  name: usg.name,
                  model: usg.model,
                  ip: usg.ip,
                  version: usg.version,
                }
              : null,
          },
        });
      }
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.error(ts, "Erro ciclo:", msg);

      // If we fail to query UniFi at all, treat as UNKNOWN and alert once
      if (sm.state !== "UNKNOWN") {
        sm.state = "UNKNOWN";
        lastNotifiedState = "UNKNOWN";
        await postWebhook(ENV.ALERT_WEBHOOK, { text: `⚠️ Monitor UNKNOWN: ${msg}`, ts });
      }
    }

    await sleep(ENV.INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
