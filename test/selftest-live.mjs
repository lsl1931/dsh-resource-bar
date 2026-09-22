// Live-sampling selftest: drives the real apply() against the REAL /proc on this
// machine, and asserts the values are physically plausible. This is the suite
// that would catch a silently-wrong reading (a percentage out of range, a
// negative memory figure, a process row with a nonsense rss) which unit fixtures
// cannot, because the fixtures are ours.
import assert from "node:assert";
import { apply } from "../lib/index.js";
import { fakeExchange, makeContext } from "./harness.mjs";

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log("  ok  " + name);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mount with a permissive trust fence and return the route table. */
function mount() {
  const ctx = makeContext({ provide: { connection: { requestRejection: () => undefined } } });
  apply(ctx);
  const routes = new Map(ctx._routes.map((r) => [r.path, r]));
  return { ctx, routes };
}

function get(routes, path) {
  const route = routes.get(path);
  assert.ok(route, path + " registered");
  const { req, res } = fakeExchange({ url: path });
  route.handler(req, res);
  assert.strictEqual(res.statusCode, 200, path + " answered 200");
  return res.json();
}

await check("the sampler produces a real CPU reading within two intervals", async () => {
  const { ctx, routes } = mount();
  const first = get(routes, "/dsh-resource-bar/summary");
  // The very first sample has no predecessor: it must say so rather than
  // pretend the machine is idle.
  assert.strictEqual(first.cpu.samples, 1);
  assert.strictEqual(first.cpu.busyPct, null, "one sample is not a percentage");

  await sleep(1400);
  const second = get(routes, "/dsh-resource-bar/summary");
  assert.ok(second.cpu.samples >= 2, "the interval fired");
  assert.ok(Number.isFinite(second.cpu.busyPct), "a real percentage now exists");
  assert.ok(second.cpu.busyPct >= 0 && second.cpu.busyPct <= 100, "busy% within 0..100, got " + second.cpu.busyPct);
  assert.strictEqual(second.available, true);

  // Per-core readings must exist and respect the same range.
  assert.ok(second.cpu.cores.length >= 1, "per-core readings present");
  for (const core of second.cpu.cores) {
    assert.ok(Number.isFinite(core.pct), "core " + core.id + " has a percentage");
    assert.ok(core.pct >= 0 && core.pct <= 100, "core " + core.id + " within range");
  }
  // And the mean of the cores should be in the same neighbourhood as the
  // aggregate (they are computed from the same window).
  const mean = second.cpu.cores.reduce((n, c) => n + c.pct, 0) / second.cpu.cores.length;
  assert.ok(Math.abs(mean - second.cpu.busyPct) < 25, "per-core mean tracks the aggregate (" + mean.toFixed(1) + " vs " + second.cpu.busyPct.toFixed(1) + ")");
  ctx._dispose();
});

await check("the time-share breakdown sums to ~100%", async () => {
  const { ctx, routes } = mount();
  await sleep(1400);
  const snap = get(routes, "/dsh-resource-bar/summary");
  assert.ok(snap.cpu.breakdown, "breakdown present after two samples");
  const b = snap.cpu.breakdown;
  const sum = b.user + b.nice + b.system + b.iowait + b.irq + b.steal + b.idle;
  assert.ok(Math.abs(sum - 100) < 0.5, "shares sum to 100%, got " + sum);
  for (const [key, value] of Object.entries(b)) {
    assert.ok(value >= 0 && value <= 100, key + " within range, got " + value);
  }
  ctx._dispose();
});

await check("memory figures agree with the kernel and are internally consistent", async () => {
  const { ctx, routes } = mount();
  await sleep(200);
  const snap = get(routes, "/dsh-resource-bar/summary");
  const mem = snap.mem;
  assert.ok(mem, "memory reading present");
  assert.ok(mem.totalBytes > 0, "total memory detected");

  // Cross-check the total against the kernel's own figure, read independently.
  const { readFileSync } = await import("node:fs");
  const kb = Number(/^MemTotal:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"))[1]);
  assert.strictEqual(mem.totalBytes, kb * 1024, "MemTotal matches /proc/meminfo");

  assert.ok(mem.usedBytes > 0 && mem.usedBytes <= mem.totalBytes, "used within 0..total");
  assert.ok(mem.usedPct >= 0 && mem.usedPct <= 100, "used% within 0..100");
  assert.ok(mem.availableBytes >= 0 && mem.availableBytes <= mem.totalBytes);
  assert.ok(mem.freeBytes <= mem.availableBytes, "free <= available (by definition)");
  assert.ok(mem.nodeRssBytes > 0, "this process reports a non-zero RSS");
  if (mem.swapTotalBytes > 0) {
    assert.ok(mem.swapUsedBytes >= 0 && mem.swapUsedBytes <= mem.swapTotalBytes, "swap used within 0..total");
    assert.ok(mem.swapUsedPct >= 0 && mem.swapUsedPct <= 100);
  }
  ctx._dispose();
});

await check("host info and load come from the real kernel interfaces", async () => {
  const { ctx, routes } = mount();
  // Per-core rows are deltas, so they exist only after the second sample;
  // wait past one interval rather than asserting on a single-sample snapshot.
  await sleep(1400);
  const snap = get(routes, "/dsh-resource-bar/summary");
  assert.ok(snap.host.cores >= 1, "core count detected");
  assert.strictEqual(snap.host.cores, snap.cpu.coreCount, "core count is consistent across the payload");
  assert.ok(Number.isFinite(snap.host.uptimeSec) && snap.host.uptimeSec > 0, "uptime positive");
  assert.ok(Array.isArray(snap.cpu.cores));
  assert.strictEqual(snap.cpu.cores.length, snap.host.cores, "one per-core row per core");
  assert.ok(Number.isFinite(snap.load.one) && snap.load.one >= 0, "load average read");
  assert.ok(snap.load.total >= snap.load.runnable, "runnable <= total processes");
  assert.strictEqual(snap.sampledFrom, "procfs");
  ctx._dispose();
});

await check("a single-sample snapshot exposes no per-core rows but stays valid", async () => {
  // The first paint can happen before the second sample; that state must be a
  // well-formed payload the UI can render as "waiting", not a crash or a lie.
  const { ctx, routes } = mount();
  const snap = get(routes, "/dsh-resource-bar/summary");
  assert.strictEqual(snap.cpu.samples, 1);
  assert.deepStrictEqual(snap.cpu.cores, [], "no delta yet");
  assert.strictEqual(snap.cpu.busyPct, null, "no percentage yet");
  assert.strictEqual(snap.cpu.coreCount, snap.host.cores, "core count still known from the OS");
  assert.doesNotThrow(() => JSON.stringify(snap));
  ctx._dispose();
});

await check("the detail route ranks real processes plausibly", async () => {
  const { ctx, routes } = mount();
  // The process sampler needs two rounds before it has deltas.
  get(routes, "/dsh-resource-bar/detail");
  await sleep(2000);
  const snap = get(routes, "/dsh-resource-bar/detail");
  const procs = snap.procs;
  assert.strictEqual(procs.ready, true, "process sampler produced a ranking");
  assert.ok(procs.byCpu.length > 0, "at least one process was busy in the window");
  assert.ok(procs.byMem.length > 0, "at least one process holds memory");

  const onThisHost = await import("node:fs").then((fs) => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).length);
  assert.ok(procs.byCpu.length <= 5, "topN respected for CPU");
  assert.ok(procs.byMem.length <= 5, "topN respected for memory");

  for (const row of procs.byCpu) {
    assert.ok(Number.isFinite(row.pid) && row.pid > 0, "real pid");
    assert.ok(typeof row.comm === "string" && row.comm.length > 0, "process name present");
    assert.ok(row.cpuPct >= 0, "cpu% non-negative");
    // Sanity: a single process cannot exceed the core count (top semantics).
    assert.ok(row.cpuPct <= snap.host.cores * 100 + 0.001, "cpu% bounded by coreCount*100, got " + row.cpuPct);
    assert.ok(row.rssBytes >= 0, "rss non-negative");
  }
  // Memory ranking must be monotonically non-increasing.
  for (let i = 1; i < procs.byMem.length; i++) {
    assert.ok(procs.byMem[i - 1].rssBytes >= procs.byMem[i].rssBytes, "memory ranking is sorted");
  }
  // Every ranked pid should exist right now (allowing for churn).
  let found = 0;
  const { existsSync } = await import("node:fs");
  for (const row of procs.byMem) if (existsSync("/proc/" + row.pid)) found += 1;
  assert.ok(found >= Math.max(1, procs.byMem.length - 2), "ranked pids mostly still exist (" + found + "/" + procs.byMem.length + ")");
  ctx._dispose();
});

await check("the whole snapshot payload serialises into a small, bounded body", async () => {
  const { ctx, routes } = mount();
  get(routes, "/dsh-resource-bar/detail");
  await sleep(2000);
  const route = routes.get("/dsh-resource-bar/detail");
  const { req, res } = fakeExchange();
  route.handler(req, res);
  const bytes = Buffer.byteLength(res.body, "utf8");
  // A 2s poll of an unbounded payload would be a self-inflicted DoS; keep the
  // detail response comfortably small.
  assert.ok(bytes < 32 * 1024, "detail body stays small, got " + bytes + " bytes");
  ctx._dispose();
});

await check("parsed per-process RSS matches the kernel's own statm figure", async () => {
  // Independent cross-check of the trickiest parse in the plugin: /proc/<pid>/stat
  // reports rss in PAGES at a positional offset, and getting the offset wrong is
  // silent. /proc/<pid>/statm reports the same resident count as its second
  // field, so comparing the two catches an off-by-N without trusting `ps`.
  const { readFileSync } = await import("node:fs");
  const { parsePidStat } = await import("../lib/index.js");
  const self = process.pid;
  const stat = parsePidStat(readFileSync("/proc/" + self + "/stat", "utf8"));
  const statm = readFileSync("/proc/" + self + "/statm", "utf8").trim().split(/\s+/).map(Number);
  assert.ok(stat, "own stat parsed");
  assert.strictEqual(stat.pid, self, "parsed our own pid");
  const statmResidentPages = statm[1];
  assert.ok(statmResidentPages > 0, "statm reports resident pages");
  const parsedPages = stat.rssBytes / 4096;
  // The two files are read at slightly different instants, so allow a small
  // drift but not a systematic offset (a wrong offset would differ by a lot).
  const drift = Math.abs(parsedPages - statmResidentPages) / statmResidentPages;
  assert.ok(drift < 0.2, "rss pages agree with statm (parsed " + parsedPages + " vs statm " + statmResidentPages + ", drift " + (drift * 100).toFixed(1) + "%)");
  // And the process name should be a real, non-empty comm.
  assert.ok(stat.comm.length > 0, "comm parsed: " + stat.comm);
});

console.log("\nselftest-live: " + passed + " checks passed");
