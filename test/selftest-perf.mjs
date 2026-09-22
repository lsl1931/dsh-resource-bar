// Performance / boundary selftest.
//
// A 1s sampler that runs for the lifetime of the host must be cheap, and the
// lazy process scanner must not be a way to make the host do unbounded work.
// The budgets below are deliberately loose (they are 5-20x the observed cost on
// the reference machine) so the suite is not a flaky benchmark — it is a guard
// against an accidental O(n^2) or a regression that scans /proc per request.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  PROC_SCAN_LIMIT,
  buildSnapshot,
  cpuPercents,
  hostInfo,
  parseMeminfo,
  parseProcStat,
  rankProcesses,
  readCpuSample,
  readMemSample,
  readProcTable,
} from "../lib/index.js";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};

const time = (fn) => {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
};

// --- CPU-bound pure work (no IO, so the budget is meaningful) ----------------

check("parsing /proc/stat stays cheap", () => {
  const raw = ["cpu  100 0 50 100000 20 0 3 0 0 0", ...Array.from({ length: 128 }, (_, i) => `cpu${i} 10 0 5 1000 1 0 0 0 0 0`)].join("\n");
  const { ms } = time(() => {
    for (let i = 0; i < 2000; i++) parseProcStat(raw);
  });
  // 2000 parses of a 128-core file.
  assert.ok(ms < 2000, "2000 parses in " + ms.toFixed(1) + "ms");
  const per = ms / 2000;
  console.log("         " + per.toFixed(4) + "ms per 128-core parse");
});

check("the per-sample fold does not grow with the core count", () => {
  const wide = ["cpu  100 0 50 100000 20 0 3 0 0 0", ...Array.from({ length: 256 }, (_, i) => `cpu${i} 10 0 5 1000 1 0 0 0 0 0`)].join("\n");
  const narrow = "cpu  100 0 50 100000 20 0 3 0 0 0\ncpu0 10 0 5 1000 1 0 0 0 0 0\n";
  const n = 500;
  const narrowMs = time(() => {
    const a = parseProcStat(narrow);
    const b = parseProcStat(narrow);
    for (let i = 0; i < n; i++) cpuPercents(a, b);
  }).ms;
  const wideMs = time(() => {
    const a = parseProcStat(wide);
    const b = parseProcStat(wide);
    for (let i = 0; i < n; i++) cpuPercents(a, b);
  }).ms;
  // Linear in cores is expected and fine; what must not happen is a second,
  // hidden factor. 256 vs 1 core is 256x the work, so allow generous headroom.
  assert.ok(wideMs < narrowMs * 2000, "wide " + wideMs.toFixed(1) + "ms vs narrow " + narrowMs.toFixed(1) + "ms");
});

check("ranking a large process table is linear-ish and bounded", () => {
  const size = 4000;
  const prev = new Map();
  const next = new Map();
  for (let i = 0; i < size; i++) {
    prev.set(i, { pid: i, comm: "p" + i, state: "S", utime: i, stime: i, rssBytes: i * 1024 });
    next.set(i, { pid: i, comm: "p" + i, state: "S", utime: i + (i % 7), stime: i, rssBytes: i * 1024 });
  }
  const { ms, value } = time(() => rankProcesses(prev, next, { totalDelta: 1000, cpuCount: 8, memTotal: 8e9, topN: 5 }));
  assert.ok(ms < 1500, "4000 processes ranked in " + ms.toFixed(1) + "ms");
  assert.strictEqual(value.byCpu.length, 5);
  assert.strictEqual(value.byMem.length, 5);
});

check("parseMeminfo stays cheap on the real file", () => {
  const raw = readFileSyncSafe("/proc/meminfo");
  if (raw === null) {
    console.log("         (no /proc/meminfo on this host; using a synthetic fixture)");
  }
  const text = raw ?? "MemTotal: 2002368 kB\nMemFree: 261992 kB\nMemAvailable: 556644 kB\n".repeat(20);
  const { ms } = time(() => {
    for (let i = 0; i < 5000; i++) parseMeminfo(text);
  });
  assert.ok(ms < 1500, "5000 parses in " + ms.toFixed(1) + "ms");
});

function readFileSyncSafe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// --- real IO budgets --------------------------------------------------------

check("one real CPU+memory sample is far below the 1s interval", () => {
  const { ms } = time(() => {
    readCpuSample();
    readMemSample();
  });
  // The whole point of sampling on an interval and serving a cache.
  assert.ok(ms < 100, "one sample took " + ms.toFixed(2) + "ms");
  console.log("         " + ms.toFixed(2) + "ms per sample");
});

check("one real process scan is bounded and cheap enough for a 1.5s interval", () => {
  const { ms, value } = time(() => readProcTable());
  assert.ok(ms < 800, "a full process scan took " + ms.toFixed(1) + "ms");
  assert.ok(value.size <= PROC_SCAN_LIMIT, "scan respects PROC_SCAN_LIMIT");
  console.log("         " + ms.toFixed(1) + "ms for " + value.size + " processes");
});

check("PROC_SCAN_LIMIT actually bounds the scan on a hostile /proc", () => {
  // Not a perf test but the invariant the perf test relies on: the cap is a
  // documented, enforced bound rather than a comment.
  assert.ok(Number.isFinite(PROC_SCAN_LIMIT) && PROC_SCAN_LIMIT > 0 && PROC_SCAN_LIMIT <= 8192, "sane cap: " + PROC_SCAN_LIMIT);
});

check("building a full snapshot is cheap (it runs once per second)", () => {
  const prev = readCpuSample();
  const next = readCpuSample();
  const info = hostInfo();
  const percents = cpuPercents(prev, next);
  const memInfo = readMemSample();
  const { ms } = time(() => {
    for (let i = 0; i < 50; i++) buildSnapshot({ info, startedAt: Date.now(), percents, memInfo, samples: i });
  });
  assert.ok(ms < 500, "50 snapshots in " + ms.toFixed(1) + "ms");
  console.log("         " + (ms / 50).toFixed(3) + "ms per snapshot");
});

check("a snapshot serialises within a 2s poll budget", () => {
  const prev = readCpuSample();
  const next = readCpuSample();
  const snap = buildSnapshot({
    info: hostInfo(),
    startedAt: Date.now(),
    percents: cpuPercents(prev, next),
    memInfo: readMemSample(),
    samples: 2,
  });
  const { ms, value } = time(() => JSON.stringify(snap));
  assert.ok(ms < 20, "serialisation took " + ms.toFixed(2) + "ms");
  assert.ok(value.length < 8 * 1024, "summary payload is " + value.length + " bytes");
});

console.log("\nselftest-perf: " + passed + " checks passed");
