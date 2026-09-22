// dsh-resource-bar Node half: read this machine's CPU / memory utilisation
// from the kernel's own interfaces and expose it to the browser half as JSON.
//
// Data sources are the kernel's, never an estimate:
// - /proc/stat     CPU jiffies (aggregate + per core) and their breakdown
// - /proc/meminfo  memory accounting (MemTotal / MemAvailable / Cached / Swap)
// - /proc/loadavg  run-queue load
// - /proc/uptime   uptime
// - /proc/<pid>/stat  per-process CPU jiffies and resident set size
//
// Two rules from the official plugin contracts drive the shape of this file:
//
// 1. Every side effect belongs to the fiber. Both intervals are created inside
//    `ctx.effect` and cleared on dispose, so disabling the plugin leaves no live
//    timer behind (`selftest-timers.mjs` asserts exactly that).
// 2. A monitoring plugin must never take the host down with it. /proc is read
//    defensively: a non-Linux host, a vanished pid or a short read degrades the
//    snapshot to `available:false` / partial fields instead of throwing. Every
//    route checks its method and applies the connection trust fence.
//
// CPU percentages need two samples, so the sampler runs on its own interval and
// the routes only ever serialise the cached snapshot: a poll costs no /proc IO.

import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";

/** Hard dependencies: the HTTP server plus the trust fence for custom routes. */
export const inject = ["webServer", "connection"];

const NS = "dsh-resource-bar";
const BASE = "/dsh-resource-bar";

/** CPU sampling cadence. 1s is the smallest interval that reads well in a pill. */
export const CPU_INTERVAL_MS = 1000;
/** Process-table sampling cadence; only runs while someone is watching. */
export const PROC_INTERVAL_MS = 1500;
/** How long the process sampler keeps running after the last detail request. */
export const PROC_IDLE_STOP_MS = 15000;
/** Upper bound on pids inspected per process scan, so a pid storm cannot stall us. */
export const PROC_SCAN_LIMIT = 2048;
/** Rows returned per process ranking. */
export const PROC_TOP_N = 5;
/** Page size assumption for rss (reported in pages). Linux/amd64 default. */
export const PAGE_BYTES = 4096;

// ---------------------------------------------------------------------------
// pure parsing / folding
// ---------------------------------------------------------------------------

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const clampPct = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null);

/**
 * Per-process CPU share. Unlike the host-wide percentage this is expressed as
 * "percent of ONE core" (how `top` reports it), so it legitimately exceeds 100
 * on a multicore box; it is bounded by the core count instead.
 */
const clampProcPct = (n, cpuCount) => (Number.isFinite(n) ? Math.min(Math.max(1, cpuCount) * 100, Math.max(0, n)) : null);

/**
 * Parse `/proc/stat`. `cpu` is the aggregate line, `cpu0..cpuN` the per-core
 * lines. Guest time is already included in user/nice and is therefore excluded
 * from the total, otherwise a virtualised host reports above 100% busy.
 * @param {string} text - raw /proc/stat contents.
 * @returns {{ aggregate: object | null, cores: object[] }}
 */
export function parseProcStat(text) {
  const norm = (fields) => {
    if (!fields || fields.length < 4) return null;
    const user = fields[0] ?? 0;
    const nice = fields[1] ?? 0;
    const system = fields[2] ?? 0;
    const idle = fields[3] ?? 0;
    const iowait = fields[4] ?? 0;
    const irq = fields[5] ?? 0;
    const softirq = fields[6] ?? 0;
    const steal = fields[7] ?? 0;
    return {
      user,
      nice,
      system,
      idle,
      iowait,
      irq,
      softirq,
      steal,
      total: user + nice + system + idle + iowait + irq + softirq + steal,
      idleAll: idle + iowait,
    };
  };
  let aggregate = null;
  const cores = [];
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    const fields = parts.slice(1).map(toNumber);
    if (label === "cpu") {
      aggregate = norm(fields);
      continue;
    }
    // cpu0, cpu1, ... — anything else (cpu_foo) is not a core.
    if (!/^cpu\d+$/.test(label)) continue;
    const core = norm(fields);
    if (core) cores.push(core);
  }
  return { aggregate, cores };
}

/**
 * Per-core and aggregate percentages between two `/proc/stat` snapshots.
 * Counters are monotone except across a suspend or a counter reset, so a
 * non-positive delta yields `null` ("no reading yet") rather than a bogus 0%.
 * `totalDelta` is handed back for the process ranking, which needs the same
 * denominator the CPU percentage was computed from.
 * @returns {{ busyPct:number|null, breakdown:object|null, cores:Array, totalDelta:number }}
 */
export function cpuPercents(prev, next) {
  if (!prev || !next) return { busyPct: null, breakdown: null, cores: [], totalDelta: 0 };
  const pctOf = (a, b) => {
    if (!a || !b) return null;
    const dt = b.total - a.total;
    const di = b.idleAll - a.idleAll;
    if (dt <= 0 || di < 0) return null;
    return clampPct(((dt - di) / dt) * 100);
  };
  const totalDelta = prev.aggregate && next.aggregate ? next.aggregate.total - prev.aggregate.total : 0;
  const breakdown = (() => {
    if (totalDelta <= 0) return null;
    const a = prev.aggregate;
    const b = next.aggregate;
    const share = (key) => clampPct(((b[key] - a[key]) / totalDelta) * 100);
    return {
      user: share("user"),
      nice: share("nice"),
      system: share("system"),
      iowait: share("iowait"),
      irq: share("irq") + share("softirq"),
      steal: share("steal"),
      idle: share("idle"),
    };
  })();
  const cores = [];
  const n = Math.min(prev.cores.length, next.cores.length);
  for (let i = 0; i < n; i++) cores.push({ id: i, pct: pctOf(prev.cores[i], next.cores[i]) });
  return { busyPct: pctOf(prev.aggregate, next.aggregate), breakdown, cores, totalDelta: Math.max(0, totalDelta) };
}

/**
 * Parse `/proc/meminfo` into bytes.
  @param {string} text
 * @returns {Record<string, number>}
 */
export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^([A-Za-z_()0-9]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    // All memory counters /proc/meminfo exposes are kB-valued; the parser only
    // accepts that shape, so the conversion is unconditional.
    out[m[1]] = value * 1024;
  }
  return out;
}

/**
 * Memory summary derived from parsed /proc/meminfo.
 *
 * `used` follows the kernel's own advice (`MemTotal - MemAvailable`): MemFree
 * alone counts reclaimable page cache as used and reads alarmingly high on any
 * machine that has been up for a while.
 */
export function memSummary(info, extra = {}) {
  if (!info || !Number.isFinite(info.MemTotal) || info.MemTotal <= 0) return null;
  const total = info.MemTotal;
  const available = Number.isFinite(info.MemAvailable) ? info.MemAvailable : info.MemFree ?? 0;
  const used = Math.max(0, total - available);
  const cached = (info.Cached ?? 0) + (info.SReclaimable ?? 0) - (info.Shmem ?? 0);
  const swapTotal = info.SwapTotal ?? 0;
  const swapFree = info.SwapFree ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);
  return {
    totalBytes: total,
    usedBytes: used,
    usedPct: clampPct((used / total) * 100),
    availableBytes: available,
    freeBytes: info.MemFree ?? 0,
    cachedBytes: Math.max(0, cached),
    buffersBytes: info.Buffers ?? 0,
    sharedBytes: info.Shmem ?? 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    swapUsedPct: swapTotal > 0 ? clampPct((swapUsed / swapTotal) * 100) : null,
    ...extra,
  };
}

/** Parse `/proc/loadavg` → `{ one, five, fifteen, runnable, total }`. */
export function parseLoadavg(text) {
  const trimmed = String(text).trim();
  // An unreadable file must read as "no data", not as a load of 0.00: Number("")
  // is 0, so the empty string would otherwise masquerade as an idle machine.
  const parts = trimmed === "" ? [] : trimmed.split(/\s+/);
  const num = (i) => {
    const raw = parts[i];
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const procs = /^(\d+)\/(\d+)$/.exec(parts[3] ?? "");
  return {
    one: num(0),
    five: num(1),
    fifteen: num(2),
    runnable: procs ? Number(procs[1]) : null,
    total: procs ? Number(procs[2]) : null,
  };
}

/**
 * Parse one `/proc/<pid>/stat`. The comm field is wrapped in parentheses and may
 * itself contain spaces and parentheses, so the parse resumes from the LAST
 * `)` — the naive `split(" ")` is what makes such readers misreport utime/rss.
 * @returns {{ pid:number, comm:string, state:string, utime:number, stime:number, rssBytes:number } | null}
 */
export function parsePidStat(text) {
  const s = String(text);
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(s.slice(0, open).trim());
  if (!Number.isFinite(pid)) return null;
  const comm = s.slice(open + 1, close);
  const rest = s.slice(close + 2).trim().split(/\s+/);
  // rest[0] is state; utime is overall field 14 → rest index 11, stime → 12,
  // rss (in pages) → 21.
  const num = (i) => {
    const n = Number(rest[i]);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    pid,
    comm,
    state: rest[0] ?? "?",
    utime: num(11),
    stime: num(12),
    rssBytes: Math.max(0, num(21)) * PAGE_BYTES,
  };
}

/** Total CPU jiffies consumed by a parsed pid stat. */
export const procJiffies = (p) => (p ? p.utime + p.stime : 0);

/**
 * Rank processes by CPU (delta jiffies across the two samples, expressed as
 * percent of ONE core, the way `top` reports it) and by resident memory.
 * @returns {{ byCpu: object[], byMem: object[] }}
 */
export function rankProcesses(prevMap, nextMap, opts = {}) {
  const topN = opts.topN ?? PROC_TOP_N;
  const totalDelta = opts.totalDelta ?? 0;
  const cpuCount = opts.cpuCount ?? 0;
  const memTotal = opts.memTotal ?? 0;
  const rows = [];
  for (const [pid, next] of nextMap) {
    if (!next) continue;
    const prev = prevMap instanceof Map ? prevMap.get(pid) : undefined;
    const dj = procJiffies(next) - procJiffies(prev);
    // A first sighting has no baseline: report 0 rather than its lifetime
    // average, which would rank long-lived daemons above real current load.
    const cpuPct = prev && totalDelta > 0 && cpuCount > 0 ? clampProcPct((dj / totalDelta) * cpuCount * 100, cpuCount) : 0;
    const memPct = memTotal > 0 ? clampPct((next.rssBytes / memTotal) * 100) : null;
    rows.push({ pid: next.pid, comm: next.comm, cpuPct, rssBytes: next.rssBytes, memPct });
  }
  const byCpu = rows.filter((r) => r.cpuPct > 0).sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes || a.pid - b.pid);
  const byMem = rows.filter((r) => r.rssBytes > 0).sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);
  return { byCpu: byCpu.slice(0, topN), byMem: byMem.slice(0, topN) };
}

/**
 * True when a snapshot carries no readable CPU reading. This is deliberately
 * distinct from "0%": an idle machine must render 0.0%, an unreadable host must
 * render the unknown marker. Conflating the two is the classic monitoring bug.
 */
export const isBlank = (snap) =>
  !snap || !snap.cpu || snap.cpu.busyPct === null || snap.cpu.busyPct === undefined;

// ---------------------------------------------------------------------------
// /proc readers (thin; keep the fallible IO in one place)
// ---------------------------------------------------------------------------

/** Read a text file, returning null instead of throwing. */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// The proc root is injectable so the failure paths are testable for real
// (point it at a directory that does not exist) instead of being asserted only
// by inspection. Production always uses the default.
export const PROC_ROOT = "/proc";

/** Take one raw CPU sample from <root>/stat, or null when unavailable. */
export function readCpuSample(root = PROC_ROOT) {
  const text = readText(root + "/stat");
  return text === null ? null : parseProcStat(text);
}

/** Take one memory sample from <root>/meminfo, or null when unavailable. */
export function readMemSample(root = PROC_ROOT) {
  const text = readText(root + "/meminfo");
  return text === null ? null : parseMeminfo(text);
}

/** Read the process table (pid → parsed stat), bounded by PROC_SCAN_LIMIT. */
export function readProcTable(root = PROC_ROOT) {
  const map = new Map();
  let names = null;
  try {
    names = readdirSync(root);
  } catch {
    return map;
  }
  let seen = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    if (seen++ >= PROC_SCAN_LIMIT) break;
    const parsed = parsePidStat(readText(root + "/" + name + "/stat") ?? "");
    if (parsed) map.set(parsed.pid, parsed);
  }
  return map;
}

/** CPU model / core count, read once at apply time. */
export function hostInfo(root = PROC_ROOT) {
  let model = null;
  const text = readText(root + "/cpuinfo");
  if (text !== null) {
    const m = /^model name\s*:\s*(.+)$/m.exec(text);
    if (m) model = m[1].trim();
  }
  let cores = 0;
  try {
    cores = availableParallelism();
  } catch {
    cores = 0;
  }
  return { model, cores };
}

/** Uptime in seconds, or null. */
export function readUptime(root = PROC_ROOT) {
  const text = readText(root + "/uptime");
  if (text === null) return null;
  const n = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

/** The snapshot served before the first successful sample. */
export function blankSnapshot(info = { model: null, cores: 0 }) {
  return {
    ok: true,
    available: false,
    ts: Date.now(),
    sampledFrom: "procfs",
    host: { model: info.model ?? null, cores: info.cores ?? 0, uptimeSec: null, startedAt: Date.now(), platform: process.platform },
    cpu: {
      busyPct: null,
      breakdown: null,
      cores: [],
      coreCount: info.cores ?? 0,
      model: info.model ?? null,
      samples: 0,
      totalJiffiesDelta: 0,
    },
    mem: null,
    load: parseLoadavg(""),
  };
}

/** Assemble the public snapshot from one round of samples. */
export function buildSnapshot({ info, startedAt, percents, memInfo, samples, root = PROC_ROOT }) {
  const nodeRss = (() => {
    try {
      return process.memoryUsage().rss;
    } catch {
      return 0;
    }
  })();
  return {
    ok: true,
    available: percents.busyPct !== null,
    ts: Date.now(),
    sampledFrom: "procfs",
    host: {
      model: info.model,
      cores: info.cores,
      uptimeSec: readUptime(root),
      startedAt,
      platform: process.platform,
    },
    cpu: {
      busyPct: percents.busyPct,
      breakdown: percents.breakdown,
      cores: percents.cores,
      coreCount: info.cores,
      model: info.model,
      samples,
      totalJiffiesDelta: percents.totalDelta,
    },
    mem: memSummary(memInfo, { nodeRssBytes: nodeRss }),
    load: parseLoadavg(readText(root + "/loadavg") ?? ""),
  };
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Mount the sampler and its routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const info = hostInfo();
  const startedAt = Date.now();

  // --- sampler state (fiber-owned; mutated only by the intervals below) ---
  let prevCpu = null;
  let latest = blankSnapshot(info);
  let cpuSamples = 0;
  let procPrev = null;
  let procLatest = { ready: false, sampledAt: 0, byCpu: [], byMem: [] };
  let procTimer = null;
  let lastDetailAt = 0;

  const stopProcSampler = () => {
    if (procTimer !== null) {
      clearInterval(procTimer);
      procTimer = null;
    }
    procPrev = null;
  };

  const tickCpu = () => {
    try {
      const next = readCpuSample();
      if (next === null) {
        latest = { ...latest, available: false, ts: Date.now(), cpu: { ...latest.cpu, busyPct: null, cores: [] } };
        return;
      }
      const percents = cpuPercents(prevCpu, next);
      prevCpu = next;
      cpuSamples += 1;
      latest = buildSnapshot({ info, startedAt, percents, memInfo: readMemSample(), samples: cpuSamples });
    } catch (error) {
      // A monitoring plugin must not take the host down with it.
      ctx.logger?.warn?.(`${NS}: cpu sample failed: ${String(error)}`);
    }
  };

  const tickProcs = () => {
    try {
      const next = readProcTable();
      if (procPrev !== null) {
        procLatest = {
          ready: true,
          sampledAt: Date.now(),
          ...rankProcesses(procPrev, next, {
            totalDelta: latest.cpu?.totalJiffiesDelta ?? 0,
            cpuCount: info.cores,
            memTotal: latest.mem?.totalBytes ?? 0,
          }),
        };
      }
      procPrev = next;
      if (lastDetailAt > 0 && Date.now() - lastDetailAt > PROC_IDLE_STOP_MS) stopProcSampler();
    } catch (error) {
      ctx.logger?.warn?.(`${NS}: process sample failed: ${String(error)}`);
    }
  };

  /** Lazily start the process sampler; it stops itself once nobody is watching. */
  const ensureProcSampler = () => {
    lastDetailAt = Date.now();
    if (procTimer !== null) return;
    procPrev = null;
    procTimer = setInterval(tickProcs, PROC_INTERVAL_MS);
    procTimer.unref?.();
    ctx.effect(
      () => () => {
        stopProcSampler();
      },
      `${NS}: process sampler`,
    );
    tickProcs();
  };

  ctx.effect(
    () => {
      tickCpu();
      const timer = setInterval(tickCpu, CPU_INTERVAL_MS);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        stopProcSampler();
      };
    },
    `${NS}: cpu sampler`,
  );

  // --- routes -------------------------------------------------------------
  const rejected = (req, res) => {
    const connection = ctx.get("connection");
    if (connection === undefined || typeof connection.requestRejection !== "function") {
      // Fail closed: an unverifiable request is an untrusted one.
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "trust_fence_unavailable" }));
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.writeHead(rejection);
    res.end();
    return true;
  };

  const sendJson = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const methodNotAllowed = (res, allowed) => {
    res.writeHead(405, { allow: allowed, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  };

  // `kind: "exact"` is explicit: anything else lands in the longest-prefix
  // table, where `/summary/anything` would also resolve to this handler.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: BASE + "/summary",
        handler(req, res) {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            methodNotAllowed(res, "GET");
            return;
          }
          sendJson(res, 200, latest);
        },
      }),
    `${NS}: summary route`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: BASE + "/detail",
        handler(req, res) {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            methodNotAllowed(res, "GET");
            return;
          }
          ensureProcSampler();
          sendJson(res, 200, { ...latest, procs: procLatest });
        },
      }),
    `${NS}: detail route`,
  );
}
