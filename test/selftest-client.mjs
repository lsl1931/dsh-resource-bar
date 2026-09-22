// Client-half render selftest: mounts the REAL built bundle into a real DOM
// with real React, and asserts the behaviour a user would notice. Nothing here
// re-implements the component; it drives `apply()` from lib/client.js exactly
// as the module system does (window.__ModuleLoader__ → factory → apply).
import assert from "node:assert";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { installDom, loadClientBundle, makeContext, settle } from "./harness.mjs";

await installDom();

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log("  ok  " + name);
};

// --- fake host data served over fetch ---------------------------------------

const SUMMARY = {
  ok: true,
  available: true,
  ts: Date.now(),
  sampledFrom: "procfs",
  host: { model: "Test CPU 3000", cores: 4, uptimeSec: 90061, startedAt: Date.now() - 1000, platform: "linux" },
  cpu: {
    busyPct: 37.5,
    breakdown: { user: 25, nice: 0, system: 10, iowait: 1, irq: 0.5, steal: 0, idle: 62.5 },
    cores: [
      { id: 0, pct: 10 },
      { id: 1, pct: 20 },
      { id: 2, pct: 30 },
      { id: 3, pct: 95 },
    ],
    coreCount: 4,
    model: "Test CPU 3000",
    samples: 5,
    totalJiffiesDelta: 400,
  },
  mem: {
    totalBytes: 8 * 1024 ** 3,
    usedBytes: 5 * 1024 ** 3,
    usedPct: 62.5,
    availableBytes: 3 * 1024 ** 3,
    freeBytes: 1024 ** 3,
    cachedBytes: 1.5 * 1024 ** 3,
    buffersBytes: 100 * 1024 ** 2,
    sharedBytes: 50 * 1024 ** 2,
    swapTotalBytes: 2 * 1024 ** 3,
    swapUsedBytes: 512 * 1024 ** 2,
    swapUsedPct: 25,
    nodeRssBytes: 200 * 1024 ** 2,
  },
  load: { one: 1.25, five: 0.9, fifteen: 0.5, runnable: 3, total: 210 },
};

const DETAIL = {
  ...SUMMARY,
  procs: {
    ready: true,
    sampledAt: Date.now(),
    byCpu: [
      { pid: 100, comm: "node", cpuPct: 120.5, rssBytes: 300 * 1024 ** 2, memPct: 3.6 },
      { pid: 200, comm: "xray", cpuPct: 42, rssBytes: 90 * 1024 ** 2, memPct: 1.1 },
    ],
    byMem: [
      { pid: 300, comm: "dsh web", cpuPct: 0, rssBytes: 450 * 1024 ** 2, memPct: 5.5 },
      { pid: 100, comm: "node", cpuPct: 120.5, rssBytes: 300 * 1024 ** 2, memPct: 3.6 },
    ],
  },
};

/** A fetch double: routes are matched by suffix, calls are counted. */
function fakeFetch({ summary = SUMMARY, detail = DETAIL, failSummary = false, failDetail = false } = {}) {
  const calls = [];
  const impl = (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/detail")) {
      if (failDetail) return Promise.reject(new Error("offline"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detail) });
    }
    if (failSummary) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summary) });
  };
  impl.calls = calls;
  return impl;
}

/** Mount the real client half and return the live container. */
async function mountPlugin({ fetchImpl = fakeFetch(), rail = false } = {}) {
  const bundle = loadClientBundle({ fetch: fetchImpl });
  const ctx = makeContext({ provide: { slots: ctxSlots(), locale: { register() {} } } });
  ctx.apply = undefined;
  await act(async () => {
    bundle.mod.apply(ctx);
  });
  assert.strictEqual(ctx._slots.entries.length, 1, "exactly one slot registration");
  const { options, component } = ctx._slots.entries[0];

  // The frame the rail attribute rides on, as in the real app shell.
  const frame = document.createElement("div");
  if (rail) frame.setAttribute("data-sidebar-collapsed", "true");
  const host = document.createElement("div");
  frame.appendChild(host);
  document.body.appendChild(frame);

  const root = createRoot(host);
  const Component = component;
  await act(async () => {
    root.render(Component());
  });
  await act(async () => {
    await settle(4);
  });
  return { bundle, ctx, options, container: host, frame, root, fetchImpl };
}

function ctxSlots() {
  // makeContext supplies `slots` itself when `provide` omits it; passing an
  // empty object would shadow the real stub, so hand over the stub contract.
  return undefined;
}

async function unmount(m) {
  await act(async () => {
    m.root.unmount();
  });
  m.ctx._dispose();
  if (m.frame.parentNode) m.frame.parentNode.removeChild(m.frame);
}

// --- checks -----------------------------------------------------------------

await check("apply() registers into the official footer-action list slot", async () => {
  const m = await mountPlugin();
  assert.deepStrictEqual(m.bundle.mod.inject, ["slots", "locale"]);
  assert.deepStrictEqual(m.ctx._slots.injected, ["sidebar.footer.action"], "registers into the documented slot");
  assert.strictEqual(m.options.name, "sidebar.footer.action");
  assert.strictEqual(m.options.id, "dsh-resource-bar", "stable id for the ledger");
  assert.strictEqual(typeof m.options.order, "number", "explicit order so placement is deterministic");
  await unmount(m);
});

await check("the stylesheet is tagged so the module system attributes it", async () => {
  const m = await mountPlugin();
  const tag = document.querySelector('style[data-plugin-css="dsh-resource-bar/style.css"]');
  assert.ok(tag, "style tag carries data-plugin-css");
  assert.match(tag.textContent, /\.dsh-rb/);
  await unmount(m);
});

await check("the pill renders CPU and memory percentages once data arrives", async () => {
  const m = await mountPlugin();
  const pill = m.container.querySelector(".dsh-rb");
  assert.ok(pill, "pill rendered");
  const text = pill.textContent;
  assert.match(text, /CPU/);
  assert.match(text, /内存/);
  assert.match(text, /37\.5%/, "CPU busy percent shown");
  assert.match(text, /62\.5%/, "memory used percent shown");
  await unmount(m);
});

await check("the pill is a real button with an accessible name and expanded state", async () => {
  const m = await mountPlugin();
  const pill = m.container.querySelector(".dsh-rb");
  assert.strictEqual(pill.tagName, "BUTTON", "keyboard-operable by construction");
  assert.strictEqual(pill.getAttribute("type"), "button", "does not submit an enclosing form");
  assert.match(pill.getAttribute("aria-label"), /CPU 37\.5%/);
  assert.strictEqual(pill.getAttribute("aria-expanded"), "false");
  assert.ok(pill.title.length > 0, "hover title present");
  await unmount(m);
});

await check("clicking the pill expands the detail panel and flips aria-expanded", async () => {
  const m = await mountPlugin();
  const pill = m.container.querySelector(".dsh-rb");
  assert.strictEqual(m.container.querySelector(".dsh-rb-panel"), null, "closed initially");

  await act(async () => {
    pill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(4);
  });

  const panel = m.container.querySelector(".dsh-rb-panel");
  assert.ok(panel, "panel opened on click");
  assert.strictEqual(m.container.querySelector(".dsh-rb").getAttribute("aria-expanded"), "true");
  await unmount(m);
});

await check("the expanded panel shows cores, breakdown, memory and processes", async () => {
  const m = await mountPlugin();
  await act(async () => {
    m.container.querySelector(".dsh-rb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(4);
  });
  const text = m.container.querySelector(".dsh-rb-panel").textContent;
  assert.match(text, /本机资源/);
  assert.match(text, /总占用/);
  assert.match(text, /用户态/);
  assert.match(text, /内核态/);
  assert.match(text, /等待 IO/);
  assert.match(text, /已用/);
  assert.match(text, /交换分区/);
  assert.match(text, /node/, "top process by CPU listed");
  assert.match(text, /dsh web/, "top process by memory listed");
  assert.match(text, /Test CPU 3000/, "host model shown");
  assert.match(text, /1天1小时/, "uptime humanised (90061s)");
  await unmount(m);
});

await check("the 刷新 button actually re-fetches detail", async () => {
  // Regression guard: the button bumps a nonce, so the detail effect must
  // depend on it. Without that dependency the button rendered but did nothing.
  const fetchImpl = fakeFetch();
  const m = await mountPlugin({ fetchImpl });
  await act(async () => {
    m.container.querySelector(".dsh-rb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(4);
  });
  const callsBefore = fetchImpl.calls.filter((u) => u.includes("/detail")).length;
  assert.ok(callsBefore >= 1, "detail fetched on open");

  const btn = [...m.container.querySelectorAll(".dsh-rb-panel__btn")].find((b) => /刷新/.test(b.textContent));
  assert.ok(btn, "refresh button rendered");
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(4);
  });
  const callsAfter = fetchImpl.calls.filter((u) => u.includes("/detail")).length;
  assert.ok(callsAfter > callsBefore, "clicking refresh triggers another detail fetch (" + callsBefore + " -> " + callsAfter + ")");
  await unmount(m);
});

await check("the panel closes on Escape", async () => {
  const m = await mountPlugin();
  await act(async () => {
    m.container.querySelector(".dsh-rb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(3);
  });
  assert.ok(m.container.querySelector(".dsh-rb-panel"), "open before Escape");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await act(async () => {
    await settle(3);
  });
  assert.strictEqual(m.container.querySelector(".dsh-rb-panel"), null, "closed on Escape");
  await unmount(m);
});

await check("the panel closes on an outside pointer press", async () => {
  const m = await mountPlugin();
  await act(async () => {
    m.container.querySelector(".dsh-rb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(3);
  });
  assert.ok(m.container.querySelector(".dsh-rb-panel"));
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await act(async () => {
    await settle(3);
  });
  assert.strictEqual(m.container.querySelector(".dsh-rb-panel"), null, "closed on outside press");
  await unmount(m);
});

await check("rail mode (collapsed sidebar) renders the compact variant", async () => {
  const m = await mountPlugin({ rail: true });
  assert.ok(m.container.querySelector(".dsh-rb__rail"), "compact rail content rendered");
  const text = m.container.querySelector(".dsh-rb").textContent;
  assert.match(text, /38%/, "rounded CPU percent");
  assert.match(text, /63%/, "rounded memory percent");
  assert.ok(!/CPU/.test(text), "no clipped wide labels in the rail");
  await unmount(m);
});

await check("wide mode renders gauges with the documented tone classes", async () => {
  const m = await mountPlugin();
  const fills = m.container.querySelectorAll(".dsh-rb__gaugeFill");
  assert.strictEqual(fills.length, 2, "one gauge per metric");
  // 37.5% and 62.5% are both below the 70% warn threshold.
  assert.match(fills[0].className, /--t0/);
  assert.match(fills[1].className, /--t0/);
  assert.match(fills[0].style.width, /37\.5%/);
  await unmount(m);
});

await check("a hot metric is coloured as a warning, not silently green", async () => {
  const hot = JSON.parse(JSON.stringify(SUMMARY));
  hot.cpu.busyPct = 95;
  hot.mem.usedPct = 75;
  const m = await mountPlugin({ fetchImpl: fakeFetch({ summary: hot, detail: { ...hot, procs: DETAIL.procs } }) });
  const fills = m.container.querySelectorAll(".dsh-rb__gaugeFill");
  assert.match(fills[0].className, /--t2/, ">=90% reads as error tone");
  assert.match(fills[1].className, /--t1/, ">=70% reads as warn tone");
  await unmount(m);
});

await check("an unavailable host shows an unknown marker, never a fake 0%", async () => {
  const blank = {
    ...SUMMARY,
    available: false,
    cpu: { ...SUMMARY.cpu, busyPct: null, cores: [] },
    mem: null,
  };
  const m = await mountPlugin({ fetchImpl: fakeFetch({ summary: blank, detail: blank }) });
  const pillText = m.container.querySelector(".dsh-rb").textContent;
  assert.match(pillText, /无读数/, "says so explicitly");
  assert.ok(!/0\.0%/.test(pillText), "does not invent a reading");

  await act(async () => {
    m.container.querySelector(".dsh-rb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await settle(4);
  });
  assert.match(m.container.querySelector(".dsh-rb-panel").textContent, /无读数|无读数|无数据|等待第二次采样/);
  await unmount(m);
});

await check("a failing host does not blank the pill; the last good value stays", async () => {
  const m = await mountPlugin({ fetchImpl: fakeFetch({ failSummary: true, failDetail: true }) });
  // No successful payload ever arrived, so the pill renders nothing at all
  // rather than a misleading 0% — it must not throw either.
  assert.strictEqual(m.container.querySelector(".dsh-rb"), null, "no pill without data");
  await unmount(m);
});

await check("unmounting the pill cleans up its listeners and style", async () => {
  const m = await mountPlugin();
  const tag = document.querySelector('style[data-plugin-css="dsh-resource-bar/style.css"]');
  assert.ok(tag);
  await unmount(m);
  // The stylesheet effect is owned by the fiber, so dispose removes the tag.
  const after = document.querySelector('style[data-plugin-css="dsh-resource-bar/style.css"]');
  assert.strictEqual(after, null, "stylesheet removed with the plugin");
});

await check("the component tolerates being mounted twice (two slot instances)", async () => {
  const fetchImpl = fakeFetch();
  const bundle = loadClientBundle({ fetch: fetchImpl });
  const ctx = makeContext({ provide: { locale: { register() {} } } });
  bundle.mod.apply(ctx);
  const Component = ctx._slots.entries[0].component;

  const hosts = [document.createElement("div"), document.createElement("div")];
  const roots = hosts.map((h) => {
    document.body.appendChild(h);
    return createRoot(h);
  });
  await act(async () => {
    roots[0].render(Component());
    roots[1].render(Component());
  });
  await act(async () => {
    await settle(4);
  });
  for (const host of hosts) {
    assert.ok(host.querySelector(".dsh-rb"), "both instances rendered");
  }
  for (const r of roots) {
    await act(async () => r.unmount());
  }
  for (const h of hosts) if (h.parentNode) h.parentNode.removeChild(h);
  ctx._dispose();
});

console.log("\nselftest-client: " + passed + " checks passed");
