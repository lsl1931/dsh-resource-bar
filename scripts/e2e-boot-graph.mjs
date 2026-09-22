// Boot-graph inspection: fetches the real index payload from a booted dsh web
// and asserts this plugin's row in `window.__DSH_BOOT__` has the shape the
// client module system requires to materialize the entry.
//
// This is the one link the in-process tests cannot cover: they exercise the
// bundle body, but only a real host proves the row that triggers it exists and
// points at a loadable resource.
const PORT = process.argv[2];
const TOKEN = process.argv[3];
if (!PORT || !TOKEN) {
  console.error("usage: node e2e-boot-graph.mjs <port> <token>");
  process.exit(2);
}
const BASE = "http://127.0.0.1:" + PORT;
const ID = "dsh-resource-bar";

let pass = 0;
let fail = 0;
const ok = (m) => (pass++, console.log("  ok  " + m));
const bad = (m) => (fail++, console.log("  FAIL " + m));
const assert = (c, m) => (c ? ok(m) : bad(m));

async function main() {
  const exchange = await fetch(BASE + "/?token=" + TOKEN, { redirect: "manual" });
  const cookie = (exchange.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  const html = await (await fetch(BASE + "/", { headers: { cookie } })).text();

  // The boot payload is injected as a plain script assignment and is NOT
  // HTML-escaped (only the JSON string values are), so capture from the marker
  // to the matching end of the statement. The exact spelling observed on a real
  // host is: globalThis["__DSH_BOOT__"] = {"rev":...,"entries":[...]}
  const marker = html.indexOf("__DSH_BOOT__");
  assert(marker >= 0, "the index injects a __DSH_BOOT__ payload");
  const start = html.indexOf("{", marker);
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"') {
      // skip the string literal
      i++;
      while (i < html.length && html[i] !== '"') {
        if (html[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert(end > 0, "the boot payload has balanced braces");
  const m = end > 0 ? [null, html.slice(start, end)] : null;
  if (!m) {
    console.log("\n  " + pass + " passed, " + fail + " failed");
    process.exit(1);
  }
  const raw = m[1];
  let boot;
  try {
    boot = JSON.parse(raw);
  } catch (error) {
    bad("the boot payload parses as JSON: " + String(error).slice(0, 120));
    console.log("\n  " + pass + " passed, " + fail + " failed");
    process.exit(1);
  }
  ok("the boot payload parses as JSON");

  const rows = Array.isArray(boot.entries) ? boot.entries : Array.isArray(boot) ? boot : [];
  assert(rows.length > 0, "the payload carries an entry list (" + rows.length + " rows)");
  const row = rows.find((r) => r && (r.id === ID || r.name === ID));
  assert(Boolean(row), "a boot row exists for " + ID);
  if (row) {
    console.log("      row: " + JSON.stringify(row));
    assert(row.id === ID, "the row id matches the plugin name");
    assert(typeof row.url === "string" && row.url.includes(ID), "the row points at this plugin's bundle resource");
    assert(row.url.includes("client.js"), "the row targets a client.js resource");
    if (row.reject) bad("the row is marked rejected: " + row.reject);
    else ok("the row is not rejected");
  }

  // The resource the row names must actually be servable.
  if (row && typeof row.url === "string") {
    const url = row.url.replace(/&amp;/g, "&");
    const res = await fetch(BASE + (url.startsWith("/") ? url : "/" + url), { headers: { cookie } });
    assert(res.status === 200, "the named bundle resource is served (" + res.status + ")");
    const body = await res.text();
    assert(body.includes('id: "' + ID + '"'), "the served resource registers this plugin id");
  }

  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("  FAIL " + String(e));
  process.exit(1);
});
