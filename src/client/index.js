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
//
// Information design (revised): the panel is read at a glance, so the primary
// number of each metric is the largest thing on screen, a metric's composition
// is ONE segmented bar plus a legend instead of a column of equally-weighted
// rows, and rows that merely restate the primary number are not repeated
// (e.g. CPU "空闲" is the complement of "总占用" and is left to the legend).
// Tone carries meaning: 0 = neutral accent, 1 = warning, 2 = hot. The neutral
// tone is the blue accent, NOT the success colour — a 63%-full memory bar is
// not "success", and painting it green reads as reassurance it does not mean.

const { createElement, useEffect, useLayoutEffect, useRef, useState } = require("react");

const NS = "dsh-resource-bar";
const BASE = "/dsh-resource-bar";
const STYLE_ID = "dsh-resource-bar/style.css";

// The collapsed sidebar hands this slot ~36px, far less than the pill's
// min-content width. Rail styling is therefore declarative (keyed off the
// framework attribute in CSS) and detection mirrors it in JS.
const RAIL_ATTR = "data-sidebar-collapsed";
const PANEL_MIN_W = 288;
// Absolute readability floor for the wide layout. Kept well below any real
// expanded sidebar (~260-320px) so the panel can follow the pill exactly; the
// previous code floored the width at PANEL_MIN_W, which made a 260px sidebar
// render a 288px panel that overhung the pill it is anchored to.
const PANEL_FLOOR_W = 200;
const PANEL_MIN_H = 200;
const PANEL_MAX_H = 560;
const GAP = 8;

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

/** Compact percent for the rail and the per-core chips: at most 4 characters. */
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

/** Severity bucket for tone classes: 0 neutral accent, 1 warn, 2 hot. */
function toneOf(value) {
  if (!Number.isFinite(value)) return 0;
  if (value >= 90) return 2;
  if (value >= 70) return 1;
  return 0;
}

/** True when the host reported no reading (distinct from a real 0%). */
const isBlank = (v) => !Number.isFinite(v);

/** A share of `total`, clamped to 0..1. Returns 0 for a zero/absent total. */
function frac(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, value / total));
}

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
// primitives
// ---------------------------------------------------------------------------

/** The headline number of one metric: label, optional sub-caption, big value. */
function MetricHead({ label, sub, value, tone }) {
  return createElement(
    "div",
    { className: "dsh-rb-metric" },
    createElement("span", { className: "dsh-rb-metric__lbl" }, label),
    sub ? createElement("span", { className: "dsh-rb-metric__sub" }, sub) : null,
    createElement("b", { className: "dsh-rb-metric__val dsh-rb-metric__val--t" + tone }, value),
  );
}

/** A single-value utilisation bar. Width is dynamic geometry; colour is CSS. */
function Bar({ value, tone, ariaLabel }) {
  const width = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return createElement(
    "div",
    { className: "dsh-rb-bar", role: "img", "aria-label": ariaLabel },
    createElement("span", { className: "dsh-rb-bar__fill dsh-rb-bar__fill--t" + tone, style: { width: width + "%" } }),
  );
}

/**
 * Composition as ONE bar split into proportional segments. This replaces a
 * column of equally-weighted rows: the shape (how much is idle, how much is
 * wait-IO) is readable without reading any number.
 */
function SegBar({ parts, ariaLabel }) {
  const shown = parts.filter((p) => p.frac > 0);
  return createElement(
    "div",
    { className: "dsh-rb-seg", role: "img", "aria-label": ariaLabel },
    shown.map((p) =>
      createElement("span", {
        key: p.key,
        className: "dsh-rb-seg__p dsh-rb-seg__p--" + p.key,
        style: { width: (p.frac * 100).toFixed(3) + "%" },
      }),
    ),
  );
}

/** The legend that names each segment, with its own value. */
function Legend({ items }) {
  return createElement(
    "div",
    { className: "dsh-rb-legend" },
    items.map((it) =>
      createElement(
        "span",
        { className: "dsh-rb-legend__i", key: it.key },
        createElement("i", { className: "dsh-rb-legend__dot dsh-rb-legend__dot--" + it.key }),
        it.label + " " + it.text,
      ),
    ),
  );
}

/** One per-core mini bar, laid out as a wrapping grid of index/bar/value. */
function CoreGrid({ cores }) {
  return createElement(
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
            style: { width: (Number.isFinite(c.pct) ? Math.min(100, Math.max(0, c.pct)) : 0) + "%" },
          }),
        ),
        createElement("span", { className: "dsh-rb-core__val" }, pctShort(c.pct)),
      ),
    ),
  );
}

/** A labelled detail row. Used for genuinely independent values only. */
function Row({ label, value, className, labelClassName }) {
  return createElement(
    "div",
    { className: "dsh-rb-row" + (className ? " " + className : "") },
    createElement("span", { className: "dsh-rb-row__lbl" + (labelClassName ? " " + labelClassName : "") }, label),
    createElement("span", { className: "dsh-rb-row__val" }, value),
  );
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

const CPU_PARTS = [
  ["user", "用户态"],
  ["system", "内核态"],
  ["iowait", "等待 IO"],
  ["irq", "中断"],
  ["nice", "低优先级"],
  ["steal", "被虚拟化抢占"],
];

/** Below this share a CPU slice is noise and is dropped from the legend. */
const LEGEND_EPSILON = 0.1;

function CpuSection({ cpu }) {
  const cores = Array.isArray(cpu?.cores) ? cpu.cores : [];
  const breakdown = cpu?.breakdown ?? null;
  const busy = cpu?.busyPct;

  if (!breakdown) {
    return createElement(
      "div",
      { className: "dsh-rb-block" },
      createElement(MetricHead, { label: "CPU", value: isBlank(busy) ? "—" : pct(busy), tone: toneOf(busy) }),
      createElement(Bar, { value: busy, tone: toneOf(busy), ariaLabel: "CPU 总占用 " + pct(busy) }),
      createElement("div", { className: "dsh-rb-note" }, "等待第二次采样…"),
    );
  }

  // Idle is the complement of busy and is the largest slice on a quiet host;
  // it stays in the bar (so the bar reads as "a whole") but the legend shows
  // only the slices that carry information, plus idle for completeness.
  const parts = CPU_PARTS.map(([key, label]) => ({
    key,
    label,
    frac: frac(breakdown[key], 100),
    value: breakdown[key],
  }));
  const idleFrac = frac(breakdown.idle, 100);
  const legend = [
    ...parts.filter((p) => Number.isFinite(p.value) && p.value >= LEGEND_EPSILON),
    { key: "idle", label: "空闲", frac: idleFrac, value: breakdown.idle, text: pct(breakdown.idle) },
  ].map((p) => ({ key: p.key, label: p.label, text: pct(p.value) }));

  return createElement(
    "div",
    { className: "dsh-rb-block" },
    createElement(MetricHead, {
      label: "总占用",
      sub: cpu.coreCount ? cpu.coreCount + " 核" : null,
      value: isBlank(busy) ? "—" : pct(busy),
      tone: toneOf(busy),
    }),
    createElement(Bar, { value: busy, tone: toneOf(busy), ariaLabel: "CPU 总占用 " + pct(busy) }),
    createElement(SegBar, {
      parts: [...parts, { key: "idle", frac: idleFrac }],
      ariaLabel: "CPU 时间片构成",
    }),
    createElement(Legend, { items: legend }),
    cores.length > 0 ? createElement(CoreGrid, { cores }) : null,
  );
}

function MemSection({ mem }) {
  if (!mem) {
    return createElement(
      "div",
      { className: "dsh-rb-block" },
      createElement(MetricHead, { label: "内存", value: "—", tone: 0 }),
      createElement("div", { className: "dsh-rb-note" }, "无读数"),
    );
  }
  const total = mem.totalBytes;
  const used = mem.usedBytes;
  const cached = mem.cachedBytes;
  const available = mem.availableBytes;
  const tone = toneOf(mem.usedPct);
  // used + cached + (available - cached) = total; showing used/cached/rest makes
  // the bar read as the whole machine rather than an arbitrary fraction.
  const rest = Math.max(0, total - used - cached);
  const legend = [
    { key: "used", label: "已用", text: formatBytes(used) },
    { key: "cached", label: "缓存", text: formatBytes(cached) },
    { key: "free", label: "未用", text: formatBytes(rest) },
  ];

  return createElement(
    "div",
    { className: "dsh-rb-block" },
    createElement(MetricHead, {
      label: "已用",
      sub: formatBytes(used) + " / " + formatBytes(total),
      value: pct(mem.usedPct),
      tone,
    }),
    createElement(Bar, { value: mem.usedPct, tone, ariaLabel: "内存已用 " + pct(mem.usedPct) }),
    createElement(SegBar, {
      parts: [
        { key: "used", frac: frac(used, total) },
        { key: "cached", frac: frac(cached, total) },
        { key: "free", frac: frac(rest, total) },
      ],
      ariaLabel: "内存构成",
    }),
    createElement(Legend, { items: legend }),
    createElement(
      "div",
      { className: "dsh-rb-rows" },
      createElement(Row, { label: "可用", value: formatBytes(available) }),
      createElement(Row, { label: "本进程 RSS", value: formatBytes(mem.nodeRssBytes) }),
    ),
    mem.swapTotalBytes > 0
      ? createElement(
          "div",
          { className: "dsh-rb-sub" },
          createElement(MetricHead, {
            label: "交换分区",
            sub: formatBytes(mem.swapUsedBytes) + " / " + formatBytes(mem.swapTotalBytes),
            value: pct(mem.swapUsedPct),
            tone: toneOf(mem.swapUsedPct),
          }),
          createElement(Bar, {
            value: mem.swapUsedPct,
            tone: toneOf(mem.swapUsedPct),
            ariaLabel: "交换分区已用 " + pct(mem.swapUsedPct),
          }),
        )
      : createElement("div", { className: "dsh-rb-note" }, "无交换分区"),
  );
}

function LoadSection({ load }) {
  const items = [
    ["1 分钟", load?.one],
    ["5 分钟", load?.five],
    ["15 分钟", load?.fifteen],
  ];
  return createElement(
    "div",
    { className: "dsh-rb-block" },
    createElement("div", { className: "dsh-rb-sectitle" }, "负载"),
    createElement(
      "div",
      { className: "dsh-rb-load" },
      items.map(([label, v]) =>
        createElement(
          "span",
          { className: "dsh-rb-load__i", key: label },
          createElement("span", { className: "dsh-rb-load__lbl" }, label),
          createElement("b", { className: "dsh-rb-load__val" }, Number.isFinite(v) ? v.toFixed(2) : "—"),
        ),
      ),
      Number.isFinite(load?.runnable)
        ? createElement(
            "span",
            { className: "dsh-rb-load__i" },
            createElement("span", { className: "dsh-rb-load__lbl" }, "可运行"),
            createElement("b", { className: "dsh-rb-load__val" }, load.runnable + "/" + load.total),
          )
        : null,
    ),
  );
}

/** One ranked process list: name, a bar relative to the list's own max, value. */
function ProcList({ title, rows, valueOf, fracOf }) {
  const max = rows.reduce((n, r) => Math.max(n, fracOf(r)), 0);
  return createElement(
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
            createElement(
              "span",
              { className: "dsh-rb-row__bar" },
              createElement("span", {
                className: "dsh-rb-row__barFill",
                style: { width: (max > 0 ? (fracOf(r) / max) * 100 : 0).toFixed(1) + "%" },
              }),
            ),
            createElement("span", { className: "dsh-rb-row__val" }, valueOf(r)),
          ),
        ),
  );
}

function ProcSection({ procs }) {
  if (!procs || !procs.ready) {
    return createElement(
      "div",
      { className: "dsh-rb-block" },
      createElement("div", { className: "dsh-rb-sectitle" }, "进程"),
      createElement("div", { className: "dsh-rb-note" }, "采样中…"),
    );
  }
  // Three each keeps the panel inside the available height; the server sends
  // five and the lists are ranked, so the head is what matters.
  const byCpu = (procs.byCpu ?? []).slice(0, 3);
  const byMem = (procs.byMem ?? []).slice(0, 3);
  return createElement(
    "div",
    { className: "dsh-rb-block" },
    createElement("div", { className: "dsh-rb-sectitle" }, "进程"),
    createElement(ProcList, {
      title: "按 CPU",
      rows: byCpu,
      valueOf: (r) => pct(r.cpuPct),
      fracOf: (r) => (Number.isFinite(r.cpuPct) ? r.cpuPct : 0),
    }),
    createElement(ProcList, {
      title: "按内存",
      rows: byMem,
      valueOf: (r) => formatBytes(r.rssBytes),
      fracOf: (r) => (Number.isFinite(r.rssBytes) ? r.rssBytes : 0),
    }),
  );
}

function Panel({ detail, error, onRefresh }) {
  const host = detail?.host;
  const age = detail ? Date.now() - detail.ts : null;
  return createElement(
    "div",
    { className: "dsh-rb-panel" },
    createElement(
      "div",
      { className: "dsh-rb-panel__head" },
      createElement("span", { className: "dsh-rb-panel__title" }, "本机资源"),
      createElement("span", { className: "dsh-rb-panel__age" }, detail ? "更新于 " + formatAge(age) : "加载中…"),
      createElement("button", { className: "dsh-rb-panel__btn", type: "button", onClick: onRefresh, title: "立即刷新" }, "刷新"),
    ),
    error ? createElement("div", { className: "dsh-rb-err" }, "主机数据不可用：" + error) : null,
    detail
      ? [
          createElement(CpuSection, { key: "cpu", cpu: detail.cpu }),
          createElement("div", { className: "dsh-rb-div", key: "d1" }),
          createElement(MemSection, { key: "mem", mem: detail.mem }),
          createElement("div", { className: "dsh-rb-div", key: "d2" }),
          createElement(LoadSection, { key: "load", load: detail.load }),
          createElement("div", { className: "dsh-rb-div", key: "d3" }),
          createElement(ProcSection, { key: "proc", procs: detail.procs }),
          createElement(
            "div",
            { className: "dsh-rb-foot", key: "foot" },
            createElement(
              "span",
              { className: "dsh-rb-foot__meta" },
              (host?.model ?? "未知 CPU") + " · " + (host?.cores ?? "?") + " 核 · 已运行 " + formatUptime(host?.uptimeSec),
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
  // size. The footer slot scrolls independently of the window, so a plain
  // absolute popover would drift; scroll is listened for in the capture phase
  // to catch nested scroll containers, which do not bubble.
  //
  // Two things this deliberately does NOT do any more:
  // - it no longer floors the wide-layout width at PANEL_MIN_W. A sidebar
  //   narrower than that produced a panel wider than the pill it is anchored
  //   to, so the two edges never lined up; the width now follows the pill down
  //   to PANEL_FLOOR_W, which no expanded sidebar is narrow enough to hit.
  // - it no longer clamps `top` to 8 and lets the panel be cut off. It measures
  //   the space above and below the pill and FLIPS to the side with room,
  //   capping the height to that space so the content is never clipped.
  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const compute = () => {
      const root = rootRef.current && rootRef.current.getBoundingClientRect();
      if (!root) return;
      const availW = window.innerWidth - GAP * 2;
      // Rail: a 36px pill cannot host a readable panel, so use the minimum.
      // Wide: follow the pill exactly, down to a floor that no expanded sidebar
      // reaches — this is what keeps the panel's edges flush with the pill's.
      const width = rail ? Math.min(PANEL_MIN_W, availW) : Math.min(Math.max(root.width, PANEL_FLOOR_W), availW);
      // Rail: the pill is a 36px square, so fly the panel out to its right.
      // Wide: align the panel's left edge with the pill's.
      const anchor = rail ? root.right + GAP : root.left;
      const left = Math.min(Math.max(GAP, anchor), Math.max(GAP, window.innerWidth - width - GAP));

      // Anchor by the EDGE the panel grows away from, not by a measured height.
      // Measuring `scrollHeight` and computing `top` looks equivalent but is
      // not: on the first paint the panel has no content yet, so the height is
      // 0 and the panel is placed as if it were empty, then overflows downward
      // out of the space it was supposed to fit into. Anchoring with `bottom`
      // (when it opens upward) lets it grow into the space naturally, and the
      // height cap guarantees it can never be clipped.
      const spaceAbove = root.top - GAP * 2;
      const spaceBelow = window.innerHeight - root.bottom - GAP * 2;
      const openUp = spaceAbove >= spaceBelow;
      const maxH = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, openUp ? spaceAbove : spaceBelow));
      const pos = openUp
        ? { left, width, maxH, bottom: window.innerHeight - root.top + GAP }
        : { left, width, maxH, top: root.bottom + GAP };

      setPanelPos((prev) => {
        if (prev && prev.left === pos.left && prev.width === pos.width && prev.maxH === pos.maxH && prev.top === pos.top && prev.bottom === pos.bottom) {
          return prev;
        }
        return pos;
      });
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
    // No `detail` dependency: the anchor is derived from the pill and the
    // viewport, not from the panel's own height, so a content change cannot
    // invalidate it. Re-running on every 2s poll would also tear down and
    // recreate the ResizeObserver for nothing.
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

  const item = (key, label, value, tone, text) =>
    createElement(
      "span",
      { className: "dsh-rb__item", key },
      createElement("span", { className: "dsh-rb__lbl" }, label),
      createElement(
        "span",
        { className: "dsh-rb__gauge" },
        createElement("span", {
          className: "dsh-rb__gaugeFill dsh-rb__gaugeFill--t" + tone,
          style: { width: (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0) + "%" },
        }),
      ),
      createElement("b", { className: "dsh-rb__val dsh-rb__val--t" + tone }, text),
    );

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
      rail
        ? compact
        : [
            item("cpu", "CPU", cpuPct, cpuTone, cpuText),
            item("mem", "内存", memPct, memTone, memText),
            createElement("span", { className: "dsh-rb__spacer", key: "sp" }),
            createElement("span", { className: "dsh-rb__caret", key: "caret" }, open ? "▾" : "▴"),
          ],
    ),
    open
      ? createElement(
          "div",
          {
            className: "dsh-rb-panelHost",
            ref: panelRef,
            style: panelPos
              ? {
                  left: panelPos.left + "px",
                  width: panelPos.width + "px",
                  maxHeight: panelPos.maxH + "px",
                  // Exactly one of top/bottom is set, by which side has room.
                  ...(panelPos.top !== undefined ? { top: panelPos.top + "px" } : {}),
                  ...(panelPos.bottom !== undefined ? { bottom: panelPos.bottom + "px" } : {}),
                }
              : { left: "-9999px", top: "0px", width: PANEL_MIN_W + "px" },
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
//
// The composition segments are CATEGORY colours, not severity colours: each
// slice of a CPU/memory bar is a different kind of usage, and the legend names
// it. The single-value bars use the neutral/warn/hot tone scale instead, where
// the neutral tone is the blue accent (never the success green).
const CSS =
  ".dsh-rb__root{position:relative;flex:1 1 auto;width:100%;min-width:0;max-width:100%;box-sizing:border-box}" +
  // Rail geometry is declarative: it hangs off the framework's own
  // [data-sidebar-collapsed] frame attribute, so it is right from the FIRST
  // paint and cannot overflow the narrow rail the way a flex-basis:100% rule
  // does in the nowrap footer row.
  "[" + RAIL_ATTR + "] .dsh-rb__root{flex:none;width:36px;max-width:100%}" +
  "[" + RAIL_ATTR + "] .dsh-rb{justify-content:center;padding:0;height:36px;margin-bottom:0;border-radius:10px}" +
  // --- pill ---
  ".dsh-rb{box-sizing:border-box;display:flex;align-items:center;gap:7px;width:100%;min-width:0;padding:6px 10px;margin:0 0 4px;" +
  "border:none;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);" +
  "font-family:inherit;font-size:12px;line-height:16px;overflow:hidden;user-select:none;cursor:pointer;text-align:left}" +
  ".dsh-rb:hover{background:var(--dsw-alias-interactive-bg-active)}" +
  ".dsh-rb:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:1px}" +
  ".dsh-rb .dsh-rb__item{display:flex;align-items:center;gap:5px;white-space:nowrap;flex:none}" +
  ".dsh-rb .dsh-rb__lbl{color:var(--dsw-alias-label-secondary);font-size:11px}" +
  ".dsh-rb .dsh-rb__spacer{flex:1;min-width:4px}" +
  ".dsh-rb .dsh-rb__val{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:600;font-size:12px}" +
  ".dsh-rb .dsh-rb__val--t1{color:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb .dsh-rb__val--t2{color:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb .dsh-rb__caret{color:var(--dsw-alias-label-tertiary);flex:none;font-size:9px;line-height:1}" +
  ".dsh-rb__gauge{display:inline-block;width:38px;height:6px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden;vertical-align:middle}" +
  ".dsh-rb__gaugeFill{display:block;height:100%;border-radius:3px;transition:width .4s ease}" +
  ".dsh-rb__gaugeFill--t0{background:var(--dsw-alias-link)}" +
  ".dsh-rb__gaugeFill--t1{background:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb__gaugeFill--t2{background:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb__rail{display:flex;flex-direction:column;align-items:center;gap:1px;width:100%}" +
  ".dsh-rb__railRow{display:flex;align-items:baseline;gap:1px;color:var(--dsw-alias-label-tertiary);font-size:8px;line-height:1.1}" +
  ".dsh-rb__railVal{font-size:10px;font-variant-numeric:tabular-nums;line-height:1.1}" +
  ".dsh-rb__railVal--t0{color:var(--dsw-alias-label-primary)}" +
  ".dsh-rb__railVal--t1{color:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb__railVal--t2{color:var(--dsw-alias-state-error-primary)}" +
  // --- panel ---
  ".dsh-rb-panelHost{position:fixed;z-index:60}" +
  ".dsh-rb-panel{box-sizing:border-box;padding:12px;border-radius:14px;background:var(--dsw-alias-bg-layer-2);" +
  "border:1px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);" +
  "font-size:12px;line-height:1.45;overflow:auto;overscroll-behavior:contain}" +
  ".dsh-rb-panel__head{display:flex;align-items:center;gap:8px;margin-bottom:10px}" +
  ".dsh-rb-panel__title{font-size:13px;font-weight:600;flex:none}" +
  ".dsh-rb-panel__age{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:1;text-align:right;min-width:0;" +
  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsh-rb-panel__btn{flex:none;cursor:pointer;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l3);" +
  "border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px}" +
  ".dsh-rb-panel__btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsh-rb-div{height:1px;background:var(--dsw-alias-border-l3);margin:10px 0}" +
  ".dsh-rb-block{margin-bottom:0}" +
  ".dsh-rb-sectitle{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:6px}" +
  // --- metric headline ---
  ".dsh-rb-metric{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}" +
  ".dsh-rb-metric__lbl{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.03em;flex:none}" +
  ".dsh-rb-metric__sub{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:1;min-width:0;" +
  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}" +
  ".dsh-rb-metric__val{margin-left:auto;flex:none;font-size:18px;line-height:1.1;font-weight:600;" +
  "font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}" +
  ".dsh-rb-metric__val--t1{color:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb-metric__val--t2{color:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb-sub{margin-top:10px}" +
  // --- single-value bar ---
  ".dsh-rb-bar{height:8px;border-radius:4px;background:var(--dsw-alias-border-l3);overflow:hidden;margin-bottom:6px}" +
  ".dsh-rb-bar__fill{display:block;height:100%;border-radius:4px;transition:width .4s ease}" +
  ".dsh-rb-bar__fill--t0{background:var(--dsw-alias-link)}" +
  ".dsh-rb-bar__fill--t1{background:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb-bar__fill--t2{background:var(--dsw-alias-state-error-primary)}" +
  // --- composition bar (category colours) ---
  ".dsh-rb-seg{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-border-l3);margin-bottom:6px}" +
  ".dsh-rb-seg__p{display:block;height:100%;transition:width .4s ease}" +
  ".dsh-rb-seg__p--user,.dsh-rb-seg__p--used{background:var(--dsw-alias-link)}" +
  ".dsh-rb-seg__p--system{background:var(--dsw-alias-state-success-primary)}" +
  ".dsh-rb-seg__p--iowait,.dsh-rb-seg__p--cached{background:var(--dsw-alias-state-warn-secondary)}" +
  ".dsh-rb-seg__p--irq{background:var(--dsw-alias-state-business-primary)}" +
  ".dsh-rb-seg__p--steal{background:var(--dsw-alias-state-error-secondary)}" +
  ".dsh-rb-seg__p--idle,.dsh-rb-seg__p--free{background:var(--dsw-alias-border-l3)}" +
  // --- legend ---
  ".dsh-rb-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:8px}" +
  ".dsh-rb-legend__i{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);" +
  "font-size:11px;font-variant-numeric:tabular-nums}" +
  ".dsh-rb-legend__dot{width:7px;height:7px;border-radius:2px;flex:none}" +
  ".dsh-rb-legend__dot--user,.dsh-rb-legend__dot--used{background:var(--dsw-alias-link)}" +
  ".dsh-rb-legend__dot--system{background:var(--dsw-alias-state-success-primary)}" +
  ".dsh-rb-legend__dot--iowait,.dsh-rb-legend__dot--cached{background:var(--dsw-alias-state-warn-secondary)}" +
  ".dsh-rb-legend__dot--irq{background:var(--dsw-alias-state-business-primary)}" +
  ".dsh-rb-legend__dot--steal{background:var(--dsw-alias-state-error-secondary)}" +
  ".dsh-rb-legend__dot--idle,.dsh-rb-legend__dot--free{background:var(--dsw-alias-border-l3)}" +
  // --- per-core chips ---
  ".dsh-rb-cores{display:flex;flex-wrap:wrap;gap:5px 8px;margin-top:2px}" +
  ".dsh-rb-core{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto}" +
  ".dsh-rb-core__lbl{color:var(--dsw-alias-label-tertiary);font-size:10px;min-width:9px;text-align:right;" +
  "font-variant-numeric:tabular-nums}" +
  ".dsh-rb-core__track{display:inline-block;width:26px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden}" +
  ".dsh-rb-core__fill{display:block;height:100%;border-radius:3px;transition:width .4s ease}" +
  ".dsh-rb-core__fill--t0{background:var(--dsw-alias-link)}" +
  ".dsh-rb-core__fill--t1{background:var(--dsw-alias-state-warn-primary)}" +
  ".dsh-rb-core__fill--t2{background:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb-core__val{color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;min-width:22px}" +
  // --- rows ---
  ".dsh-rb-rows{display:flex;flex-direction:column;gap:3px}" +
  ".dsh-rb-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}" +
  ".dsh-rb-row__lbl{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsh-rb-row__val{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none}" +
  ".dsh-rb-row--proc{gap:8px;align-items:center}" +
  ".dsh-rb-row--proc .dsh-rb-row__lbl--proc{font-family:var(--ds-font-family-code);font-size:11px;flex:1;max-width:150px}" +
  ".dsh-rb-row__bar{display:inline-block;width:42px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden;flex:none}" +
  ".dsh-rb-row__barFill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-link);transition:width .4s ease}" +
  // --- load ---
  ".dsh-rb-load{display:flex;flex-wrap:wrap;gap:4px 14px}" +
  ".dsh-rb-load__i{display:inline-flex;align-items:baseline;gap:5px}" +
  ".dsh-rb-load__lbl{color:var(--dsw-alias-label-tertiary);font-size:11px}" +
  ".dsh-rb-load__val{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:12px}" +
  // --- processes ---
  ".dsh-rb-proc{margin-bottom:6px}" +
  ".dsh-rb-proc:last-child{margin-bottom:0}" +
  ".dsh-rb-proc__title{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:3px}" +
  // --- misc ---
  ".dsh-rb-note{color:var(--dsw-alias-label-tertiary);font-size:11px}" +
  ".dsh-rb-err{margin-bottom:8px;padding:5px 8px;border-radius:8px;font-size:11px;" +
  "background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}" +
  ".dsh-rb-foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;" +
  "border-top:1px solid var(--dsw-alias-border-l3)}" +
  ".dsh-rb-foot__meta{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;" +
  "text-overflow:ellipsis;white-space:nowrap}";

exports.CSS = CSS;
exports.formatBytes = formatBytes;
exports.pct = pct;
exports.toneOf = toneOf;
exports.railOf = railOf;
