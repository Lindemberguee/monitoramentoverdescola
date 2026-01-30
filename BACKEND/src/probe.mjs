import { CONFIG } from "./config.mjs";

export async function probeInternet() {
  const urls = CONFIG.probeUrls.length
    ? CONFIG.probeUrls
    : ["https://one.one.one.one/cdn-cgi/trace"];

  for (const url of urls) {
    const controller = new AbortController();
    const t0 = Date.now();
    const to = setTimeout(() => controller.abort(), CONFIG.probeTimeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "Accept": "*/*" } });
      const ms = Date.now() - t0;
      if (res.ok) return { ok: true, url, ms };
    } catch {
      // ignore
    } finally {
      clearTimeout(to);
    }
  }

  return { ok: false, url: urls[0] ?? "", ms: null };
}
