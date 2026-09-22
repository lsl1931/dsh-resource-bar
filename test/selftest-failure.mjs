// Failure-path selftest. A monitoring plugin that takes the host down with it
// is worse than no plugin, so every /proc read is exercised against a root that
// does not exist (the honest way to simulate a non-Linux host or a locked-down
// container) and the snapshot must degrade instead of throwing.
//
// Falsifiability: remove the try/catch in readText / readdirSync and this test
// fails with ENOENT instead of asserting the degraded shape.
import assert from "node:assert";
import {
  buildSnapshot,
  blankSnapshot,
  hostInfo,
  isBlank,
  parseLoadavg,
  readCpuSample,
  readMemSample,
  readProcTable,
  readUptime,
} from "../lib/index.js";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};

/** A path that cannot exist, used as a stand-in for "no procfs here". */
const NOWHERE = "/nonexistent-proc-root-for-tests";

check("hostInfo degrades to a null model without /proc/cpuinfo", () => {
  const info = hostInfo(NOWHERE);
  assert.strictEqual(info.model, null);
  // Core count comes from the OS, not from procfs, so it stays meaningful.
  assert.ok(Number.isFinite(info.cores) && info.cores >= 0);
});

check("readCpuSample / readMemSample return null instead of throwing", () => {
  assert.strictEqual(readCpuSample(NOWHERE), null);
  assert.strictEqual(readMemSample(NOWHERE), null);
});

check("readProcTable returns an empty Map instead of throwing", () => {
  const table = readProcTable(NOWHERE);
  assert.ok(table instanceof Map);
  assert.strictEqual(table.size, 0);
});

check("readUptime returns null instead of throwing", () => {
  assert.strictEqual(readUptime(NOWHERE), null);
});

check("buildSnapshot survives a completely unreadable procfs", () => {
  const snap = buildSnapshot({
    info: hostInfo(NOWHERE),
    startedAt: Date.now(),
    percents: { busyPct: null, breakdown: null, cores: [], totalDelta: 0 },
    memInfo: null,
    samples: 1,
    root: NOWHERE,
  });
  // Still a well-formed, serveable payload: the UI shows "no reading", the
  // route answers 200, and nothing downstream has to special-case a crash.
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.available, false);
  assert.strictEqual(snap.cpu.busyPct, null);
  assert.strictEqual(snap.mem, null);
  assert.strictEqual(snap.host.uptimeSec, null);
  assert.strictEqual(snap.load.one, null, "load is unknown, not 0.00");
  assert.doesNotThrow(() => JSON.stringify(snap), "payload stays serialisable");
});

check("blankSnapshot is well-formed and reports 'unavailable'", () => {
  const snap = blankSnapshot({ model: null, cores: 0 });
  assert.strictEqual(snap.available, false);
  assert.strictEqual(snap.cpu.busyPct, null);
  assert.strictEqual(snap.mem, null);
  assert.strictEqual(snap.cpu.samples, 0);
  assert.doesNotThrow(() => JSON.stringify(snap));
});

check("isBlank distinguishes 'no reading' from a real 0%", () => {
  assert.strictEqual(isBlank({ cpu: { busyPct: null } }), true);
  assert.strictEqual(isBlank({ cpu: {} }), true);
  assert.strictEqual(isBlank({ cpu: { busyPct: 0 } }), false, "0% is a valid reading");
  assert.strictEqual(isBlank(null), true);
  // The distinction the UI depends on: an idle machine shows 0.0%, an
  // unreadable one must not.
  assert.notStrictEqual(isBlank({ cpu: { busyPct: 0 } }), isBlank({ cpu: { busyPct: null } }));
});

check("a partial /proc (valid cpu, missing meminfo) still yields CPU data", () => {
  const snap = buildSnapshot({
    info: { model: "test", cores: 2 },
    startedAt: Date.now(),
    percents: { busyPct: 42, breakdown: { user: 40, idle: 58 }, cores: [{ id: 0, pct: 42 }], totalDelta: 100 },
    memInfo: null,
    samples: 2,
    root: NOWHERE,
  });
  assert.strictEqual(snap.available, true);
  assert.strictEqual(snap.cpu.busyPct, 42);
  assert.strictEqual(snap.mem, null, "memory simply absent");
});

check("loadavg degraded to nulls never renders as 0.00", () => {
  const bad = parseLoadavg("");
  assert.strictEqual(bad.one, null);
  assert.notStrictEqual(bad.one, 0, "must not masquerade as an idle machine");
});

check("this host actually reads as available (the happy path is real)", () => {
  // The mirror image of the degraded cases above: on this Linux box the sampler
  // must genuinely succeed, so "available" can never be a constant false.
  const info = hostInfo();
  const sample = readCpuSample();
  assert.ok(info.cores > 0, "core count detected");
  assert.ok(sample, "/proc/stat readable");
  assert.ok(sample.aggregate.total > 0);
});

console.log("\nselftest-failure: " + passed + " checks passed");
