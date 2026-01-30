import "dotenv/config";

function must(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Defina ${name} no .env`);
  return v;
}

export const CONFIG = {
  unifiBaseUrl: must("UNIFI_BASE_URL").replace(/\/$/, ""),
  unifiApiKey: must("UNIFI_API_KEY"),
  siteId: must("UNIFI_SITE_ID"),
  intervalMs: Number(process.env.INTERVAL_MS ?? 15000),
  probeUrls: (process.env.PROBE_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? 3500),
  failsForDegraded: Number(process.env.FAILS_FOR_DEGRADED ?? 2),
  successesForOk: Number(process.env.SUCCESSES_FOR_OK ?? 2),
  port: Number(process.env.PORT ?? 3333),
  alertWebhook: (process.env.ALERT_WEBHOOK ?? "").trim(),
};
