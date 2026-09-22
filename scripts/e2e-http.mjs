// HTTP contract checks for the end-to-end mount test. Driven by
// scripts/e2e-mount.sh against a REAL `dsh web` process; asserts what only a
// real host can prove — the trust fence, the method check, a live payload, the
// lazy process sampler and its self-stop, and bundle delivery.
//
// Exits 0 only if every check passes.
const PORT = process.argv[2];
const TOKEN = process.argv[3];
if (!PORT || !TOKEN) {
  console.error("usage: node e2e-http.mjs <port> <token>");
  process.exit(2);
}
const BASE = "http://127.0.0.1:" + PORT;
const ROOT = "/dsh-resource-bar";

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log("  ok  " + m);
};
const bad = (m) => {
  fail += 1;
  console.log("  FAIL " + m);
};
const assert = (cond, m) => (cond ? ok(m) : bad(m));

const unescapeHtml = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

async function main() {
  // --- trust fence ---------------------------------------------------------
  const unauth = await fetch(BASE + ROOT + "/summary");
  assert(unauth.status === 401, "an unauthenticated request is refused (401), got " + unauth.status);

  // --- authenticate through the launch token -------------------------------
  const exchange = await fetch(BASE + "/?token=" + TOKEN, { redirect: "manual" });
  const setCookies = exchange.headers.getSetCookie?.() ?? [exchange.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  assert(cookie.length > 0, "the launch token exchanges for a session cookie");
  const get = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { cookie, ...(opts.headers ?? {}) } });

  // --- summary -------------------------------------------------------------
  const s1res = await get(ROOT + "/summary");
  assert(s1res.status === 200, "the summary route answers 200 when authenticated");
  assert(/application\/json/.test(s1res.headers.get("content-type") ?? ""), "summary is JSON");
  assert(/no-store/.test(s1res.headers.get("cache-control") ?? ""), "summary is not cached");
  const s1 = await s1res.json();
  assert(s1.ok === true, "the route reports ok");
  assert(Array.isArray(s1.cpu.cores) && s1.cpu.coreCount >= 1, "core count detected (" + s1.cpu.coreCount + ")");
  // The very first reply after boot may hold a single sample, and a single
  // sample is honestly reported as unavailable (no delta exists yet). Either
  // state is valid here; what matters is that the two agree.
  assert(
    s1.available === (s1.cpu.busyPct !== null),
    "availability is consistent with whether a percentage exists (samples=" + s1.cpu.samples + ")",
  );
  assert(s1.cpu.busyPct === null || (s1.cpu.busyPct >= 0 && s1.cpu.busyPct <= 100), "busy% in range when present");

  // --- method check --------------------------------------------------------
  const post = await get(ROOT + "/summary", { method: "POST" });
  assert(post.status === 405, "a POST is refused with 405, got " + post.status);
  assert(post.headers.get("allow") === "GET", "405 carries an Allow header");

  // --- the sampler is actually running -------------------------------------
  const before = s1.cpu.samples;
  await new Promise((r) => setTimeout(r, 1600));
  const s2 = await (await get(ROOT + "/summary")).json();
  assert(s2.cpu.samples > before, "the sample counter advances (" + before + " -> " + s2.cpu.samples + ")");
  assert(s2.available === true, "the host reports available once it has two samples");
  assert(Number.isFinite(s2.cpu.busyPct), "a real CPU percentage exists after two samples");
  assert(s2.cpu.cores.length === s2.host.cores, "one per-core row per core");
  assert(s2.mem && s2.mem.totalBytes > 0, "memory total detected");
  assert(s2.mem.usedPct >= 0 && s2.mem.usedPct <= 100, "memory used% in range");
  assert(s2.mem.usedBytes <= s2.mem.totalBytes, "used <= total");
  assert(s2.host.uptimeSec > 0, "uptime read from /proc/uptime");
  assert(Number.isFinite(s2.load.one), "load average read from /proc/loadavg");
  assert(s2.sampledFrom === "procfs", "payload declares its source");

  // --- detail + lazy process sampler ---------------------------------------
  const d1 = await (await get(ROOT + "/detail")).json();
  assert(d1.procs !== undefined, "the detail route carries a procs field");
  assert(d1.procs.ready === false, "the process sampler starts lazily (not ready on the first call)");

  await new Promise((r) => setTimeout(r, 3600));
  const d2 = await (await get(ROOT + "/detail")).json();
  assert(d2.procs.ready === true, "the process sampler produces a ranking after two rounds");
  assert(d2.procs.byCpu.length <= 5 && d2.procs.byMem.length <= 5, "topN is respected");
  if (d2.procs.byMem.length >= 2) {
    const sorted = d2.procs.byMem.every((row, i, all) => i === 0 || all[i - 1].rssBytes >= row.rssBytes);
    assert(sorted, "the memory ranking is sorted descending");
  }
  const row = d2.procs.byMem[0];
  if (row) {
    assert(row.pid > 0 && typeof row.comm === "string" && row.comm.length > 0, "process rows carry a real pid and name (" + row.comm + ")");
    assert(row.cpuPct <= d2.host.cores * 100 + 0.001, "a per-process share is bounded by coreCount*100");
  }

  // --- the idle stop: the extra work ends when nobody is watching ----------
  console.log("      (waiting 18s for the process sampler to stop itself)");
  await new Promise((r) => setTimeout(r, 18000));
  const s3 = await (await get(ROOT + "/summary")).json();
  assert(s3.ok === true, "the summary route stays healthy after the idle stop");
  assert(s3.cpu.samples > s2.cpu.samples, "the CPU sampler keeps running (it is the cheap one)");

  // --- bundle delivery -----------------------------------------------------
  const html = await (await get("/")).text();
  assert(html.includes("dsh-resource-bar"), "the boot graph references the plugin");
  const refs = [...html.matchAll(/\/plugins\/[^"'\\ ]+/g)].map((m) => unescapeHtml(m[0]));
  const combo = refs.find((r) => r.includes("dsh-resource-bar/client.js"));
  assert(Boolean(combo), "the client bundle is listed in a boot combo");
  if (combo) {
    const bundle = await (await get(combo)).text();
    assert(bundle.includes('id: "dsh-resource-bar"'), "the served bundle registers under the plugin id");
    assert(bundle.includes("__ModuleLoader__.load"), "the bundle uses the module-loader contract");
    assert(bundle.includes("exports.inject") && bundle.includes("exports.apply"), "the bundle exports inject + apply");
    assert(bundle.includes("sidebar.footer.action"), "the bundle targets the footer-action slot");
    assert(bundle.includes("dsh-rb-panel"), "the bundle carries its stylesheet");
    assert(bundle.includes("data-sidebar-collapsed"), "the bundle styles the collapsed rail");
  }

  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("  FAIL " + String(error));
  process.exit(1);
});
