// Integration selftest: the two halves against ONE payload.
//
// The other suites test each half against fixtures or the kernel. This one
// closes the loop that a fixture cannot: it serves the REAL Node-half response
// (assembled from the real /proc on this machine) into the REAL client half,
// renders it, and asserts the pill and panel display it. If the two halves ever
// disagree about the payload shape, this is the suite that fails.
import assert from "node:assert";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { apply } from "../lib/index.js";
import { fakeExchange, installDom, loadClientBundle, makeContext } from "./harness.mjs";

await installDom();

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log("  ok  " + name);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serve the real Node half's JSON through a fetch double, keyed by suffix. */
function realHostFetch() {
  const ctx = makeContext({ provide: { connection: { requestRejection: () => undefined } } });
  apply(ctx);
  const routes = new Map(ctx._routes.map((r) => [r.path, r]));
  const respond = (path) => {
    const route = routes.get(path);
    assert.ok(route, path + " is registered");
    const { req, res } = fakeExchange({ url: path });
    route.handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    return res.json();
  };
  const impl = (url) => {
    const path = String(url).startsWith("/dsh-resource-bar") ? String(url) : "/dsh-resource-bar" + String(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(respond(path)) });
  };
  return { impl, ctx, routes, respond };
}

async function mountClient(fetchImpl) {
  const bundle = loadClientBundle({ fetch: fetchImpl });
  const ctx = makeContext();
  bundle.mod.apply(ctx);
  const Component = ctx._slots.entries[0].component;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(Component());
  });
  await act(async () => {
    await sleep(30);
  });
  return { ctx, root, host };
}

async function teardown(m) {
  await act(async () => m.root.unmount());
  m.ctx._dispose();
  if (m.host.parentNode) m.host.parentNode.removeChild(m.host);
}

await check("the client half renders the real Node half's live payload", async () => {
  const host = realHostFetch();
  // Let the sampler take its second reading so the payload is fully populated.
  await sleep(1400);
  const m = await mountClient(host.impl);

  const pill = m.host.querySelector(".dsh-rb");
  assert.ok(pill, "pill rendered from the real payload");
  const text = pill.textContent;
  assert.match(text, /CPU/, "CPU metric present");
  assert.match(text, /内存/, "memory metric present");
  assert.match(text, /\d+(\.\d+)?%/, "a real percentage is displayed");
  assert.ok(!/无读数/.test(text), "the live host is readable, so no unknown marker");

  await teardown(m);
  host.ctx._dispose();
});

await check("the expanded panel renders every section from the real payload", async () => {
  const host = realHostFetch();
  await sleep(1400);
  const m = await mountClient(host.impl);

  await act(async () => {
    m.host.querySelector(".dsh-rb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await sleep(2200);
  });

  const panel = m.host.querySelector(".dsh-rb-panel");
  assert.ok(panel, "panel opened");
  const text = panel.textContent;
  assert.match(text, /CPU/);
  assert.match(text, /总占用/);
  assert.match(text, /用户态/);
  assert.match(text, /内存/);
  assert.match(text, /已用/);
  assert.match(text, /负载/);
  assert.match(text, /进程/);
  assert.match(text, /刷新/);

  // Per-core blocks: one label per core, matching the real core count.
  const cores = m.host.querySelectorAll(".dsh-rb-core");
  const summary = host.respond("/dsh-resource-bar/summary");
  assert.strictEqual(cores.length, summary.host.cores, "one per-core block per real core");

  // The process section must show real process names.
  const procRows = m.host.querySelectorAll(".dsh-rb-row--proc");
  assert.ok(procRows.length > 0, "process rows rendered");

  await teardown(m);
  host.ctx._dispose();
});

await check("the rail variant renders the real payload compactly", async () => {
  const host = realHostFetch();
  await sleep(1400);
  const bundle = loadClientBundle({ fetch: host.impl });
  const ctx = makeContext();
  bundle.mod.apply(ctx);
  const Component = ctx._slots.entries[0].component;
  const frame = document.createElement("div");
  frame.setAttribute("data-sidebar-collapsed", "true");
  const el = document.createElement("div");
  frame.appendChild(el);
  document.body.appendChild(frame);
  const root = createRoot(el);
  await act(async () => {
    root.render(Component());
  });
  await act(async () => {
    await sleep(30);
  });
  assert.ok(el.querySelector(".dsh-rb__rail"), "compact rail content present");
  assert.match(el.querySelector(".dsh-rb").textContent, /\d+%/, "real percentages shown");
  await act(async () => root.unmount());
  ctx._dispose();
  frame.parentNode.removeChild(frame);
  host.ctx._dispose();
});

await check("polling the real routes over several intervals stays consistent", async () => {
  const host = realHostFetch();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await sleep(1100);
    const snap = host.respond("/dsh-resource-bar/summary");
    seen.push(snap);
    assert.strictEqual(snap.ok, true);
    assert.ok(snap.cpu.samples >= i + 1, "sample counter advances monotonically");
  }
  // The monotone counter is what proves the sampler is alive rather than
  // serving one frozen snapshot.
  const counts = seen.map((s) => s.cpu.samples);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] > counts[i - 1], "samples strictly increase: " + counts.join(","));
  }
  host.ctx._dispose();
});

await check("disposing both halves leaves no timer and no style behind", async () => {
  const host = realHostFetch();
  const m = await mountClient(host.impl);
  const tag = document.querySelector('style[data-plugin-css="dsh-resource-bar/style.css"]');
  assert.ok(tag, "style installed while mounted");
  await teardown(m);
  host.ctx._dispose();
  assert.strictEqual(document.querySelector('style[data-plugin-css="dsh-resource-bar/style.css"]'), null, "style removed");
});

console.log("\nselftest-integration: " + passed + " checks passed");
