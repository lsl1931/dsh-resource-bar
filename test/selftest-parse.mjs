// Pure-parser selftests. Every fixture here is real /proc content or a
// deliberately hostile variant of it; the point is that the parsing rules are
// asserted, not re-implemented.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  PAGE_BYTES,
  cpuPercents,
  memSummary,
  parseLoadavg,
  parseMeminfo,
  parsePidStat,
  parseProcStat,
  procJiffies,
  rankProcesses,
} from "../lib/index.js";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};

// --- /proc/stat -------------------------------------------------------------

check("parseProcStat reads the real /proc/stat", () => {
  // Read ONCE: /proc/stat is a live file and its counters advance between
  // reads, so a second read would compare two different samples.
  const raw = readFileSync("/proc/stat", "utf8");
  const parsed = parseProcStat(raw);
  assert.ok(parsed.aggregate, "aggregate line present");
  assert.ok(parsed.cores.length >= 1, "at least one core");
  assert.ok(parsed.aggregate.total > 0, "total jiffies positive");
  // Aggregate total must be >= the sum of the per-core totals (it also carries
  // counters for cores offline at boot).
  const coreSum = parsed.cores.reduce((n, c) => n + c.total, 0);
  assert.ok(parsed.aggregate.total >= coreSum, "aggregate covers cores");
  // Guest time is NOT part of total: the real line has more fields than the 8
  // we fold, and total must stay the sum of exactly those 8.
  const f = raw.split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  assert.strictEqual(parsed.aggregate.total, f.slice(0, 8).reduce((a, b) => a + b, 0));
});

check("parseProcStat ignores non-core cpu lines", () => {
  const parsed = parseProcStat("cpu  1 2 3 4 5 6 7 8\ncpu0 1 1 1 1 0 0 0 0\ncpu_total 9 9 9 9\ncpu_foo 1 2 3 4\ncpu1 2 2 2 2 0 0 0 0\nintr 123\n");
  assert.strictEqual(parsed.cores.length, 2, "only cpu0/cpu1 are cores");
  assert.strictEqual(parsed.aggregate.total, 36);
});

check("parseProcStat tolerates a short/empty file", () => {
  assert.strictEqual(parseProcStat("").aggregate, null);
  assert.strictEqual(parseProcStat("cpu 1 2 3").aggregate, null, "fewer than 4 fields is not a sample");
  assert.deepStrictEqual(parseProcStat("").cores, []);
});

check("cpuPercents computes a known busy ratio", () => {
  // 100 jiffies elapsed, 25 of them idle → 75% busy.
  const a = parseProcStat("cpu 0 0 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0\n");
  const b = parseProcStat("cpu 40 0 35 25 0 0 0 0\ncpu0 40 0 35 25 0 0 0 0\n");
  const r = cpuPercents(a, b);
  assert.strictEqual(r.busyPct, 75);
  assert.strictEqual(r.totalDelta, 100);
  assert.strictEqual(r.cores.length, 1);
  assert.strictEqual(r.cores[0].pct, 75);
  assert.strictEqual(r.breakdown.user, 40, "user share of the window");
  assert.strictEqual(r.breakdown.system, 35);
  assert.strictEqual(r.breakdown.idle, 25);
});

check("cpuPercents counts iowait as idle, matching `top`", () => {
  const a = parseProcStat("cpu 0 0 0 0 0 0 0 0\n");
  const b = parseProcStat("cpu 0 0 0 50 50 0 0 0\n");
  assert.strictEqual(cpuPercents(a, b).busyPct, 0, "100% iowait is 0% busy");
});

check("cpuPercents reports null on a counter reset instead of a bogus 0%", () => {
  const a = parseProcStat("cpu 500 0 500 500 0 0 0 0\n");
  const b = parseProcStat("cpu 1 0 1 1 0 0 0 0\n");
  const r = cpuPercents(a, b);
  assert.strictEqual(r.busyPct, null);
  assert.strictEqual(r.totalDelta, 0);
  assert.strictEqual(r.breakdown, null);
});

check("cpuPercents reports null before two samples exist", () => {
  const one = parseProcStat("cpu 1 2 3 4\n");
  assert.strictEqual(cpuPercents(null, one).busyPct, null);
  assert.strictEqual(cpuPercents(one, null).busyPct, null);
  assert.deepStrictEqual(cpuPercents(null, one).cores, []);
});

check("cpuPercents clamps every share into 0..100", () => {
  const a = parseProcStat("cpu 0 0 0 0 0 0 0 0\n");
  // Hostile: idle goes backwards while total advances.
  const b = parseProcStat("cpu 10 0 10 0 0 0 0 0\n");
  const r = cpuPercents(a, b);
  assert.ok(r.busyPct === null || (r.busyPct >= 0 && r.busyPct <= 100));
});

check("cpuPercents tolerates differing core counts between samples", () => {
  const a = parseProcStat("cpu 0 0 0 0\ncpu0 0 0 0 0\ncpu1 0 0 0 0\n");
  const b = parseProcStat("cpu 4 0 0 4\ncpu0 4 0 0 4\n");
  const r = cpuPercents(a, b);
  assert.strictEqual(r.cores.length, 1, "one core in common");
  assert.strictEqual(r.busyPct, 50);
});

// --- /proc/meminfo ----------------------------------------------------------

check("parseMeminfo reads the real /proc/meminfo into bytes", () => {
  // Single read: MemFree/MemAvailable move between reads on a live machine.
  const rawText = readFileSync("/proc/meminfo", "utf8");
  const info = parseMeminfo(rawText);
  assert.ok(info.MemTotal > 0);
  // Cross-check against what the kernel says in kB, converting ourselves.
  const rawLine = /^MemTotal:\s+(\d+) kB$/m.exec(rawText);
  assert.strictEqual(info.MemTotal, Number(rawLine[1]) * 1024);
});

check("memSummary uses MemTotal - MemAvailable for `used`", () => {
  const mem = memSummary(parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nBuffers: 50 kB\nCached: 200 kB\nSwapTotal: 500 kB\nSwapFree: 300 kB\n"));
  assert.strictEqual(mem.totalBytes, 1000 * 1024);
  assert.strictEqual(mem.usedBytes, 600 * 1024, "1 - available, not 1 - free");
  assert.strictEqual(mem.usedPct, 60);
  assert.strictEqual(mem.availableBytes, 400 * 1024);
  assert.strictEqual(mem.freeBytes, 100 * 1024);
  assert.strictEqual(mem.swapUsedBytes, 200 * 1024);
  assert.strictEqual(mem.swapUsedPct, 40);
});

check("memSummary falls back to MemFree when MemAvailable is absent", () => {
  const mem = memSummary(parseMeminfo("MemTotal: 1000 kB\nMemFree: 250 kB\n"));
  assert.strictEqual(mem.availableBytes, 250 * 1024);
  assert.strictEqual(mem.usedBytes, 750 * 1024);
});

check("memSummary returns null without MemTotal and never reports a swap percent without swap", () => {
  assert.strictEqual(memSummary(parseMeminfo("MemFree: 10 kB\n")), null);
  assert.strictEqual(memSummary(null), null);
  const mem = memSummary(parseMeminfo("MemTotal: 100 kB\nMemAvailable: 50 kB\n"));
  assert.strictEqual(mem.swapTotalBytes, 0);
  assert.strictEqual(mem.swapUsedPct, null, "no swap → no percent, not 0%");
});

check("memSummary subtracts Shmem from the reclaimable cache figure", () => {
  const mem = memSummary(parseMeminfo("MemTotal: 100 kB\nMemAvailable: 50 kB\nCached: 40 kB\nSReclaimable: 10 kB\nShmem: 30 kB\n"));
  assert.strictEqual(mem.cachedBytes, 20 * 1024);
  assert.strictEqual(mem.sharedBytes, 30 * 1024);
});

// --- /proc/loadavg ----------------------------------------------------------

check("parseLoadavg reads the real file and the runnable/total field", () => {
  const load = parseLoadavg(readFileSync("/proc/loadavg", "utf8"));
  assert.ok(Number.isFinite(load.one));
  assert.ok(load.one >= 0);
  assert.ok(Number.isFinite(load.runnable) && load.runnable >= 0);
  assert.ok(load.total >= load.runnable);
});

check("parseLoadavg on empty input yields nulls, not NaN", () => {
  const load = parseLoadavg("");
  assert.strictEqual(load.one, null);
  assert.strictEqual(load.five, null);
  assert.strictEqual(load.fifteen, null);
  assert.strictEqual(load.runnable, null);
  assert.strictEqual(load.total, null);
});

// --- /proc/<pid>/stat -------------------------------------------------------

check("parsePidStat resumes after the LAST ')' so a comm with spaces parses", () => {
  // Real-world comm values look like "(Web Content)" or "(my (odd) app)".
  const line = "1234 (my (odd) app) S 1 1234 1234 0 -1 4194304 100 0 0 0 7 3 0 0 20 0 3 0 500 12345 6789 18446744073709551615";
  const p = parsePidStat(line);
  assert.strictEqual(p.pid, 1234);
  assert.strictEqual(p.comm, "my (odd) app");
  assert.strictEqual(p.state, "S");
  assert.strictEqual(p.utime, 7, "utime is overall field 14");
  assert.strictEqual(p.stime, 3, "stime is overall field 15");
  assert.strictEqual(p.rssBytes, 6789 * PAGE_BYTES, "rss is overall field 24, in pages");
  assert.strictEqual(procJiffies(p), 10);
});

check("parsePidStat tolerates a truncated or malformed line", () => {
  assert.strictEqual(parsePidStat(""), null);
  assert.strictEqual(parsePidStat("no parens here"), null);
  assert.strictEqual(parsePidStat("abc123 (x) S 1"), null, "non-numeric pid");
  const p = parsePidStat("42 (x) R");
  assert.strictEqual(p.pid, 42);
  assert.strictEqual(p.utime, 0, "missing counters degrade to 0");
  assert.strictEqual(p.rssBytes, 0);
});

check("parsePidStat never yields a negative rss on a hostile value", () => {
  const line = "7 (x) S " + Array.from({ length: 22 }, (_, i) => i).join(" ") + " -99999";
  const p = parsePidStat(line);
  assert.ok(p.rssBytes >= 0);
});

// --- ranking ----------------------------------------------------------------

const mk = (pid, comm, utime, stime, rss) => ({ pid, comm, state: "S", utime, stime, rssBytes: rss });
const mapOf = (...rows) => new Map(rows.map((r) => [r.pid, r]));

check("rankProcesses ranks by CPU delta as percent of one core", () => {
  const prev = mapOf(mk(1, "idle", 0, 0, 1000), mk(2, "busy", 0, 0, 1000));
  const next = mapOf(mk(1, "idle", 0, 0, 1000), mk(2, "busy", 150, 50, 1000));
  // 200 jiffies of work out of a 400-jiffy window on 4 cores → 200% of one core.
  const { byCpu } = rankProcesses(prev, next, { totalDelta: 400, cpuCount: 4, memTotal: 1e6, topN: 5 });
  assert.strictEqual(byCpu.length, 1, "the idle process is not listed");
  assert.strictEqual(byCpu[0].comm, "busy");
  assert.strictEqual(byCpu[0].cpuPct, 200);
});

check("rankProcesses gives a first sighting 0% instead of its lifetime average", () => {
  const prev = mapOf();
  const next = mapOf(mk(9, "veteran", 100000, 100000, 500));
  const { byCpu } = rankProcesses(prev, next, { totalDelta: 100, cpuCount: 4, memTotal: 1e6 });
  assert.deepStrictEqual(byCpu, [], "no baseline → no CPU row");
});

check("rankProcesses ranks by memory independently and caps at topN", () => {
  const prev = mapOf();
  const next = mapOf(mk(1, "a", 0, 0, 100), mk(2, "b", 0, 0, 900), mk(3, "c", 0, 0, 500));
  const { byMem } = rankProcesses(prev, next, { memTotal: 1000, topN: 2 });
  assert.deepStrictEqual(byMem.map((r) => r.comm), ["b", "c"]);
  assert.strictEqual(byMem[0].memPct, 90);
  assert.strictEqual(byMem[1].memPct, 50);
});

check("rankProcesses is deterministic for equal keys", () => {
  const prev = mapOf();
  const next = mapOf(mk(7, "x", 0, 0, 10), mk(3, "y", 0, 0, 10));
  const { byMem } = rankProcesses(prev, next, { memTotal: 100, topN: 5 });
  assert.deepStrictEqual(byMem.map((r) => r.pid), [3, 7], "pid breaks the tie");
});

check("rankProcesses clamps a hostile share into 0..100", () => {
  const prev = mapOf(mk(1, "x", 0, 0, 1));
  const next = mapOf(mk(1, "x", 1e9, 1e9, 1));
  const { byCpu } = rankProcesses(prev, next, { totalDelta: 1, cpuCount: 1, memTotal: 1 });
  assert.strictEqual(byCpu[0].cpuPct, 100);
});

check("rankProcesses allows a per-process share above 100% on a multicore host", () => {
  // `top` semantics: one fully-busy thread on a 4-core box is 100%, and a
  // process saturating all four is 400%. Clamping at 100 would hide that.
  const prev = mapOf(mk(1, "wide", 0, 0, 1));
  const next = mapOf(mk(1, "wide", 400, 0, 1));
  const { byCpu } = rankProcesses(prev, next, { totalDelta: 400, cpuCount: 4, memTotal: 1 });
  assert.strictEqual(byCpu[0].cpuPct, 400);
  // ...but it still cannot exceed the core count.
  const next2 = mapOf(mk(1, "wide", 4000, 0, 1));
  const r2 = rankProcesses(prev, next2, { totalDelta: 400, cpuCount: 4, memTotal: 1 });
  assert.strictEqual(r2.byCpu[0].cpuPct, 400, "bounded by coreCount * 100");
});

check("rankProcesses tolerates a non-Map previous sample", () => {
  const next = mapOf(mk(1, "x", 5, 5, 10));
  const { byCpu } = rankProcesses(undefined, next, { totalDelta: 10, cpuCount: 1, memTotal: 100 });
  assert.deepStrictEqual(byCpu, []);
});

console.log("\nselftest-parse: " + passed + " checks passed");
