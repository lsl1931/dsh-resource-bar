// Shared test harness: load the BUILT bundles the way the real consumers do,
// with no test-only re-implementation of the plugin's own logic.
//
// - The Node half is imported as plain ESM (that IS its production form).
// - The client half is evaluated from `lib/client.js` through the
//   `window.__ModuleLoader__` contract, so the wrapper build.mjs emits is under
//   test too. `react` resolves to the real React, because component behaviour
//   (state, effects, event handlers) is what we need to exercise.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);

/** Load the built client bundle through the official ModuleLoader contract. */
export function loadClientBundle(overrides = {}) {
  const src = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  let factory = null;
  let registeredId = null;
  const react = overrides.react ?? require_("react");
  const requireShim = (id) => {
    if (id === "react") return react;
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
    return require_(id);
  };
  const windowStub = {
    __ModuleLoader__: {
      load: ({ id, factory: f }) => {
        registeredId = id;
        factory = f;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1440,
    innerHeight: 900,
    ...(overrides.window ?? {}),
  };
  new Function(
    "window",
    "document",
    "ResizeObserver",
    "MutationObserver",
    "fetch",
    "require",
    "exports",
    "module",
    src,
  )(
    windowStub,
    overrides.document ?? globalThis.document,
    overrides.ResizeObserver ?? globalThis.ResizeObserver,
    overrides.MutationObserver ?? globalThis.MutationObserver,
    overrides.fetch ?? globalThis.fetch,
    requireShim,
    {},
    {},
  );
  if (factory === null) throw new Error("client bundle registered no factory");
  const mod = factory(requireShim);
  return { mod, id: registeredId, react };
}

/** Minimal fake harness Context for driving the real apply(). */
export function makeContext(opts = {}) {
  const effects = [];
  const routes = [];
  const warns = [];
  const registered = [];
  let disposed = false;
  const slots = {
    /** Registrations recorded as { options, component }. */
    entries: [],
    /** Slot names `inject` was called for. */
    injected: [],
    inject(name, callback) {
      this.injected.push(name);
      // Mirrors the real contract: the callback publishes the registration and
      // its return value is the disposer.
      const result = callback();
      return () => {
        if (typeof result === "function") result();
      };
    },
    register(options, component) {
      this.entries.push({ options, component });
      return undefined;
    },
  };
  const ctx = {
    logger: { warn: (m) => warns.push(String(m)), info() {}, debug() {} },
    get(name) {
      if (opts.provide && Object.prototype.hasOwnProperty.call(opts.provide, name)) return opts.provide[name];
      if (name === "slots") return slots;
      if (name === "locale") return ctx.locale;
      return undefined;
    },
    effect(fn, label) {
      const dispose = fn();
      const entry = { label, dispose };
      effects.push(entry);
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    webServer: {
      register(route) {
        routes.push(route);
        registered.push(route.path);
        return () => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        };
      },
    },
    slots,
    locale: opts.locale ?? {
      register(namespace, dict) {
        ctx._locales = { ...(ctx._locales ?? {}), [namespace]: dict };
      },
    },
    _routes: routes,
    _effects: effects,
    _warns: warns,
    _slots: slots,
    _locales: null,
    _dispose() {
      disposed = true;
      while (effects.length) {
        const e = effects.pop();
        try {
          if (typeof e.dispose === "function") e.dispose();
        } catch (error) {
          warns.push("dispose failed: " + String(error));
        }
      }
    },
    get _disposed() {
      return disposed;
    },
  };
  return ctx;
}

/** Minimal request/response doubles for route handlers. */
export function fakeExchange({ method = "GET", url = "/", headers = {} } = {}) {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    ended: false,
    writeHead(status, hdrs) {
      this.statusCode = status;
      this.headers = hdrs ?? {};
    },
    end(body) {
      this.ended = true;
      if (body !== undefined) chunks.push(String(body));
    },
    get body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
  return { req: { method, url, headers }, res };
}

/** Run every registered route handler and return them keyed by path. */
export function routeMap(ctx) {
  const map = new Map();
  for (const route of ctx._routes) map.set(route.path, route);
  return map;
}

/** Install a happy-dom window as the global DOM for a test file. */
export async function installDom({ url = "http://localhost/", width = 1440, height = 900 } = {}) {
  const { Window } = await import("happy-dom");
  const w = new Window({ url, width, height });
  const names = [
    "window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent",
    "KeyboardEvent", "MutationObserver", "ResizeObserver", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "CustomEvent",
  ];
  for (const name of names) {
    if (w[name] === undefined) continue;
    Object.defineProperty(globalThis, name, { value: w[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return w;
}

/** Flush pending microtasks and let React commit. */
export async function settle(times = 3) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
