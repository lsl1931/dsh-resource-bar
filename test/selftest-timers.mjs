// Timer-ownership selftest. The official plugin contracts require every timer
// to belong to the fiber: disabling the plugin must leave no live interval
// behind. This drives the REAL apply() with a stubbed interval table and fails
// if anything is still armed after dispose.
//
// Falsifiability: comment out the `clearInterval` in apply()'s cpu-sampler
// effect (or the stopProcSampler call) and this test fails.
import assert from "node:assert";
import { apply, inject } from "../lib/index.js";
import { makeContext } from "./harness.mjs";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};

/** Install a fake interval table; returns handles + restoration. */
function fakeTimers() {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const live = new Set();
  const created = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, id: created.length + 1 };
    live.add(handle);
    created.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    live.delete(handle);
  };
  return {
    live,
    created,
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
}

check("apply() can be driven with a stubbed harness and declared inject", () => {
  assert.deepStrictEqual(inject, ["webServer", "connection"], "hard deps are exactly the HTTP server and the trust fence");
});

check("every interval is cleared on dispose", () => {
  const timers = fakeTimers();
  try {
    const ctx = makeContext({ provide: { connection: { requestRejection: () => undefined } } });
    apply(ctx);
    assert.ok(ctx._effects.length >= 1, "cpu sampler effect registered");
    assert.ok(timers.created.length >= 1, "cpu interval created");
    assert.ok(timers.live.size >= 1, "and it is live");

    ctx._dispose();
    assert.strictEqual(timers.live.size, 0, "no timer survives dispose");
  } finally {
    timers.restore();
  }
});

check("the lazy process sampler is also owned by the fiber", () => {
  const timers = fakeTimers();
  try {
    const ctx = makeContext({ provide: { connection: { requestRejection: () => undefined } } });
    apply(ctx);
    // Calling the detail route is what starts the process sampler.
    const detail = ctx._routes.find((r) => r.path === "/dsh-resource-bar/detail");
    assert.ok(detail, "detail route registered");
    let status = null;
    detail.handler(
      { method: "GET", url: "/dsh-resource-bar/detail" },
      { writeHead: (s) => (status = s), end() {} },
    );
    assert.strictEqual(status, 200);
    const liveAfterDetail = timers.live.size;
    assert.ok(liveAfterDetail >= 2, "cpu + process intervals both live");
    ctx._dispose();
    assert.strictEqual(timers.live.size, 0, "dispose ends the lazy interval too");
  } finally {
    timers.restore();
  }
});

check("dispose is idempotent and re-apply after dispose creates a fresh fiber", () => {
  const timers = fakeTimers();
  try {
    const ctx = makeContext({ provide: { connection: { requestRejection: () => undefined } } });
    apply(ctx);
    ctx._dispose();
    ctx._dispose();
    assert.strictEqual(timers.live.size, 0);

    const ctx2 = makeContext({ provide: { connection: { requestRejection: () => undefined } } });
    apply(ctx2);
    assert.ok(timers.live.size >= 1, "a second apply arms its own timer");
    ctx2._dispose();
    assert.strictEqual(timers.live.size, 0);
  } finally {
    timers.restore();
  }
});

console.log("\nselftest-timers: " + passed + " checks passed");
