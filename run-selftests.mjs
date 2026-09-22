// Full selftest runner: builds, then runs every suite in its own process so one
// suite's globals (DOM, fake timers) can never leak into another.
//
// Exits non-zero on the first failure, with the failing suite named.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(ROOT, "test");

// Build first: the suites test lib/, not src/, because lib/ is what the host
// loads (and the wrapper build.mjs emits is itself under test).
const build = spawnSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, encoding: "utf8" });
if (build.status !== 0) {
  process.stderr.write(build.stdout ?? "");
  process.stderr.write(build.stderr ?? "");
  console.error("build failed");
  process.exit(1);
}

// Explicit order: cheap pure suites first so a basic break is reported before
// the slower live/IO suites run.
const ORDER = [
  "selftest-parse.mjs",
  "selftest-failure.mjs",
  "selftest-timers.mjs",
  "selftest-routes.mjs",
  "selftest-contracts.mjs",
  "selftest-client.mjs",
  "selftest-live.mjs",
  "selftest-integration.mjs",
  "selftest-perf.mjs",
];

const present = readdirSync(TEST_DIR).filter((f) => f.startsWith("selftest-") && f.endsWith(".mjs"));
const missing = present.filter((f) => !ORDER.includes(f));
if (missing.length > 0) {
  // A suite that exists but is not in ORDER would silently never run.
  console.error("these suites exist but are not in the runner's ORDER: " + missing.join(", "));
  process.exit(1);
}

let failed = 0;
const results = [];
for (const suite of ORDER) {
  process.stdout.write("\n=== " + suite + " ===\n");
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(TEST_DIR, suite)], { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
  const ms = Date.now() - started;
  results.push({ suite, status: run.status, ms });
  if (run.status !== 0) {
    failed += 1;
    console.error("\n!! " + suite + " FAILED (exit " + run.status + ")");
    break;
  }
}

process.stdout.write("\n=== summary ===\n");
for (const r of results) {
  process.stdout.write((r.status === 0 ? "  pass  " : "  FAIL  ") + r.suite.padEnd(30) + (r.ms / 1000).toFixed(1) + "s\n");
}
const total = results.reduce((n, r) => n + r.ms, 0);
process.stdout.write("  " + results.length + "/" + ORDER.length + " suites passed in " + (total / 1000).toFixed(1) + "s\n");

if (failed > 0) {
  console.error("\n" + failed + " suite(s) failed");
  process.exit(1);
}
console.log("\nALL SUITES PASSED");
