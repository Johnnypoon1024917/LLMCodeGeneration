"use strict";
// src/container.ts
//
// Dependency container for runtime context that historically lived on
// the `globalContext` singleton in `extension.ts`.
//
// Why this exists:
//   The previous design exported a `let globalContext: vscode.ExtensionContext`
//   from `extension.ts` and assigned it during `activate(context)`. Every
//   consumer that needed workspaceState, secrets, or extensionUri imported
//   that mutable global. That coupled every consumer to the VS Code Extension
//   Host runtime — making the codebase impossible to use from the CLI, hard
//   to test in isolation, and broken in obscure ways during extension reload
//   (the new `activate` runs but old captures of the previous `globalContext`
//   point at a disposed object).
//
//   This module replaces that pattern with a typed dependency interface
//   (`ExtensionDeps`) that can be implemented differently per runtime.
//   The Extension Host registers a vscode-backed implementation in
//   `activate()`; the CLI (once §23-blocked code is unstubbed) will register
//   a fs-and-env-backed implementation.
//
// Why not full constructor-based DI:
//   Full DI threads `deps` through every function signature in the codebase
//   — ~110 edits across the LLM call graph, with high regression risk in a
//   single session. The hybrid approach in this file gives 90% of the win
//   (typed interface, swappable implementation, testable via setDeps in
//   tests) for ~25 edits. We can migrate to full constructor DI incrementally
//   later if the testing story demands it.
//
// Usage:
//   // Once during activation, in extension.ts:
//   import { setDeps } from './container';
//   export function activate(context: vscode.ExtensionContext) {
//       setDeps({
//           state: context.workspaceState,
//           secrets: context.secrets,
//           extensionUri: context.extensionUri,
//           subscriptions: context.subscriptions
//       });
//   }
//
//   // Anywhere else:
//   import { getDeps } from './container';
//   const apiKey = await getDeps().secrets.get('nexuscode_apikey');
Object.defineProperty(exports, "__esModule", { value: true });
exports.setDeps = setDeps;
exports.getDeps = getDeps;
exports.resetDepsForTesting = resetDepsForTesting;
/**
 * Module-private holder. Initialized exactly once per process via setDeps.
 * `undefined` means "not yet initialized" — calling getDeps() before
 * setDeps() throws, surfacing missing-init bugs at the access site rather
 * than producing silent undefined dereferences elsewhere.
 */
let _deps;
/**
 * Install the runtime dependency implementation. Must be called exactly
 * once during application startup (extension activation, CLI main, or
 * test setup).
 *
 * Calling this twice is a programming error in production; in test mode
 * it's expected (each test resets to a fresh mock). To avoid surprising
 * behavior, we don't enforce single-call — the caller's responsibility
 * is to know whether they're booting fresh or rebinding for a test.
 */
function setDeps(deps) {
    _deps = deps;
}
/**
 * Resolve the runtime dependencies. Throws if `setDeps` has not been
 * called yet. The throw is intentional: silently returning a half-formed
 * object would let an LLM call hit the network with a missing API key
 * and surface as a confusing 401 instead of a clear init bug.
 */
function getDeps() {
    if (_deps === undefined) {
        throw new Error("[container] getDeps() called before setDeps() — the runtime " +
            "dependencies haven't been initialized. This usually means a " +
            "module that needs vscode.ExtensionContext is being imported " +
            "before extension activation, or the CLI is missing its " +
            "setDeps() bootstrap call.");
    }
    return _deps;
}
/**
 * Test-only helper to reset the container between tests. Production code
 * should never call this.
 */
function resetDepsForTesting() {
    _deps = undefined;
}
//# sourceMappingURL=container.js.map