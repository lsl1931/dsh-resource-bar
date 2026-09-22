// Route-contract selftest: drives the handlers the plugin actually registers.
//
// These are the rules the official plugin contracts state explicitly, and each
// one fails *silently* when broken — which is why they are asserted here rather
// than left to a human reading the source:
//   * `kind: "exact"` (anything else falls into the longest-prefix table, so
//     `/summary/anything` would also resolve to our handler);
//   * an explicit method check (a GET-only route must answer 405 to a POST);
//   * the connection trust fence on every custom path (`requestRejection` is
//     the Host/Origin + browser-auth boundary; `/api` does not apply it to us).
import assert from "node:assert";
import { apply, inject } from "../lib/index.js";
import { fakeExchange, makeContext } from "./harness.mjs";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};

/** Build a context whose trust fence answers with the given decision. */
function mounted(rejection) {
  const fenceCalls = [];
  const connection = {
    requestRejection(req) {
      fenceCalls.push(req);
      return rejection;
    },
  };
  const ctx = makeContext({ provide: { connection } });
  apply(ctx);
  return { ctx, fenceCalls };
}

const PATHS = ["/dsh-resource-bar/summary", "/dsh-resource-bar/detail"];

check("apply() registers exactly the two documented routes", () => {
  const { ctx } = mounted(undefined);
  assert.deepStrictEqual(
    ctx._routes.map((r) => r.path).sort(),
    [...PATHS].sort(),
  );
  ctx._dispose();
});

check("every route declares kind:'exact'", () => {
  const { ctx } = mounted(undefined);
  for (const route of ctx._routes) {
    assert.strictEqual(route.kind, "exact", route.path + " must be exact, not prefix");
  }
  ctx._dispose();
});

check("every route is mounted through ctx.effect so unload unregisters it", () => {
  const { ctx } = mounted(undefined);
  assert.ok(ctx._effects.length >= 3, "stylesheet-free node half: sampler + 2 routes");
  ctx._dispose();
  assert.strictEqual(ctx._routes.length, 0, "routes removed on dispose");
});

check("route paths live under the plugin's own namespace", () => {
  const { ctx } = mounted(undefined);
  for (const route of ctx._routes) {
    assert.ok(route.path.startsWith("/dsh-resource-bar/"), route.path + " must be namespaced");
  }
  ctx._dispose();
});

check("the trust fence is consulted on every request", () => {
  const { ctx, fenceCalls } = mounted(undefined);
  for (const route of ctx._routes) {
    const { req, res } = fakeExchange();
    route.handler(req, res);
    assert.ok(res.ended, "handler answered");
  }
  assert.strictEqual(fenceCalls.length, 2, "one fence call per route hit");
  ctx._dispose();
});

check("a rejected request is refused and leaks no body", () => {
  for (const status of [401, 403]) {
    const { ctx } = mounted(status);
    for (const route of ctx._routes) {
      const { req, res } = fakeExchange();
      route.handler(req, res);
      assert.strictEqual(res.statusCode, status, route.path + " answers " + status);
      assert.strictEqual(res.body, "", "rejection carries no payload");
    }
    ctx._dispose();
  }
});

check("the fence fails CLOSED when the connection service is absent", () => {
  // No `connection` in the context at all: an unverifiable request must be
  // refused, never served. A diagnostic error code is returned (it is not a
  // secret and makes the misconfiguration diagnosable) — what must never
  // happen is a 2xx with resource data.
  const ctx = makeContext({ provide: {} });
  apply(ctx);
  for (const route of ctx._routes) {
    const { req, res } = fakeExchange();
    route.handler(req, res);
    assert.ok(res.statusCode >= 400, route.path + " must not serve without a trust fence");
    const body = res.json();
    assert.strictEqual(body.ok, false, "no success flag");
    assert.ok(!("cpu" in body) && !("mem" in body) && !("procs" in body), "no resource data leaks");
  }
  ctx._dispose();
});

check("a wrong method is refused with 405 and an Allow header", () => {
  const { ctx } = mounted(undefined);
  for (const route of ctx._routes) {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const { req, res } = fakeExchange({ method });
      route.handler(req, res);
      assert.strictEqual(res.statusCode, 405, route.path + " " + method);
      assert.strictEqual(res.headers.allow, "GET");
      assert.strictEqual(res.json().error, "method_not_allowed", "body is valid JSON naming the failure");
    }
  }
  ctx._dispose();
});

check("GET responses are JSON, uncached, and shaped as documented", () => {
  const { ctx } = mounted(undefined);
  const summary = ctx._routes.find((r) => r.path.endsWith("/summary"));
  const { req, res } = fakeExchange();
  summary.handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^application\/json/);
  assert.match(res.headers["cache-control"], /no-store/);
  const body = res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.available, "boolean");
  assert.strictEqual(typeof body.ts, "number");
  assert.ok("cpu" in body && "host" in body && "load" in body);
  assert.strictEqual(typeof body.cpu.busyPct === "number" || body.cpu.busyPct === null, true);
  ctx._dispose();
});

check("the detail route adds a process ranking to the same snapshot", () => {
  const { ctx } = mounted(undefined);
  const detail = ctx._routes.find((r) => r.path.endsWith("/detail"));
  const { req, res } = fakeExchange();
  detail.handler(req, res);
  const body = res.json();
  assert.ok(body.procs, "detail carries procs");
  assert.strictEqual(typeof body.procs.ready, "boolean");
  assert.ok(Array.isArray(body.procs.byCpu));
  assert.ok(Array.isArray(body.procs.byMem));
  assert.ok(body.procs.byCpu.length <= 5 && body.procs.byMem.length <= 5, "topN respected");
  ctx._dispose();
});

check("a requestURL with a query still hits the same handler (no secret in the URL)", () => {
  const { ctx } = mounted(undefined);
  const summary = ctx._routes.find((r) => r.path.endsWith("/summary"));
  const { req, res } = fakeExchange({ url: "/dsh-resource-bar/summary?x=1" });
  summary.handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  ctx._dispose();
});

check("no secret is ever handed out by an unauthenticated route", () => {
  const { ctx } = mounted(undefined);
  for (const route of ctx._routes) {
    const { req, res } = fakeExchange();
    route.handler(req, res);
    const body = res.body;
    assert.ok(!/nonce|secret|token/i.test(body), route.path + " must not leak a secret");
  }
  ctx._dispose();
});

check("a handler never throws into the server, even with a hostile request", () => {
  const { ctx } = mounted(undefined);
  for (const route of ctx._routes) {
    for (const hostile of [{}, { method: undefined }, { method: "GET", headers: null }]) {
      assert.doesNotThrow(() => route.handler(hostile, { writeHead() {}, end() {} }));
    }
  }
  ctx._dispose();
});

console.log("\nselftest-routes: " + passed + " checks passed");
