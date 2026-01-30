// src/server.mjs
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { createReadStream, existsSync } from "node:fs";

import { CONFIG } from "./config.mjs";
import { Monitor, stateLabel } from "./monitor.mjs";
import { appendEvent, readTail, readRange, getLogPath } from "./logger.mjs";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

// TLS self-signed (LAN)
if (process.env.ALLOW_SELF_SIGNED_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  app.log.warn("[TLS] ALLOW_SELF_SIGNED_TLS=1 -> NODE_TLS_REJECT_UNAUTHORIZED=0");
}

const monitor = new Monitor();

// WS clients
const clients = new Set();

function safeSend(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of clients) {
    const ok = safeSend(ws, payload);
    if (!ok) clients.delete(ws);
  }
}

// Sempre que o estado muda, a gente:
// 1) notifica WS
// 2) grava no .log se for queda/retorno (DOWN/OK)
monitor.onChange = async ({ prev, next, entry }) => {
  broadcast({
    type: "state_change",
    prev,
    next,
    label: stateLabel(next),
    entry,
  });

  // ✅ log só em queda/retorno (ajuste como quiser)
  if (next === "DOWN") {
    await appendEvent({
      ts: new Date().toISOString(),
      kind: "INTERNET_DOWN",
      prev,
      next,
      probe: entry?.probe ?? null,
      wanUp: entry?.wanUp ?? null,
      gateway: entry?.gateway ?? null,
      note: entry?.note ?? entry?.reason ?? null,
    });
  }

  if (prev === "DOWN" && next === "OK") {
    await appendEvent({
      ts: new Date().toISOString(),
      kind: "INTERNET_RESTORED",
      prev,
      next,
      probe: entry?.probe ?? null,
      wanUp: entry?.wanUp ?? null,
      gateway: entry?.gateway ?? null,
      note: entry?.note ?? entry?.reason ?? null,
    });
  }
};

// -------------------- WS --------------------
app.get("/ws", { websocket: true }, (conn, req) => {
  // compat com versões (conn pode ser ws direto ou { socket })
  const ws = conn?.socket ?? conn;
  if (!ws) return;

  clients.add(ws);

  // snapshot inicial
  safeSend(
    ws,
    JSON.stringify({
      type: "snapshot",
      data: monitor.snapshot(),
      label: stateLabel(monitor.state),
      state: monitor.state,
    })
  );

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

// -------------------- API Status --------------------
app.get("/api/status", async () => {
  return {
    state: monitor.state,
    label: stateLabel(monitor.state),
    history: monitor.history,
  };
});

app.get("/healthz", async () => ({ ok: true }));

// -------------------- API Logs --------------------
// tail (últimas linhas)
app.get("/api/logs/tail", async (req) => {
  const limit = Number(req.query?.limit ?? 200);
  return readTail({ limit });
});

// paginação por offset/limit
app.get("/api/logs", async (req) => {
  const offset = Number(req.query?.offset ?? 0);
  const limit = Number(req.query?.limit ?? 200);
  return readRange({ offset, limit });
});

// download arquivo .log
app.get("/api/logs/download", async (req, reply) => {
  const p = getLogPath();
  if (!existsSync(p)) {
    return reply.code(404).send({ error: "log_not_found", path: p });
  }
  reply
    .header("Content-Type", "text/plain; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="internet-events.log"`);
  return reply.send(createReadStream(p));
});

// -------------------- Loop do Monitor (tick real-time) --------------------
setInterval(async () => {
  try {
    const r = await monitor.tick(); // { entry, changed, prev, next, snapshot }

    broadcast({
      type: "tick",
      state: monitor.state,
      label: stateLabel(monitor.state),
      entry: r.entry,
    });
  } catch (e) {
    app.log.error(e, "monitor tick failed");
  }
}, CONFIG.intervalMs);

// tick inicial
monitor.tick().catch((e) => app.log.error(e, "initial tick failed"));

// start
app.listen({ port: CONFIG.port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Monitor API/WS: http://localhost:${CONFIG.port}`);
  app.log.info(`Log file: ${getLogPath()}`);
});
