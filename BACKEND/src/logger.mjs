// src/logger.mjs
import { promises as fs } from "node:fs";
import path from "node:path";

const LOG_DIR = process.env.LOG_DIR || "logs";
const LOG_FILE = process.env.LOG_FILE || "internet-events.log"; // JSONL
const LOG_PATH = path.join(process.cwd(), LOG_DIR, LOG_FILE);

async function ensureLogDir() {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
}

export function getLogPath() {
  return LOG_PATH;
}

export async function appendEvent(event) {
  await ensureLogDir();
  const line = JSON.stringify(event) + "\n";
  await fs.appendFile(LOG_PATH, line, "utf8");
}

export async function readTail({ limit = 200 } = {}) {
  await ensureLogDir();

  let content = "";
  try {
    content = await fs.readFile(LOG_PATH, "utf8");
  } catch {
    return { path: LOG_PATH, count: 0, lines: [] };
  }

  const lines = content
    .split("\n")
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(2000, Number(limit) || 200)));

  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });

  return { path: LOG_PATH, count: parsed.length, lines: parsed };
}

export async function readRange({ offset = 0, limit = 200 } = {}) {
  await ensureLogDir();

  let content = "";
  try {
    content = await fs.readFile(LOG_PATH, "utf8");
  } catch {
    return { path: LOG_PATH, offset: 0, limit, total: 0, count: 0, lines: [] };
  }

  const all = content.split("\n").filter(Boolean);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));

  const slice = all.slice(off, off + lim).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });

  return {
    path: LOG_PATH,
    offset: off,
    limit: lim,
    total: all.length,
    count: slice.length,
    lines: slice,
  };
}
