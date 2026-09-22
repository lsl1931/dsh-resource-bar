// Build dsh-resource-bar (zero build dependencies): emits
// - lib/index.js  (Node half, verbatim copy of src/index.js)
// - lib/client.js (browser half wrapped in the factory-form CJS the dsh
//   client-modules system registers: window.__ModuleLoader__.load({id,factory}))
//
// The client source is JSX-free and already in the exact export shape the
// loader expects (exports.inject / exports.apply), so no transpiler is needed.
// Keeping the build this small is deliberate: the plugin ships as a plain
// profile bundle and must not drag a toolchain into the host.
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const libDir = join(root, "lib");
mkdirSync(libDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const id = pkg.name;

// 1) Node half: plain ESM — copy verbatim.
copyFileSync(join(root, "src", "index.js"), join(libDir, "index.js"));
console.log("lib/index.js written");

// 2) Client half: wrap the CJS body in the ModuleLoader factory form.
const body = readFileSync(join(root, "src", "client", "index.js"), "utf8");
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`;
writeFileSync(join(libDir, "client.js"), wrapped);
console.log("lib/client.js written");
