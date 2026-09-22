// Contract selftest: the official plugin rules, as executable assertions.
//
// Sourced from the ecosystem's own hard constraints (dsh-better-sidebar's
// AGENTS.md section 1) and the package-manifest/discovery rules that dsh
// validates at boot. Each rule below fails *silently or at boot* when broken,
// which is exactly why it is asserted here instead of being left to review.
//
// The theme-token check is the interesting one: it reads the REAL theme
// package's declarations and fails if this plugin's CSS references a token the
// theme does not declare. `--dsw-alias-text-accent`, for instance, does not
// exist, and a typo'd token makes the pill silently unstyled.
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClientBundle } from "./harness.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log("  ok  " + name);
};
const skip = (name, why) => console.log("  --  skip: " + name + " (" + why + ")");

// --- manifest ---------------------------------------------------------------

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

check("declares dsh.bundle.patch and the file exists", () => {
  const rel = pkg.dsh?.bundle?.patch;
  assert.ok(rel, "dsh.bundle.patch is required or the profile fails to boot");
  assert.ok(existsSync(join(ROOT, rel)), rel + " must exist");
});

check("declares dsh.client.platform === 'web'", () => {
  assert.strictEqual(pkg.dsh?.client?.platform, "web", "otherwise the browser half is silently never loaded");
});

check("exports './client' because dsh.client is declared", () => {
  assert.ok(pkg.exports?.["./client"], "declaring dsh.client without exports['./client'] throws at boot");
  assert.ok(existsSync(join(ROOT, pkg.exports["./client"])), "and the bundle must be built");
});

check("main / exports['.'] point at files that exist", () => {
  assert.ok(existsSync(join(ROOT, pkg.main)), pkg.main + " must exist");
  const dot = pkg.exports?.["."];
  const target = typeof dot === "string" ? dot : dot?.default;
  assert.ok(existsSync(join(ROOT, target)), target + " must exist");
});

check("no dependency field names a bare 'cordis' package", () => {
  // The community market hard-rejects the legacy Cordis runtime name in any of
  // these fields, even when optional. Scoped forges are fine; the bare name is
  // not.
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    assert.ok(!Object.prototype.hasOwnProperty.call(deps, "cordis"), field + " must not declare 'cordis'");
  }
});

check("no install lifecycle script can run inside the host", () => {
  const forbidden = ["preinstall", "install", "postinstall", "prepare"];
  for (const name of forbidden) {
    assert.strictEqual(pkg.scripts?.[name], undefined, "scripts." + name + " must not exist");
  }
});

check("package scripts stay inert and side-effect free", () => {
  // An allowlist, not a denylist: a new script has to be added deliberately,
  // which is the point — a stray script is how a plugin starts doing work in
  // the host. `test` runs local suites; `test:e2e` boots a throwaway DSH_HOME
  // under /tmp and never touches the real profile.
  const allowed = new Set(["build", "test", "test:e2e"]);
  for (const name of Object.keys(pkg.scripts ?? {})) {
    assert.ok(allowed.has(name), "unexpected script: " + name);
  }
  assert.strictEqual(pkg.scripts.build, "node build.mjs", "build is a local, dependency-free step");
});

check("version is an exact SemVer (no range, no tag)", () => {
  assert.match(pkg.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
});

check("name is a valid, unscoped package name", () => {
  assert.match(pkg.name, /^[a-z0-9][a-z0-9._-]*$/);
  assert.ok(!pkg.name.includes("/"), "no scope: the profile resolves it by bare name");
});

check("repository URL is credential-free HTTPS", () => {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  assert.ok(url, "a repository identity is required for the catalog backlink");
  // Accept the conventional `git+https://…(.git)` form and normalize it away
  // before checking the shape: the market compares a credential-free HTTPS
  // owner/repo, not the exact spelling.
  const normalized = url.replace(/^git\+/, "");
  assert.match(normalized, /^https:\/\/github\.com\/[^/@]+\/[^/@]+?(\.git)?$/);
  assert.ok(!/\/\/[^/]*:[^/]*@/.test(normalized), "no embedded user:password");
  assert.ok(!normalized.includes("@"), "no embedded credentials of any kind");
  const ownerRepo = normalized.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  assert.strictEqual(ownerRepo.split("/").length, 2, "exactly owner/repo");
});

check("the files whitelist ships exactly what the loader needs", () => {
  const files = pkg.files ?? [];
  for (const required of ["lib", "cordis.patch.yml"]) {
    assert.ok(files.includes(required), "files must include " + required);
  }
  assert.ok(!files.some((f) => f.startsWith("test")), "tests are not part of the published surface");
  assert.ok(!files.some((f) => f.startsWith("src")), "src is not needed at runtime");
});

check("package type is ESM, matching what lib/index.js emits", () => {
  assert.strictEqual(pkg.type, "module");
  const src = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  assert.match(src, /^export (const|function|\{)/m, "the node half really is ESM");
});

// --- bundle patch -----------------------------------------------------------

check("cordis.patch.yml mounts exactly one plugin entry under its own id", () => {
  const yml = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
  // No YAML dependency in this repo by design, so assert the shape textually —
  // it is a fixed three-line insert list.
  assert.match(yml, /^-\s*insert:/m, "top-level insert list");
  const ids = [...yml.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const names = [...yml.matchAll(/^\s*name:\s*'?([^'\s]+)'?\s*$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(ids, [pkg.name], "id must be the package name");
  assert.deepStrictEqual(names, [pkg.name], "name must resolve to the package");
});

check("the patch sets no config beside `name` (the silent no-op trap)", () => {
  // A key written beside `name:` instead of under a nested `config:` is
  // silently ignored by the loader. This plugin takes no config, so the only
  // keys present may be id and name.
  const yml = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
  for (const line of yml.split("\n")) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const m = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (!m) continue;
    assert.ok(["insert", "id", "name"].includes(m[1]), "unexpected key in patch: " + m[1]);
  }
});

check("the node half declares only hard dependencies it truly needs", () => {
  const src = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  const m = /export const inject = \[([^\]]*)\]/.exec(src);
  assert.ok(m, "inject must be declared");
  const names = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  assert.deepStrictEqual(names, ["webServer", "connection"]);
});

check("no service is read off ctx unless it is declared in inject", () => {
  // This is the rule a real boot enforces ("cannot get property X without
  // inject"). The allowlist is DERIVED from the declared inject list plus the
  // framework-provided members, so the check cannot silently bless a name: an
  // earlier version hardcoded `locale` here and therefore missed a real boot
  // failure in the Node half.
  const src = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  const declared = new Set(
    (/export const inject = \[([^\]]*)\]/.exec(src)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
  );
  // Members the framework itself puts on every context, plus this plugin's own.
  const frameworkMembers = new Set(["logger", "effect", "on", "get", "inject", "scope", "root", "ctx"]);
  const read = [...src.matchAll(/\bctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]);
  const undeclared = [...new Set(read)].filter((name) => !declared.has(name) && !frameworkMembers.has(name));
  assert.deepStrictEqual(undeclared, [], "read without declaring in inject: " + undeclared.join(", "));
});

check("the client half declares every service it reads", () => {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  const declared = (/const inject = \[([^\]]*)\]/.exec(src)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  for (const name of declared) {
    assert.ok(name.length > 0, "inject entries are well-formed");
  }
  // ctx.locale is read through the plugin context (a slot registration option
  // rather than a method call), and ctx.slots.inject is the slot entry point.
  assert.ok(declared.includes("slots"), "slots must be declared to register");
  assert.ok(declared.includes("locale"), "locale is passed to the slot registration");
  const read = [...src.matchAll(/\bctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]);
  const frameworkMembers = new Set(["logger", "effect", "on", "get", "inject", "scope", "root", "ctx"]);
  const undeclared = [...new Set(read)].filter((name) => !declared.includes(name) && !frameworkMembers.has(name));
  assert.deepStrictEqual(undeclared, [], "client half reads undeclared service(s): " + undeclared.join(", "));
});

// --- client half ------------------------------------------------------------

check("the client bundle registers through window.__ModuleLoader__.load", () => {
  const src = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  assert.match(src, /window\.__ModuleLoader__\.load\(/);
  assert.match(src, new RegExp('id: "' + pkg.name + '"'));
});

check("the client half imports nothing but the seeded platform module", () => {
  const bundle = loadClientBundle({});
  assert.deepStrictEqual(bundle.mod.inject, ["slots", "locale"], "declares its service dependencies");
  assert.strictEqual(bundle.id, pkg.name);
  const src = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  const requires = [...src.matchAll(/require\((["'][^"']+["'])\)/g)].map((m) => m[1].replace(/["']/g, ""));
  assert.deepStrictEqual([...new Set(requires)], ["react"], "only the frozen platform seed is required");
});

check("the client half declares no dsh.client.external (nothing extra to resolve)", () => {
  const ext = pkg.dsh?.client?.external;
  assert.strictEqual(ext, undefined, "an unresolvable specifier here throws at runtime");
});

check("the client half is JSX-free so no transpiler is required", () => {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  assert.ok(!/<\/[A-Za-z]/.test(src), "no JSX tags");
  assert.ok(!/=>\s*</.test(src), "no JSX expression bodies");
});

check("the stylesheet is attributed with data-plugin-css", () => {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  assert.match(src, /dataset\.pluginCss\s*=/);
  assert.match(src, /style\[data-plugin-css=/);
});

check("styles and listeners live inside ctx.effect so unload reclaims them", () => {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  const styled = /ctx\.effect\(\s*\(\)\s*=>\s*\{[\s\S]*?data-plugin-css[\s\S]*?\}\s*,\s*"/.test(src);
  assert.ok(styled, "the stylesheet installation is owned by the fiber");
  assert.match(src, /ctx\.slots\.inject\("sidebar\.footer\.action"/, "registers into the declared parent slot");
});

// --- theme tokens -----------------------------------------------------------

/** Every custom property this plugin's CSS references. */
function referencedTokens() {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  const css = src.slice(src.indexOf("const CSS ="));
  return [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+|--ds-[a-z0-9-]+)/g)].map((m) => m[1]))].sort();
}

/** Candidate locations for the theme package, newest install layout first. */
function findThemeClient() {
  const candidates = [];
  if (process.env.DSH_THEME_DIR) candidates.push(process.env.DSH_THEME_DIR);
  const home = process.env.DSH_HOME || join(process.env.HOME ?? "", ".dsh");
  candidates.push(
    join(home, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-client-ui-theme", "lib", "client.js"),
    "/home/lhm/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js",
  );
  // Also try walking up from the dsh binary that would load this plugin.
  let dir = dirname(process.execPath);
  for (let i = 0; i < 6 && dir !== "/"; i++) {
    candidates.push(join(dir, "node_modules", "@deepseek-ai", "dsh-client-ui-theme", "lib", "client.js"));
    candidates.push(join(dir, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-client-ui-theme", "lib", "client.js"));
    dir = dirname(dir);
  }
  // pnpm's content-addressed store is a last resort.
  const store = join(process.env.HOME ?? "", ".local", "share", "pnpm", "store");
  try {
    if (existsSync(store)) {
      const stack = [store];
      while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try {
          entries = readdirSync(current);
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = join(current, entry);
          if (entry === "dsh-client-ui-theme") {
            const f = join(full, "lib", "client.js");
            if (existsSync(f)) candidates.push(f);
          }
          if (stack.length < 4000 && entry.startsWith("v") && statSync(full).isDirectory()) stack.push(full);
        }
      }
    }
  } catch {
    // best effort only
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

check("CSS references only tokens this plugin invented or the theme declares", () => {
  const used = referencedTokens();
  assert.ok(used.length > 0, "the pill is themed, not naked");

  // The plugin's own component-local properties, if any, would be listed here.
  const local = new Set([]);
  const themeClient = findThemeClient();
  if (themeClient === null) {
    skip("theme declarations cross-check", "theme package not locatable on this machine");
    // Still enforce the documented trap list, which is version-independent.
    assert.ok(!used.includes("--dsw-alias-text-accent"), "this token does not exist in any dsh release");
    assert.ok(!used.includes("--dsw-font-mono"), "this token does not exist; use --ds-font-family-code");
    assert.ok(!used.includes("--dsw-hovercard-bg"), "component-local to HoverCard, not a theme token");
    return;
  }
  const declared = new Set(
    [...readFileSync(themeClient, "utf8").matchAll(/(--dsw-[a-z0-9-]+|--ds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  assert.ok(declared.size > 100, "theme declarations were actually parsed");
  const missing = used.filter((t) => !declared.has(t) && !local.has(t));
  assert.deepStrictEqual(missing, [], "undeclared theme token(s): " + missing.join(", "));
});

check("CSS hardcodes no colour literal", () => {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  const css = src.slice(src.indexOf("const CSS ="));
  const literals = [
    ...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...css.matchAll(/\brgba?\(/g),
    ...css.matchAll(/\bhsla?\(/g),
  ].map((m) => m[0]);
  assert.deepStrictEqual(literals, [], "colour must come from tokens: " + literals.join(", "));
});

check("CSS uses the documented rail attribute, not the slot's wide prop", () => {
  const src = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  assert.match(src, /const RAIL_ATTR = "data-sidebar-collapsed"/);
  assert.match(src, /RAIL_ATTR \+ "\] \.dsh-rb/);
  assert.ok(!/wide\b.*useState|props\.wide/.test(src), "rail state is never taken from the slot prop");
});

// --- repo hygiene -----------------------------------------------------------

check("LICENSE is present and the manifest agrees", () => {
  assert.ok(existsSync(join(ROOT, "LICENSE")));
  assert.strictEqual(pkg.license, "MIT");
});

check("README documents install, behaviour and known limits", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const section of ["安装", "已知边界"]) {
    assert.ok(readme.includes(section), "README must document: " + section);
  }
});

check("lib/ is committed so installing needs no build step", () => {
  // The market forbids install lifecycle scripts, so a consumer cannot be asked
  // to run build.mjs. lib/ must be present and must match src/, otherwise the
  // git-installed plugin would serve stale code.
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  const lines = gitignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(!lines.includes("lib/") && !lines.includes("lib"), "lib/ must not be gitignored");
  assert.ok(lines.includes("node_modules/"), "test-only deps are excluded");
});

check("lib/ is in sync with src/ (no stale build can be shipped)", () => {
  const built = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  const source = readFileSync(join(ROOT, "src", "index.js"), "utf8");
  assert.strictEqual(built, source, "lib/index.js must be a verbatim copy of src/index.js");

  const clientSource = readFileSync(join(ROOT, "src", "client", "index.js"), "utf8");
  const clientBundle = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  assert.ok(clientBundle.includes(clientSource), "lib/client.js must wrap the current client source");
  assert.match(clientBundle.slice(0, 120), /window\.__ModuleLoader__\.load\(/, "factory wrapper is first");
});

check("no absolute machine-specific path leaked into the shipped halves", () => {
  for (const rel of ["lib/index.js", "lib/client.js", "cordis.patch.yml"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const hits = [...src.matchAll(/\/home\/[a-z0-9_-]+/gi)].map((m) => m[0]);
    assert.deepStrictEqual(hits, [], rel + " must not hardcode a home directory");
  }
});

console.log("\nselftest-contracts: " + passed + " checks passed");
