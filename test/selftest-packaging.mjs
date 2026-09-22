// Packaging selftest: verifies what a CONSUMER actually receives.
//
// The repo manifest is not what gets installed — `npm pack` / a git install
// produces a filtered tarball, and that filtered surface is what the ecosystem's
// hard constraints apply to. In particular the install-lifecycle-script ban is
// checked against the PACKED manifest, because a repo manifest may legitimately
// carry a script that the published surface strips.
//
// This is also the only check that proves the tarball is self-sufficient: the
// plugin is installed from a git/tarball URL with no build step, so a missing
// lib/ or cordis.patch.yml would make `dsh plugin add` fail for every consumer.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};

const dir = mkdtempSync(join(tmpdir(), "dsh-rb-pack-"));
let tgz = null;
let manifest = null;
let files = [];

try {
  execFileSync("npm", ["pack", "--pack-destination", dir], { cwd: ROOT, stdio: "pipe" });
  tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  assert.ok(tgz, "npm pack produced a tarball: " + tgz);
  files = execFileSync("tar", ["-tzf", tgz], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);
  execFileSync("tar", ["-xzf", tgz, "package/package.json"], { cwd: dir, stdio: "pipe" });
  manifest = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8"));

  check("the tarball name matches the package name and version", () => {
    assert.strictEqual(tgz, pkg.name + "-" + pkg.version + ".tgz");
  });

  check("the tarball ships everything the loader needs, and nothing else", () => {
    for (const required of [
      "package/package.json",
      "package/lib/index.js",
      "package/lib/client.js",
      "package/cordis.patch.yml",
      "package/README.md",
      "package/LICENSE",
    ]) {
      assert.ok(files.includes(required), "tarball must contain " + required);
    }
    // Exactly the six files above: an accidental seventh means something leaked
    // into the published surface.
    assert.strictEqual(files.length, 6, "unexpected tarball contents:\n  " + files.join("\n  "));
  });

  check("test-only dependencies and sources are NOT published", () => {
    const leaked = files.filter(
      (f) =>
        f.startsWith("package/test/") ||
        f.startsWith("package/node_modules/") ||
        f.startsWith("package/src/") ||
        f.startsWith("package/scripts/") ||
        f.includes("package-lock.json") ||
        f.includes(".github/") ||
        f.endsWith(".tgz"),
    );
    assert.deepStrictEqual(leaked, [], "leaked into the tarball: " + leaked.join(", "));
  });

  check("the PACKED manifest declares no bare 'cordis' dependency", () => {
    // The market hard-rejects the legacy Cordis runtime name in any of these
    // fields, even when optional.
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = manifest[field];
      if (!deps) continue;
      assert.ok(!Object.keys(deps).includes("cordis"), field + " must not declare cordis");
    }
  });

  check("the PACKED manifest declares no install lifecycle script", () => {
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      assert.strictEqual(manifest.scripts?.[name], undefined, "packed scripts." + name + " must be absent");
    }
  });

  check("the packed client.js is loadable as shipped (no build step required)", () => {
    execFileSync("tar", ["-xzf", tgz, "package/lib/client.js", "package/lib/index.js"], { cwd: dir, stdio: "pipe" });
    const client = readFileSync(join(dir, "package", "lib", "client.js"), "utf8");
    assert.match(client.slice(0, 120), /window\.__ModuleLoader__\.load\(/, "shipped bundle is already in factory form");
    assert.ok(client.includes("sidebar.footer.action"), "and targets the expected slot");
    const server = readFileSync(join(dir, "package", "lib", "index.js"), "utf8");
    assert.match(server, /export function apply/, "shipped node half is runnable ESM");
    assert.match(server, /export const inject/, "and declares its dependencies");
    assert.ok(!existsSync(join(dir, "package", "src")), "src/ is not needed at runtime");
  });

  check("the packed patch file is relative and self-contained", () => {
    execFileSync("tar", ["-xzf", tgz, "package/cordis.patch.yml"], { cwd: dir, stdio: "pipe" });
    const yml = readFileSync(join(dir, "package", "cordis.patch.yml"), "utf8");
    assert.match(yml, new RegExp("name:\\s*'?" + pkg.name), "mounts this package");
    assert.ok(!yml.includes(ROOT), "no absolute build path leaked into the shipped patch");
  });

  check("the packed README documents install and known limits", () => {
    execFileSync("tar", ["-xzf", tgz, "package/README.md"], { cwd: dir, stdio: "pipe" });
    const readme = readFileSync(join(dir, "package", "README.md"), "utf8");
    assert.ok(readme.includes("安装"), "install section present");
    assert.ok(readme.includes("已知边界"), "known-limits section present");
  });
} finally {
  if (tgz === null) {
    console.error("  !! npm pack failed; packaging checks could not run");
  }
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
}

console.log("\nselftest-packaging: " + passed + " checks passed");
