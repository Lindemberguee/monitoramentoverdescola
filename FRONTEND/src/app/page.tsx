"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  Download,
  Globe,
  History,
  Router,
  Server,
  Wifi,
  WifiOff,
  XCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Network,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// --- Utility Utils ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
type Probe = { ok: boolean; url?: string; ms?: number | null };
type Gateway = {
  id?: string;
  name?: string;
  model?: string;
  type?: string;
  ipAddress?: string;
  macAddress?: string;
};

type WanPortInfo = {
  disabled: boolean;
  port_idx: number;
  port_ifname: string;
};

type WanInterface = {
  id: string;
  name?: string;
  is_mobile_broadband?: boolean;
  load_balancing_mode?: string;
  network_id?: string;
  port_info?: WanPortInfo;
  priority?: number;
  wan_magic_enabled?: boolean;
};

type HistoryItem = {
  ts: string;
  state: "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";
  wanUp: boolean | null;
  wan?: WanInterface | null;
  wanGroups?: WanInterface[] | null;
  probe?: Probe;
  gateway?: Gateway;
  note?: string;
  reason?: string;
  unifiError?: string | null;
};

type StatusPayload = {
  state: HistoryItem["state"];
  label: string;
  history: HistoryItem[];
};

type WSMessage =
  | { type: "snapshot"; data: StatusPayload; label: string }
  | { type: "tick"; entry: HistoryItem; state?: string; label?: string }
  | { type: "state_change" };

// --- Config ---
const SLOW_MS = Number(process.env.NEXT_PUBLIC_SLOW_MS ?? 120);
const VERY_SLOW_MS = Number(process.env.NEXT_PUBLIC_VERY_SLOW_MS ?? 250);
const STALE_MS = Number(process.env.NEXT_PUBLIC_STALE_MS ?? 35000);
const WINDOW_SIZE = Math.max(5, Number(process.env.NEXT_PUBLIC_WINDOW_SIZE ?? 12));
const MONITOR_WS_PORT = Number(process.env.NEXT_PUBLIC_MONITOR_WS_PORT ?? 3333);

// --- Formatters ---
function fmtTime(ts?: string) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

function fmtDateTime(ts?: string) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("pt-BR");
  } catch {
    return ts;
  }
}

// --- Logic Helpers ---
function getStateConfig(s: HistoryItem["state"]) {
  switch (s) {
    case "OK":
      return {
        label: "OPERACIONAL",
        color: "text-emerald-400",
        bg: "bg-emerald-500/10",
        border: "border-emerald-500/20",
        icon: CheckCircle2,
        dot: "bg-emerald-500",
      };
    case "DEGRADED":
      return {
        label: "INSTÁVEL",
        color: "text-amber-400",
        bg: "bg-amber-500/10",
        border: "border-amber-500/20",
        icon: AlertTriangle,
        dot: "bg-amber-500",
      };
    case "DOWN":
      return {
        label: "FORA DO AR",
        color: "text-rose-400",
        bg: "bg-rose-500/10",
        border: "border-rose-500/20",
        icon: XCircle,
        dot: "bg-rose-500",
      };
    default:
      return {
        label: "DESCONHECIDO",
        color: "text-slate-400",
        bg: "bg-slate-800/40",
        border: "border-slate-700/60",
        icon: AlertTriangle,
        dot: "bg-slate-500",
      };
  }
}

function getPingConfig(ms: number | null | undefined) {
  if (ms == null) return { color: "text-slate-500", label: "—" };
  if (ms >= VERY_SLOW_MS) return { color: "text-rose-400", label: "Crítico" };
  if (ms >= SLOW_MS) return { color: "text-amber-400", label: "Lento" };
  return { color: "text-emerald-400", label: "Ótimo" };
}

function mean(nums: number[]) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddev(nums: number[]) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const v = mean(nums.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function qualityFromWindow(samples: number[]) {
  const avg = mean(samples);
  const jit = stddev(samples);

  if (!samples.length) return { label: "—", color: "text-slate-400", avg: 0, jit: 0 };

  if (avg >= VERY_SLOW_MS || jit >= 120) return { label: "RUIM", color: "text-rose-400", avg, jit };
  if (avg >= SLOW_MS || jit >= 60) return { label: "REGULAR", color: "text-amber-400", avg, jit };
  return { label: "BOA", color: "text-emerald-400", avg, jit };
}

function safeShortId(id?: string, size = 12) {
  if (!id) return "—";
  if (id.length <= size) return id;
  return `${id.slice(0, size)}…`;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// --- Main Component ---
export default function MonitorPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [wsStatus, setWsStatus] = useState<"online" | "offline" | "reconnecting">("offline");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const [historyLimitDesktop, setHistoryLimitDesktop] = useState(120);
  const [historyLimitMobile, setHistoryLimitMobile] = useState(20);
  const [copied, setCopied] = useState<"probe" | "none">("none");

  const lastTickAtRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryRef = useRef(0);
  const aliveRef = useRef(true);

  const latest = useMemo(() => data?.history?.[0], [data]);
  const state = data?.state ?? "UNKNOWN";
  const stateConf = getStateConfig(state);
  const StateIcon = stateConf.icon;

  const stale = useMemo(() => {
    const last = lastTickAtRef.current;
    if (!last) return false;
    return Date.now() - last > STALE_MS;
  }, [now]);

  useEffect(() => {
    document.title = `${state === "OK" ? "🟢" : state === "DEGRADED" ? "🟡" : state === "DOWN" ? "🔴" : "⚪"} ${state} • UniFi Monitor`;
  }, [state]);

  const windowSamples = useMemo(() => {
    const hist = data?.history ?? [];
    const ms = hist
      .map((h) => h.probe?.ms)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    return ms.slice(0, WINDOW_SIZE);
  }, [data]);

  const quality = useMemo(() => qualityFromWindow(windowSamples), [windowSamples]);

  const chartData = useMemo(() => {
    if (!data?.history) return [];
    return [...data.history]
      .reverse()
      .slice(-60)
      .map((h) => ({
        time: new Date(h.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        fullTime: new Date(h.ts).toLocaleString(),
        ms: typeof h.probe?.ms === "number" ? h.probe.ms : 0,
        ok: !!h.probe?.ok,
      }));
  }, [data]);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/monitor/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StatusPayload;
      setData(json);
      const ts = json.history?.[0]?.ts;
      if (ts) lastTickAtRef.current = Date.parse(ts) || Date.now();
    } catch (e: any) {
      setError(e?.message ?? "Falha ao carregar status");
    }
  }

  function buildWsUrl() {
    if (typeof window === "undefined") return "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.hostname}:${MONITOR_WS_PORT}/ws`;
  }

  function connectWs() {
    if (!aliveRef.current) return;
    if (typeof window === "undefined") return;

    try {
      const url = buildWsUrl();
      setWsStatus((prev) => (prev === "online" ? "online" : "reconnecting"));

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        wsRetryRef.current = 0;
        setWsStatus("online");
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!aliveRef.current) return;
        setWsStatus("reconnecting");
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (!aliveRef.current) return;
        setWsStatus("reconnecting");
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WSMessage;

          if (msg?.type === "snapshot") {
            const snap = msg.data;
            setData({ state: snap.state, label: msg.label, history: snap.history ?? [] });
            const ts = snap.history?.[0]?.ts;
            if (ts) lastTickAtRef.current = Date.parse(ts) || Date.now();
            return;
          }

          if (msg?.type === "tick" && (msg as any).entry) {
            const entry = (msg as any).entry as HistoryItem;
            lastTickAtRef.current = Date.parse(entry.ts) || Date.now();
            setData((prev) => {
              const prevHist = prev?.history ?? [];
              const key = `${entry.ts}|${entry.state}|${entry.probe?.ms ?? "x"}`;
              const has = prevHist.some((h) => `${h.ts}|${h.state}|${h.probe?.ms ?? "x"}` === key);
              const nextHist = has ? prevHist : [entry, ...prevHist].slice(0, 250);

              return {
                state: ((msg as any).state ?? entry.state) as any,
                label: (msg as any).label ?? prev?.label ?? "",
                history: nextHist,
              };
            });
            return;
          }

          if (msg?.type === "state_change") {
            load();
            return;
          }
        } catch {
          /* ignore */
        }
      };
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    const attempt = Math.min(8, wsRetryRef.current + 1);
    wsRetryRef.current = attempt;
    const delay = Math.min(15000, 500 * 2 ** attempt);
    setTimeout(() => {
      if (!aliveRef.current) return;
      connectWs();
    }, delay);
  }

  useEffect(() => {
    aliveRef.current = true;
    load();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    connectWs();
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const probeMs = latest?.probe?.ms ?? null;
  const pingConf = getPingConfig(probeMs);

  const wsLabel = wsStatus === "online" ? "ONLINE" : wsStatus === "reconnecting" ? "RECONNECT" : "OFFLINE";
  const wsTone =
    wsStatus === "online" ? "text-emerald-400" : wsStatus === "reconnecting" ? "text-amber-400" : "text-rose-400";
  const wsDot =
    wsStatus === "online" ? "bg-emerald-500" : wsStatus === "reconnecting" ? "bg-amber-500" : "bg-rose-500";

  const headerHint = stale ? "ATUALIZAÇÃO PAUSADA" : "AO VIVO";
  const headerHintTone = stale ? "text-amber-300" : "text-slate-400";

  const primaryWan = latest?.wan ?? latest?.wanGroups?.[0] ?? null;
  const wanName = primaryWan?.name ?? primaryWan?.id ?? "—";
  const wanDetail = primaryWan?.port_info
    ? `${primaryWan.port_info.port_ifname} • Porta ${primaryWan.port_info.port_idx}`
    : primaryWan?.network_id
      ? `network_id ${primaryWan.network_id}`
      : "—";

  const WanIcon = latest?.wanUp == null ? Wifi : latest.wanUp ? ArrowUpCircle : ArrowDownCircle;
  const wanTone = latest?.wanUp == null ? "text-slate-200" : latest.wanUp ? "text-emerald-300" : "text-rose-300";
  const wanSubtext =
    latest?.wanUp == null ? wanDetail : `${wanDetail} • ${latest.wanUp ? "UP" : "DOWN"}`;

  return (
    <div className="min-h-screen bg-[#070A12] text-slate-200 selection:bg-indigo-500/30 font-sans">
      {/* background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_circle_at_0%_0%,rgba(99,102,241,0.20),transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_circle_at_100%_10%,rgba(16,185,129,0.12),transparent_55%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(800px_circle_at_60%_100%,rgba(244,63,94,0.10),transparent_55%)]" />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-[#070A12] to-slate-950" />
      </div>

      <main className="relative mx-auto max-w-7xl px-4 pb-10 pt-6 md:px-6 lg:px-8">
        {/* --- Sticky Top Bar --- */}
        <div className="sticky top-0 z-30 -mx-4 mb-6 border-b border-slate-800/60 bg-[#070A12]/75 px-4 py-4 backdrop-blur md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
          <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-500/15 ring-1 ring-inset ring-indigo-500/20">
                <Activity className="h-5 w-5 text-indigo-300" />
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-white">UniFi Monitor</h1>
                  <span
                    className={cn(
                      "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset",
                      stateConf.bg,
                      stateConf.border,
                      stateConf.color
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", stateConf.dot)} />
                    {stateConf.label}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className={cn("inline-flex items-center gap-2 font-semibold", wsTone)}>
                    <span className={cn("h-2 w-2 rounded-full", wsDot)} />
                    WS {wsLabel}
                  </span>

                  <span className="text-slate-700">•</span>
{/* 
                  <span className={cn("inline-flex items-center gap-2 font-semibold", headerHintTone)}>
                    {stale ? <AlertTriangle className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                    {headerHint}
                  </span> */}

                  <span className="text-slate-700">•</span>

                  <span className={cn("font-mono font-semibold", quality.color)}>
                    QUALIDADE {quality.label}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={load}
                className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-900/70 hover:border-slate-700"
              >
                Atualizar
              </button>

              <button
                onClick={() => {
                  const blob = new Blob([JSON.stringify(data ?? {}, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `unifi-status-${Date.now()}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                disabled={!data}
                className="group inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm font-semibold transition hover:bg-slate-900/70 hover:border-slate-700 disabled:opacity-50"
              >
                <Download className="h-4 w-4 text-slate-400 group-hover:text-slate-200" />
                Exportar JSON
              </button>
            </div>
          </header>
        </div>

        {/* --- Alerts (sem banner de “30s”) --- */}
        <div className="mb-6 space-y-3">
          {!!latest?.unifiError && (
            <Notice tone="danger" icon={<XCircle className="h-5 w-5" />} title="UniFi API Error">
              {latest.unifiError}
            </Notice>
          )}
          {error && (
            <Notice tone="danger" icon={<XCircle className="h-5 w-5" />} title="Erro">
              {error}
            </Notice>
          )}
        </div>

        {/* --- Dashboard --- */}
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex flex-col gap-5">
              {/* Top summary row */}
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Estado da Rede</div>
                  <div className="mt-2 flex items-center gap-3">
                    <div className={cn("rounded-2xl p-2.5 ring-1 ring-inset", stateConf.bg, stateConf.border)}>
                      <StateIcon className={cn("h-6 w-6", stateConf.color, state === "DEGRADED" ? "animate-pulse" : "")} />
                    </div>
                    <div className="min-w-0">
                      <div className={cn("text-3xl font-black tracking-tight", stateConf.color)}>{stateConf.label}</div>
                      <div className="mt-0.5 truncate text-sm text-slate-400">
                        <span className="font-mono">{data?.label ?? "Inicializando..."}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={cn("bg-slate-950/40 ring-slate-800", quality.color)}>
                    Média <span className="font-mono">{Math.round(quality.avg)}ms</span>
                    <span className="mx-1 text-slate-600">/</span>
                    Jitter <span className="font-mono">{Math.round(quality.jit)}ms</span>
                  </Badge>

                  {/* <Badge className={cn("bg-slate-950/40 ring-slate-800", stale ? "text-amber-300" : "text-slate-300")}>
                    {stale ? "SINAL IRREGULAR" : "SINAL OK"}
                  </Badge> */}
                </div>
              </div>

              {/* KPI grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatBox
                  label="Latência"
                  value={probeMs ? `${probeMs}ms` : "—"}
                  icon={<Activity className={cn("h-4 w-4", pingConf.color)} />}
                  subtext={pingConf.label}
                  color={pingConf.color}
                />
                <StatBox
                  label="Gateway"
                  value={latest?.gateway?.model ?? "—"}
                  icon={<Router className="h-4 w-4 text-indigo-300" />}
                  subtext={latest?.gateway?.name ?? "—"}
                />
                <StatBox
                  label="WAN"
                  value={wanName}
                  icon={<WanIcon className={cn("h-4 w-4", wanTone)} />}
                  color={wanTone}
                  subtext={wanSubtext}
                />
                <StatBox
                  label="Último Check"
                  value={fmtTime(latest?.ts)}
                  icon={<Clock className="h-4 w-4 text-slate-400" />}
                  subtext={fmtDateTime(latest?.ts)}
                />
              </div>

              {/* Chart */}
              <div className="rounded-2xl border border-slate-800/60 bg-slate-950/30 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Latência (últimos 60)</div>
                  <div className="text-xs text-slate-500">
                    <span className="font-mono">{SLOW_MS}ms</span> lento •{" "}
                    <span className="font-mono">{VERY_SLOW_MS}ms</span> crítico
                  </div>
                </div>

                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorMs" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                        </linearGradient>
                      </defs>

                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis
                        dataKey="time"
                        stroke="#475569"
                        tick={{ fill: "#94a3b8", fontSize: 10 }}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={28}
                        dy={10}
                      />
                      <YAxis
                        stroke="#475569"
                        tick={{ fill: "#94a3b8", fontSize: 10 }}
                        tickLine={false}
                        axisLine={false}
                        width={42}
                        tickFormatter={(value) => `${value}ms`}
                      />
                      <ReferenceLine y={SLOW_MS} stroke="#f59e0b" strokeOpacity={0.55} strokeDasharray="3 3" />
                      <ReferenceLine y={VERY_SLOW_MS} stroke="#fb7185" strokeOpacity={0.55} strokeDasharray="3 3" />

                      <Tooltip content={<ChartTooltip />} />

                      <Area
                        type="monotone"
                        dataKey="ms"
                        stroke="#6366f1"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorMs)"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </Card>

          {/* Side cards */}
          <div className="flex flex-col gap-6">
            <Card>
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-slate-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Target</h3>
                </div>

                {latest?.probe?.url && (
                  <button
                    onClick={async () => {
                      const ok = await copyToClipboard(latest.probe!.url!);
                      if (ok) {
                        setCopied("probe");
                        setTimeout(() => setCopied("none"), 900);
                      }
                    }}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-900/70"
                    title="Copiar Probe URL"
                  >
                    <Copy className="h-3.5 w-3.5 text-slate-400" />
                    {copied === "probe" ? "Copiado!" : "Copiar"}
                  </button>
                )}
              </div>

              <div className="space-y-3">
                <KeyValue
                  label="Probe URL"
                  value={latest?.probe?.url ?? "—"}
                  mono
                  wrap
                />
                <KeyValue
                  label="Gateway"
                  value={latest?.gateway?.model ?? "—"}
                  rightSub={safeShortId(latest?.gateway?.id)}
                />
                <KeyValue
                  label="Status"
                  value={latest?.note ?? latest?.reason ?? "—"}
                  wrap
                />
              </div>
            </Card>

            <Card className="flex-1">
              <div className="mb-4 flex items-center gap-2">
                <Server className="h-4 w-4 text-slate-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Legenda</h3>
              </div>
              <div className="space-y-3 text-sm">
                <RowDot label="Normal" color="bg-emerald-500" value={`< ${SLOW_MS}ms`} />
                <RowDot label="Lento" color="bg-amber-500" value={`≥ ${SLOW_MS}ms`} />
                <RowDot label="Crítico" color="bg-rose-500" value={`≥ ${VERY_SLOW_MS}ms`} />
              </div>
            </Card>
          </div>
        </div>

        {/* --- History --- */}
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between px-1">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
              <History className="h-4 w-4 text-slate-400" />
              Histórico
            </h3>

            <div className="flex items-center gap-2">
              <Badge className="bg-slate-950/40 text-slate-300 ring-slate-800">
                <span className="font-mono">{(data?.history?.length ?? 0)}</span> eventos
              </Badge>

              <div className="hidden sm:flex overflow-hidden rounded-xl border border-slate-800 bg-slate-950/30">
                <button
                  onClick={() => setHistoryLimitDesktop(120)}
                  className={cn(
                    "px-3 py-2 text-xs font-semibold transition",
                    historyLimitDesktop === 120 ? "bg-slate-900/70 text-white" : "text-slate-400 hover:text-slate-200"
                  )}
                >
                  120
                </button>
                <button
                  onClick={() => setHistoryLimitDesktop(200)}
                  className={cn(
                    "px-3 py-2 text-xs font-semibold transition",
                    historyLimitDesktop === 200 ? "bg-slate-900/70 text-white" : "text-slate-400 hover:text-slate-200"
                  )}
                >
                  200
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/35 backdrop-blur-sm shadow-xl">
            {/* Desktop Table */}
            <div className="hidden md:block max-h-[560px] overflow-auto scrollbar-app">

              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-slate-950/80 backdrop-blur text-xs uppercase font-semibold text-slate-500 shadow-sm">
                  <tr>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Hora</th>
                    <th className="px-6 py-4">Ping</th>
                    <th className="px-6 py-4">WAN</th>
                    <th className="px-6 py-4">Info</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800/60">
                  {(data?.history ?? []).slice(0, historyLimitDesktop).map((h, i) => {
                    const ms = h.probe?.ms ?? null;
                    const pConf = getPingConfig(ms);
                    const sConf = getStateConfig(h.state);
                    const w = h.wan ?? h.wanGroups?.[0] ?? null;
                    const wName = w?.name ?? w?.id ?? "—";
                    const wDetail = w?.port_info
                      ? `${w.port_info.port_ifname} • Porta ${w.port_info.port_idx}`
                      : w?.network_id
                        ? `network_id ${w.network_id}`
                        : "";

                    return (
                      <tr key={i} className="group hover:bg-slate-800/25 transition-colors">
                        <td className="px-6 py-3 whitespace-nowrap">
                          <span
                            className={cn(
                              "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset",
                              sConf.bg,
                              sConf.border,
                              sConf.color
                            )}
                          >
                            <span className={cn("h-1.5 w-1.5 rounded-full", sConf.dot)} />
                            {h.state}
                          </span>
                        </td>

                        <td className="px-6 py-3 font-mono text-slate-400 whitespace-nowrap text-xs">
                          {fmtTime(h.ts)}
                        </td>

                        <td className="px-6 py-3 whitespace-nowrap">
                          <span className={cn("font-mono font-bold", pConf.color)}>{ms ?? "—"}</span>
                          {ms != null && <span className="ml-1 text-xs text-slate-600">ms</span>}
                        </td>

                        <td className="px-6 py-3">
                        <div className="flex items-center gap-3">
                          <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-950/60 ring-1 ring-white/10">
                            {h.wanUp === true ? (
                              <Wifi className="h-4 w-4 text-emerald-300" />
                            ) : h.wanUp === false ? (
                              <WifiOff className="h-4 w-4 text-rose-300" />
                            ) : (
                              <Network className="h-4 w-4 text-slate-300" />
                            )}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-slate-200">{wName}</div>
                            {!!wDetail && (
                              <div className="truncate text-xs text-slate-500">{wDetail}</div>
                            )}
                          </div>
                        </div>
                      </td>

                        <td className="px-6 py-3 text-slate-400 truncate max-w-[520px] text-xs">
                          {h.note ?? h.reason ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-slate-800/60">
              {(data?.history ?? []).slice(0, historyLimitMobile).map((h, i) => {
                const sConf = getStateConfig(h.state);
                const ms = h.probe?.ms ?? null;
                const pConf = getPingConfig(ms);

                const w = h.wan ?? h.wanGroups?.[0] ?? null;
                const wName = w?.name ?? w?.id ?? "—";
                const wDetail = w?.port_info
                  ? `${w.port_info.port_ifname} • Porta ${w.port_info.port_idx}`
                  : w?.network_id
                    ? `network_id ${w.network_id}`
                    : "";

                return (
                  <div key={i} className="p-4 active:bg-slate-800/25">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn("h-2.5 w-2.5 rounded-full", sConf.dot)} />
                          <span className={cn("text-xs font-extrabold tracking-wide", sConf.color)}>{h.state}</span>
                          <span className="text-slate-700">•</span>
                          <span className="text-xs font-mono text-slate-500">{fmtTime(h.ts)}</span>
                        </div>

                        <div className="mt-2 flex items-end justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase text-slate-500 font-bold">Latência</div>
                            <div className={cn("text-2xl font-mono font-extrabold leading-none", pConf.color)}>
                              {ms ?? "—"}
                              <span className="ml-1 text-xs font-sans font-normal text-slate-600">ms</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {h.wanUp === true && (
                              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300">
                                <Wifi className="h-4 w-4" />
                                {wName} • UP
                              </span>
                            )}
                            {h.wanUp === false && (
                              <span className="inline-flex items-center gap-2 rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-xs font-bold text-rose-300">
                                <WifiOff className="h-4 w-4" />
                                {wName} • DOWN
                              </span>
                            )}
                            {h.wanUp === null && (
                              <span className="inline-flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-800/30 px-3 py-1 text-xs font-bold text-slate-300">
                                <Network className="h-4 w-4" />
                                {wName}

                              </span>
                            )}
                          </div>
                        </div>

                        {!!wDetail && <div className="mt-2 text-xs text-slate-500">{wDetail}</div>}

                        {(h.note || h.reason) && (
                          <div className="mt-3 rounded-2xl border border-slate-800/70 bg-slate-950/35 p-3 text-xs text-slate-300">
                            <div className="line-clamp-3 break-words">{h.note ?? h.reason}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {(data?.history?.length ?? 0) > historyLimitMobile && (
                <div className="p-3">
                  <button
                    onClick={() => setHistoryLimitMobile((v) => Math.min((data?.history?.length ?? 0), v + 20))}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/35 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-950/55"
                  >
                    <ChevronDown className="h-4 w-4 text-slate-400" />
                    Mostrar mais
                  </button>
                </div>
              )}

              {historyLimitMobile > 20 && (
                <div className="px-3 pb-3">
                  <button
                    onClick={() => setHistoryLimitMobile(20)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/20 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-950/35"
                  >
                    <ChevronUp className="h-4 w-4 text-slate-400" />
                    Recolher
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <footer className="mt-10 border-t border-slate-800/60 pt-6 text-center text-xs text-slate-600">
          <p>UniFi Monitor System • WS porta {MONITOR_WS_PORT} • Auto-Reconnect</p>
        </footer>
      </main>
    </div>
  );
}

// --- UI subcomponents ---
function Notice({
  tone,
  title,
  children,
  icon,
}: {
  tone: "danger" | "warn" | "info";
  title: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const conf =
    tone === "danger"
      ? { bg: "bg-rose-500/10", border: "border-rose-500/20", text: "text-rose-200" }
      : tone === "warn"
      ? { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-200" }
      : { bg: "bg-indigo-500/10", border: "border-indigo-500/20", text: "text-indigo-200" };

  return (
    <div className={cn("flex items-start gap-3 rounded-2xl border p-4", conf.bg, conf.border, conf.text)}>
      <div className="mt-0.5 flex-shrink-0">{icon}</div>
      <div className="text-sm">
        <div className="font-extrabold">{title}</div>
        <div className="mt-0.5 text-slate-200/90">{children}</div>
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  const ms = typeof p?.ms === "number" ? p.ms : null;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/95 px-3 py-2 text-xs text-slate-200 shadow-xl">
      <div className="text-slate-400">{p?.fullTime ?? label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-slate-300">Latência</div>
        <div className="font-mono font-extrabold text-white">{ms ?? "—"}ms</div>
      </div>
    </div>
  );
}

function KeyValue({
  label,
  value,
  rightSub,
  mono,
  wrap,
}: {
  label: string;
  value: string;
  rightSub?: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-slate-800/60 bg-slate-950/25 p-3">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="min-w-0 text-right">
        <div className={cn("text-sm text-slate-200", mono && "font-mono", wrap ? "break-words" : "truncate")}>
          {value}
        </div>
        {rightSub && <div className="mt-1 text-[10px] font-mono text-slate-500">{rightSub}</div>}
      </div>
    </div>
  );
}

function RowDot({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn("h-2 w-2 rounded-full ring-2 ring-opacity-20 ring-offset-1 ring-offset-slate-900", color)} />
      <span className="flex-1 text-slate-300">{label}</span>
      <span className="font-mono text-slate-400 text-xs bg-slate-950/30 px-2 py-1 rounded-lg border border-slate-800/60">
        {value}
      </span>
    </div>
  );
}

function StatBox({
  label,
  value,
  icon,
  subtext,
  color,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  subtext?: string | null;
  color?: string;
}) {
  return (
    <div className="group rounded-2xl bg-slate-950/25 p-4 border border-slate-800/60 hover:border-slate-700 hover:bg-slate-950/35 transition-all">
      <div className="mb-2 flex items-center gap-2 text-slate-500 group-hover:text-slate-400 transition-colors">
        {icon}
        <span className="text-[10px] uppercase font-bold tracking-wider">{label}</span>
      </div>

      <div className={cn("text-xl font-extrabold font-mono tracking-tight", color ?? "text-slate-200")}>{value}</div>

      {subtext && <div className="mt-1 text-[11px] text-slate-500 truncate">{subtext}</div>}
    </div>
  );
}

const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn("rounded-3xl border border-slate-800 bg-slate-900/35 backdrop-blur-sm p-5", className)}>
    {children}
  </div>
);

const Badge = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset", className)}>
    {children}
  </span>
);
