// webview-ui/src/utils/log.ts
//
// L-2 fix: lightweight logger for the webview side.
//
// The host extension has a centralized `src/logger.ts` that goes via
// vscode.window.createOutputChannel(). The webview is a separate
// runtime (an iframe-like context with no `vscode` API), so it can't
// import the host logger directly. This module gives the webview a
// matching API surface — `log.info / log.warn / log.error / log.debug`
// — so we have one place to (a) silence debug logs in production
// builds, (b) ship logs to the host via postMessage if we later want
// a unified extension-output view, (c) prefix everything consistently.
//
// Today: thin wrapper around console.*, with debug gated by a
// best-effort dev-mode detection. Tomorrow: a single edit here flips
// webview logs into the host's outputChannel via a `webviewLog`
// host-message; no caller has to change.
//
// Migration: replace `console.warn(...)` / `console.error(...)` /
// `console.log(...)` in webview-ui code with `log.warn(...)` etc.
//
// Why no `import.meta.env.DEV`: the webview-ui tsconfig has
// `module: "ESNext"` which permits `import.meta`, but if this file is
// ever pulled into a compile step that targets CommonJS (for example,
// a host-side tooling step that accidentally crosses the workspace
// boundary), `import.meta` raises TS1470. Detecting dev mode via
// globalThis instead works under any module system, costs one extra
// check, and produces identical runtime behavior.
/**
 * Best-effort dev-mode detection. Tries multiple known signals so this
 * works under Vite (window.__DEV__ / Vite-injected globals), under
 * Node + Vitest (process.env.NODE_ENV), and falls back to false in
 * production webview bundles where neither is set.
 *
 * Stays a const because the answer doesn't change after module load.
 */
const isDev = (() => {
    try {
        // Common bundler-injected dev flag.
        const g = globalThis;
        if (typeof g.__DEV__ === 'boolean')
            return g.__DEV__;
        // Node-style dev/test env (Vitest sets NODE_ENV=test).
        const nodeEnv = g.process?.env?.NODE_ENV;
        if (nodeEnv === 'development' || nodeEnv === 'test')
            return true;
        return false;
    }
    catch {
        return false;
    }
})();
const PREFIX = '[nexus-webview]';
export const log = {
    /** General-purpose info. Surfaces in dev; quiet in prod. */
    info: (...args) => {
        if (isDev) {
            // eslint-disable-next-line no-console
            console.log(PREFIX, ...args);
        }
    },
    /** Same as info, kept for parity with host logger naming. */
    debug: (...args) => {
        if (isDev) {
            // eslint-disable-next-line no-console
            console.debug(PREFIX, ...args);
        }
    },
    /** Warnings: surface in both dev and prod. */
    warn: (...args) => {
        // eslint-disable-next-line no-console
        console.warn(PREFIX, ...args);
    },
    /** Errors: surface in both dev and prod. */
    error: (...args) => {
        // eslint-disable-next-line no-console
        console.error(PREFIX, ...args);
    }
};
//# sourceMappingURL=log.js.map