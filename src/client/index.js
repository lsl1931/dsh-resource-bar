// dsh-resource-bar client half: a CPU/memory pill pinned above the sidebar
// Settings row through the official `sidebar.footer.action` list slot, plus a
// popover that expands into full detail on click.
//
// Written JSX-free (React.createElement) and in CJS export form so no build
// toolchain is required: build.mjs wraps this body in the factory-form CJS the
// dsh client-modules system consumes (window.__ModuleLoader__.load). The only
// import is `react`, which the shell seeds in its frozen platform module table.
//
// Geometry and theming follow the same rules the neighbouring usage pill
// documents in its own source and the official plugin contracts restate:
// - rail (collapsed sidebar) state is read from the framework's own
//   `[data-sidebar-collapsed]` frame attribute via closest(), never from the
//   slot's `wide` prop and never by measuring the pill itself;
// - the popover is position:fixed and re-anchored on resize/scroll because the
//   footer slot scrolls independently of the window;
// - every colour comes from a verified `--dsw-alias-*` theme token.

const { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } = require("react");

const NS = "dsh-resource-bar";
const BASE = "/dsh-resource-bar";
const STYLE_ID = "dsh-resource-bar/style.css";

// The collapsed sidebar hands this slot ~36px, far less than the pill's
// min-content width. Rail styling is therefore declarative (keyed off the
// framework attribute in CSS) and detection mirrors it in JS.
const RAIL_ATTR = "data-sidebar-collapsed";
const PANEL_MIN_W = 300;

// Poll cadence: 2s while the sidebar is visible, dropping to 10s after the
// first paint so a forgotten tab cannot keep hammering the host.
const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 10000;
// Detail polls again only while open; the server stops its process sampler
// 15s after the last detail request, so closing the panel ends the extra work.
const DETAIL_POLL_MS = 2000;

// ---------------------------------------------------------------------------
// formatting (pure)
// ---------------------------------------------------------------------------

const pct = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) + "%" : "—");

/** Compact percent for the rail: at most 4 characters. */
const pctShort = (n) => (Number.isFinite(n) ? Math.round(n) + "%" : "—");

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const units = ["B", "K", "M", "G", "T"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + units[i];
}

function formatUptime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + "天" + h + "小时";
  if (h > 0) return h + "小时" + m + "分";
  return m + "分钟";
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "刚刚";
  if (ms < 60000) return Math.round(ms / 1000) + "秒前";
  return Math.round(ms / 60000) + "分钟前";
}

/** Severity bucket for the load colour: 0 ok, 1 warn, 2 hot. */
function toneOf(value) {
  if (!Number.isFinite(value)) return 0;
  if (value >= 90) return 2;
  if (value >= 70) return 1;
  return 0;
}

/** Rail fallback copy when the host reports no reading yet. */
const isBlank = (v) => !Number.isFinite(v);

function fetchJson(path) {
  return fetch(BASE + path, { cache: "no-store" }).then((res) => (res.ok ? res.json() : Promise.reject(new Error("http " + res.status))));
}

// ---------------------------------------------------------------------------
// rail detection
// ---------------------------------------------------------------------------

function railOf(el) {
  return !!(el && el.closest && el.closest("[" + RAIL_ATTR + "]"));
}

/** True while an ancestor frame carries RAIL_ATTR; tracks collapse/expand live. */
function useRailMode(ref, active) {
  const [rail, setRail] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setRail(railOf(el));
    if (typeof MutationObserver !== "function" || typeof document === "undefined") return;
    const sync = () => {
      const node = ref.current;
      if (node) setRail(railOf(node));
    };
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [RAIL_ATTR], subtree: true });
    return () => mo.disconnect();
  }, [active]);
  return rail;
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

function useSummary() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let delay = POLL_FAST_MS;
    const loop = async () => {
      if (cancelled) return;
      try {
        const json = await fetchJson("/summary");
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        // Host unreachable: keep the last value on screen, surface the failure
        // once the panel is open rather than blanking the pill.
        if (!cancelled) setError(String(err && err.message ? err.message : err));
      }
      if (cancelled) return;
      timer = setTimeout(loop, delay);
      delay = POLL_SLOW_MS;
    };
    loop();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return { data, error };
}

// Polls /detail while the panel is open. `nonce` is part of the dependency list
// so a manual refresh actually restarts the loop — without it the 刷新 button
// would be inert (it bumped state nothing read).
function useDetail(open, nonce) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer = null;
    const loop = async () => {
      if (cancelled) return;
      try {
        const json = await fetchJson("/detail");
        if (!cancelled) setDetail(json);
      } catch {
        // keep the last detail frame
      }
      if (cancelled) return;
      timer = setTimeout(loop, DETAIL_POLL_MS);
    };
    loop();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, nonce]);
  return detail;
}

// ---------------------------------------------------------------------------
// sub-views
// ---------------------------------------------------------------------------

function Row({ label, value, muted }) {
  return createElement(
    "div",
    { className: "dsh-rb-row" },
    createElement("span", { className: "dsh-rb-row__lbl" }, label),
    createElement("span", { className: "dsh-rb-row__val" + (muted ? " dsh-rb-row__val--muted" : "") }, value),
  );
}

/** A labelled utilisation bar; width is dynamic geometry, colour is CSS. */
function Bar({ label, value, suffix }) {
  const tone = toneOf(value);
  const width = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return createElement(
    "div",
    { className: "dsh-rb-bar" },
    createElement(
      "div",
      { className: "dsh-rb-bar__head" },
      createElement("span", { className: "dsh-rb-bar__lbl" }, label),
      createElement("span", { className: "dsh-rb-bar__val" }, suffix ?? pct(value)),
    ),
    createElement(
      "div",
      { className: "dsh-rb-bar__track", role: "img", "aria-label": label + " " + (suffix ?? pct(value)) },
      createElement("div", { className: "dsh-rb-bar__fill dsh-rb-bar__fill--t" + tone, style: { width: width + "%" } }),
    ),
  );
}

const BREAKDOWN_LABELS = [
  ["user", "用户态"],
  ["system", "内核态"],
  ["iowait", "等待 IO"],
  ["irq", "中断"],
  ["nice", "低优先级"],
  ["steal", "被虚拟化抢占"],
  ["idle", "空闲"],
];

function CpuSection({ cpu }) {
  const cores = Array.isArray(cpu?.cores) ? cpu.cores : [];
  const breakdown = cpu?.breakdown ?? null;
  return createElement(
    "div",
    { className: "dsh-rb-sec" },
    createElement("div", { className: "dsh-rb-sec__title" }, "CPU"),
    createElement(Bar, { label: "总占用", value: cpu?.busyPct }),
    cores.length > 0
      ? createElement(
          "div",
          { className: "dsh-rb-cores" },
          cores.map((c) =>
            createElement(
              "div",
              { className: "dsh-rb-core", key: c.id, title: "核心 " + c.id + " · " + pct(c.pct) },
              createElement("span", { className: "dsh-rb-core__lbl" }, String(c.id)),
              createElement(
                "span",
                { className: "dsh-rb-core__track" },
                createElement("span", {
                  className: "dsh-rb-core__fill dsh-rb-core__fill--t" + toneOf(c.pct),
                  style: { height: Number.isFinite(c.pct) ? Math.min(100, Math.max(2, c.pct)) + "%" : "2%" },
                }),
              ),
            ),
          ),
        )
      : null,
    breakdown
      ? createElement(
          "div",
          { className: "dsh-rb-rows" },
          BREAKDOWN_LABELS.map(([key, label]) => createElement(Row, { key, label, value: pct(breakdown[key]) })),
        )
      : createElement("div", { className: "dsh-rb-note" }, "等待第二次采样…"),
  );
}

function MemSection({ mem }) {
  if (!mem) return createElement("div", { className: "dsh-rb-sec" }, createElement("div", { className: "dsh-rb-sec__title" }, "内存"), createElement("div", { className: "dsh-rb-note" }, "无读数"));
  return createElement(
    "div",
    { className: "dsh-rb-sec" },
    createElement("div", { className: "dsh-rb-sec__title" }, "内存"),
    createElement(Bar, {
      label: "已用",
      value: mem.usedPct,
      suffix: formatBytes(mem.usedBytes) + " / " + formatBytes(mem.totalBytes) + " · " + pct(mem.usedPct),
    }),
    createElement(
      "div",
      { className: "dsh-rb-rows" },
      createElement(Row, { label: "可用", value: formatBytes(mem.availableBytes) }),
      createElement(Row, { label: "空闲", value: formatBytes(mem.freeBytes) }),
      createElement(Row, { label: "缓存/可回收", value: formatBytes(mem.cachedBytes) }),
      createElement(Row, { label: "缓冲区", value: formatBytes(mem.buffersBytes) }),
      createElement(Row, { label: "共享内存", value: formatBytes(mem.sharedBytes) }),
      createElement(Row, { label: "本进程 RSS", value: formatBytes(mem.nodeRssBytes) }),
    ),
    mem.swapTotalBytes > 0
      ? createElement(Bar, {
          label: "交换分区",
          value: mem.swapUsedPct,
          suffix: formatBytes(mem.swapUsedBytes) + " / " + formatBytes(mem.swapTotalBytes) + " · " + pct(mem.swapUsedPct),
        })
      : createElement("div", { className: "dsh-rb-note" }, "无交换分区"),
  );
}

function ProcSection({ procs }) {
  if (!procs || !procs.ready) return createElement("div", { className: "dsh-rb-sec" }, createElement("div", { className: "dsh-rb-sec__title" }, "进程"), createElement("div", { className: "dsh-rb-note" }, "采样中…"));
  const list = (title, rows, valueOf) =>
    createElement(
      "div",
      { className: "dsh-rb-proc" },
      createElement("div", { className: "dsh-rb-proc__title" }, title),
      rows.length === 0
        ? createElement("div", { className: "dsh-rb-note" }, "无数据")
        : rows.map((r) =>
            createElement(
              "div",
              { className: "dsh-rb-row dsh-rb-row--proc", key: title + r.pid },
              createElement("span", { className: "dsh-rb-row__lbl dsh-rb-row__lbl--proc", title: r.pid + " " + r.comm }, r.comm),
              createElement("span", { className: "dsh-rb-row__val" }, valueOf(r)),
            ),
          ),
    );
  return createElement(
    "div",
    { className: "dsh-rb-sec" },
    createElement("div", { className: "dsh-rb-sec__title" }, "进程"),
    list("按 CPU", procs.byCpu ?? [], (r) => pct(r.cpuPct)),
    list("按内存", procs.byMem ?? [], (r) => formatBytes(r.rssBytes)),
  );
}

function Panel({ detail, error, onRefresh }) {
  const host = detail?.host;
  const cpu = detail?.cpu;
  const load = detail?.load;
  const age = detail ? Date.now() - detail.ts : null;
  const loadRows = [
    ["1 分钟", load?.one],
    ["5 分钟", load?.five],
    ["15 分钟", load?.fifteen],
  ];
  return createElement(
    "div",
    { className: "dsh-rb-panel" },
    createElement(
      "div",
      { className: "dsh-rb-panel__head" },
      createElement("span", { className: "dsh-rb-panel__title" }, "本机资源"),
      createElement("span", { className: "dsh-rb-panel__age" }, detail ? "更新于 " + formatAge(age) : "加载中…"),
    ),
    error ? createElement("div", { className: "dsh-rb-err" }, "主机数据不可用：" + error) : null,
    detail
      ? [
          createElement(CpuSection, { key: "cpu", cpu }),
          createElement(MemSection, { key: "mem", mem: detail.mem }),
          createElement(
            "div",
            { className: "dsh-rb-sec", key: "load" },
            createElement("div", { className: "dsh-rb-sec__title" }, "负载"),
            createElement(
              "div",
              { className: "dsh-rb-rows" },
              loadRows.map(([label, v]) => createElement(Row, { key: label, label, value: Number.isFinite(v) ? v.toFixed(2) : "—" })),
              createElement(Row, {
                label: "可运行/总进程",
                value: Number.isFinite(load?.runnable) ? load.runnable + " / " + load.total : "—",
              }),
            ),
          ),
          createElement(ProcSection, { key: "proc", procs: detail.procs }),
          createElement(
            "div",
            { className: "dsh-rb-panel__foot", key: "foot" },
            createElement(
              "span",
              { className: "dsh-rb-panel__meta" },
              (host?.model ?? "未知 CPU") + " · " + (host?.cores ?? "?") + " 核 · 已运行 " + formatUptime(host?.uptimeSec),
            ),
            createElement(
              "button",
              { className: "dsh-rb-panel__btn", type: "button", onClick: onRefresh },
              "刷新",
            ),
          ),
        ]
      : createElement("div", { className: "dsh-rb-note" }, "加载中…"),
  );
}

// ---------------------------------------------------------------------------
// pill
// ---------------------------------------------------------------------------

function ResourcePill() {
  const { data, error } = useSummary();
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const rail = useRailMode(rootRef, !!data);
  const detail = useDetail(open, nonce);
  const [panelPos, setPanelPos] = useState(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fixed positioning anchored to the pill, computed from the MEASURED panel
  // height. The footer slot scrolls independently of the window, so a plain
  // absolute popover would drift; scroll is listened for in the capture phase
  // to catch nested scroll containers, which do not bubble.
  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const compute = () => {
      const root = rootRef.current && rootRef.current.getBoundingClientRect();
      const panel = panelRef.current;
      if (!root || !panel) return;
      const height = panel.offsetHeight;
      const avail = window.innerWidth - 16;
      const width = Math.min(rail ? PANEL_MIN_W : Math.max(root.width, PANEL_MIN_W), avail);
      const anchor = rail ? root.right + 8 : root.left;
      const left = Math.min(Math.max(8, anchor), Math.max(8, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(root.top - 6 - height, window.innerHeight - height - 8));
      setPanelPos((prev) => (prev && prev.top === top && prev.left === left && prev.width === width ? prev : { left, top, width }));
    };
    compute();
    let ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(compute);
      if (panelRef.current) ro.observe(panelRef.current);
    }
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, rail]);

  if (!data) return null;

  const cpuPct = data.cpu?.busyPct;
  const memPct = data.mem?.usedPct;
  const cpuTone = toneOf(cpuPct);
  const memTone = toneOf(memPct);
  // Before the first pair of samples exists, say so rather than showing 0%.
  const cpuText = isBlank(cpuPct) ? (data.available ? "—" : "无读数") : pct(cpuPct);
  const memText = isBlank(memPct) ? "—" : pct(memPct);

  const pillTitle =
    "CPU " + cpuText + " · 内存 " + memText + (data.mem ? "（" + formatBytes(data.mem.usedBytes) + " / " + formatBytes(data.mem.totalBytes) + "）" : "");

  const compact = createElement(
    "span",
    { className: "dsh-rb__rail" },
    createElement(
      "span",
      { className: "dsh-rb__railRow", key: "c" },
      "C",
      createElement("b", { className: "dsh-rb__railVal dsh-rb__railVal--t" + cpuTone }, pctShort(cpuPct)),
    ),
    createElement(
      "span",
      { className: "dsh-rb__railRow", key: "m" },
      "M",
      createElement("b", { className: "dsh-rb__railVal dsh-rb__railVal--t" + memTone }, pctShort(memPct)),
    ),
  );

  const wide = [
    createElement(
      "span",
      { className: "dsh-rb__item", key: "cpu" },
      createElement("span", { className: "dsh-rb__lbl" }, "CPU"),
      createElement(
        "span",
        { className: "dsh-rb__gauge" },
        createElement("span", {
          className: "dsh-rb__gaugeFill dsh-rb__gaugeFill--t" + cpuTone,
          style: { width: (Number.isFinite(cpuPct) ? Math.min(100, Math.max(0, cpuPct)) : 0) + "%" },
        }),
      ),
      createElement("b", { className: "dsh-rb__val" }, cpuText),
    ),
    createElement(
      "span",
      { className: "dsh-rb__item", key: "mem" },
      createElement("span", { className: "dsh-rb__lbl" }, "内存"),
      createElement(
        "span",
        { className: "dsh-rb__gauge" },
        createElement("span", {
          className: "dsh-rb__gaugeFill dsh-rb__gaugeFill--t" + memTone,
          style: { width: (Number.isFinite(memPct) ? Math.min(100, Math.max(0, memPct)) : 0) + "%" },
        }),
      ),
      createElement("b", { className: "dsh-rb__val" }, memText),
    ),
  ];

  return createElement(
    "div",
    { className: "dsh-rb__root", ref: rootRef },
    createElement(
      "button",
      {
        type: "button",
        className: "dsh-rb" + (open ? " dsh-rb--open" : ""),
        title: pillTitle,
        "aria-label": pillTitle,
        "aria-expanded": open ? "true" : "false",
        onClick: () => setOpen((v) => !v),
      },
      rail ? compact : [wide[0], wide[1], createElement("span", { className: "dsh-rb__spacer", key: "sp" }), createElement("span", { className: "dsh-rb__caret", key: "caret" }, open ? "▾" : "▴")],
    ),
    open
      ? createElement(
          "div",
          {
            className: "dsh-rb-panelHost",
            ref: panelRef,
            style: panelPos ? { left: panelPos.left + "px", top: panelPos.top + "px", width: panelPos.width + "px" } : { left: "-9999px", top: "0px", width: PANEL_MIN_W + "px" },
          },
          createElement(Panel, { detail, error, onRefresh: () => setNonce((n) => n + 1) }),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

const inject = ["slots", "locale"];

function apply(ctx) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    // Tag the stylesheet the way the client module system expects
    // (data-plugin-css), so it is attributed to this plugin rather than being
    // claimed by whichever plugin happens to materialize next.
    const selector = "style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]";
    if (document.querySelector(selector) === null) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    return () => {
      const existing = document.querySelector(selector);
      if (existing) existing.remove();
    };
  }, "dsh-resource-bar: stylesheet");

  ctx.locale?.register?.(NS, {
    zh: { title: "本机资源" },
    en: { title: "Host resources" },
  });

  ctx.slots.inject("sidebar.footer.action", () => {
    return ctx.slots.register(
      { name: "sidebar.footer.action", id: "dsh-resource-bar", order: 10, locale: NS },
      () => createElement(ResourcePill),
    );
  });
}

exports.inject = inject;
exports.apply = apply;

// Theme tokens are verified against dsh-client-ui-theme's own declarations; the
// allowlist is asserted by test/selftest-contracts.mjs so a typo cannot ship a
// silently-unstyled pill. No hardcoded colour appears below.
const CSS =
  ".dsh-rb__root{position:relative;flex:1 1 auto;width:100%;min-width:0;max-width:100%;box-sizing:border-box}" +
  // Rail geometry is declarative: it hangs off the framework's own
  // [data-sidebar-collapsed] frame attribute, so it is right from the FIRST
  // paint and cannot overflow the narrow rail the way a flex-basis:100% rule
  // does in the nowrap footer row.
  "[" + RAIL_ATTR + "] .dsh-rb__root{flex:none;width:36px;max-width:100%}" +
  "[" + RAIL_ATTR + "] .dsh-rb{justify-content:center;padding:0;height:36px;margin-bottom:0;border-radius:10px}" +
  ".dsh-rb{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;margin:0 0 4px;" +
  "border:none;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);" +
  "font-family:inherit;font-size:12px;line-height:16px;overflow:hidden;user-select:none;cursor:pointer;text-align:left}" +
  ".dsh-rb:hover{background:var(--dsw-alias-interactive-bg-active)}" +
  ".dsh-rb:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:1px}" +
  ".dsh-rb .dsh-rb__item{display:flex;align-items:center;gap:5px;white-space:nowrap;flex:none}" +
  ".dsh-rb .dsh-rb__lbl{color:var(--dsw-alias-label-secondary)}" +
  ".dsh-rb .dsh-rb__spacer{flex:1;min-width:4px}" +
  ".dsh-rb .dsh-rb__val{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:600}" +
  ".dsh-rb .dsh-rb__caret{color:var(--dsw-alias-label-tertiary);flex:none;font-size:9px;line-height:1}" +
  ".dsh-rb__gauge{display:inline-block;width:34px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden;vertical-align:middle}" +
  ".dsh-rb__gaugeFill{display:block;height:100%;border-radius:3px;transition:width .35s ease}" +
  ".dsh-rb__gaugeFill--t0,.dsh-rb-core__fill--t0{background:var(--dsw-alias-state-success-primary)}" +
  ".dsh-rb__gaugeFill--t1,.dsh-rb-core__fill--t1{background:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb__gaugeFill--t2,.dsh-rb-core__fill--t2{background:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb__rail{display:flex;flex-direction:column;align-items:center;gap:1px;width:100%}" +
  ".dsh-rb__railRow{display:flex;align-items:baseline;gap:1px;color:var(--dsw-alias-label-tertiary);font-size:8px;line-height:1.1}" +
  ".dsh-rb__railVal{font-size:10px;font-variant-numeric:tabular-nums;line-height:1.1}" +
  ".dsh-rb__railVal--t0{color:var(--dsw-alias-state-success-primary)}" +
  ".dsh-rb__railVal--t1{color:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb__railVal--t2{color:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb-panelHost{position:fixed;z-index:60}" +
  ".dsh-rb-panel{box-sizing:border-box;padding:10px 12px;border-radius:14px;background:var(--dsw-alias-bg-layer-2);" +
  "border:1px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);" +
  "font-size:12px;line-height:1.5;max-height:min(70vh,560px);overflow:auto}" +
  ".dsh-rb-panel__head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}" +
  ".dsh-rb-panel__title{font-size:13px;font-weight:600}" +
  ".dsh-rb-panel__age{color:var(--dsw-alias-label-tertiary);font-size:11px}" +
  ".dsh-rb-panel__foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;" +
  "padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3)}" +
  ".dsh-rb-panel__meta{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsh-rb-panel__btn{flex:none;cursor:pointer;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l3);" +
  "border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px}" +
  ".dsh-rb-panel__btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsh-rb-sec{margin-bottom:10px}" +
  ".dsh-rb-sec__title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-bottom:5px;letter-spacing:.04em}" +
  ".dsh-rb-note{color:var(--dsw-alias-label-tertiary);font-size:11px}" +
  ".dsh-rb-err{margin-bottom:8px;padding:5px 8px;border-radius:8px;font-size:11px;" +
  "background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb-rows{display:flex;flex-direction:column;gap:2px;margin-top:6px}" +
  ".dsh-rb-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}" +
  ".dsh-rb-row__lbl{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsh-rb-row__val{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none}" +
  ".dsh-rb-row__val--muted{color:var(--dsw-alias-label-tertiary)}" +
  ".dsh-rb-row--proc .dsh-rb-row__lbl--proc{font-family:var(--ds-font-family-code);max-width:170px}" +
  ".dsh-rb-bar{margin-bottom:6px}" +
  ".dsh-rb-bar__head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}" +
  ".dsh-rb-bar__lbl{color:var(--dsw-alias-label-secondary)}" +
  ".dsh-rb-bar__val{font-variant-numeric:tabular-nums}" +
  ".dsh-rb-bar__track{margin-top:3px;height:6px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden}" +
  ".dsh-rb-bar__fill{height:100%;border-radius:3px;transition:width .35s ease}" +
  ".dsh-rb-cores{display:flex;gap:3px;align-items:flex-end;height:34px;margin:8px 0 4px}" +
  ".dsh-rb-core{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;height:100%}" +
  ".dsh-rb-core__lbl{font-size:8px;color:var(--dsw-alias-label-tertiary);line-height:1}" +
  ".dsh-rb-core__track{flex:1;width:100%;max-width:12px;border-radius:2px;background:var(--dsw-alias-border-l3);" +
  "display:flex;align-items:flex-end;overflow:hidden}" +
  ".dsh-rb-core__fill{display:block;width:100%;border-radius:2px;transition:height .35s ease}" +
  ".dsh-rb-proc{margin-top:6px}" +
  ".dsh-rb-proc__title{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:2px}";

exports.CSS = CSS;
exports.formatBytes = formatBytes;
exports.pct = pct;
exports.toneOf = toneOf;
exports.railOf = railOf;
