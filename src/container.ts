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

import type * as vscode from 'vscode';

/**
 * A read-mostly key-value config source.
 *
 * Why this exists:
 *   `getLLMConfig()` historically called `vscode.workspace.getConfiguration('nexuscode')`
 *   directly. That coupled it to the Extension Host runtime — the CLI couldn't
 *   call any LLM function without crashing because `vscode.workspace` doesn't
 *   exist in `node`. By moving config reads behind this interface, the IDE
 *   provides a `VSCodeConfigSource` (wrapping the vscode API) and the CLI
 *   provides its own implementation reading env vars + .nexus/cli.json.
 *
 *   The `update` method is OPTIONAL because not every runtime can persist
 *   config changes. The IDE can (it writes to user/workspace settings.json).
 *   The CLI usually can't / shouldn't (no obvious place to write to). Callers
 *   that need to update must check whether `update` is defined.
 */
export interface ConfigSource {
    /** Get a value, returning the provided default if missing. */
    get<T>(key: string, defaultValue: T): T;
    /** Get a value, returning undefined if missing. */
    get<T>(key: string): T | undefined;
    /**
     * Persist a value back to the underlying config store.
     * Optional — runtimes that can't persist (e.g. CLI) omit this.
     */
    update?(key: string, value: unknown): Promise<void>;
}

/**
 * Runtime services every consumer of "the extension context" needs.
 *
 * This is the contract — implementations can come from VS Code, from a
 * CLI shim that reads the filesystem, or from a test mock that stores
 * everything in memory.
 */
export interface ExtensionDeps {
    /**
     * Persistent key-value storage scoped to the current workspace.
     * In VS Code: `context.workspaceState`.
     * In CLI: a filesystem-backed Memento implementation.
     */
    readonly state: vscode.Memento;

    /**
     * Secret storage (encrypted at rest in VS Code).
     * In VS Code: `context.secrets`.
     * In CLI: an env-var-backed read-only SecretStorage shim.
     */
    readonly secrets: vscode.SecretStorage;

    /**
     * Root URI of the installed extension. Used to resolve webview
     * resources (CSS, JS bundles).
     * In VS Code: `context.extensionUri`.
     * In CLI: not meaningful; can be a placeholder URI.
     */
    readonly extensionUri: vscode.Uri;

    /**
     * Subscriptions array for resources whose lifetime should match
     * the extension's. Calling `.push(disposable)` ensures `dispose()`
     * gets called at extension shutdown.
     * In VS Code: `context.subscriptions`.
     * In CLI: a no-op array (process exit cleans up).
     */
    readonly subscriptions: { dispose(): unknown }[];

    /**
     * Read-mostly source for the `nexuscode.*` config namespace.
     * In VS Code: a `VSCodeConfigSource` wrapping `vscode.workspace.getConfiguration('nexuscode')`.
     * In CLI: a `CliConfigSource` reading flags > env > .nexus/cli.json.
     */
    readonly config: ConfigSource;

    /**
     * Audit logger for compliance-relevant events: LLM calls, tool
     * invocations, file writes, spec edits, config changes. Append-only
     * hash-chained JSONL files under `.nexus/audit/`.
     *
     * Use the typed helpers (logLlmCall, logToolCall, etc.) rather than
     * the generic emit() — they enforce payload shape and craft good
     * default summaries.
     *
     * Both runtimes (IDE + CLI) provide a real AuditLog. Audit failures
     * never crash the host — they log a warning and skip the record.
     */
    readonly audit: import('./audit/AuditLog').AuditLog;
}

/**
 * Module-private holder. Initialized exactly once per process via setDeps.
 * `undefined` means "not yet initialized" — calling getDeps() before
 * setDeps() throws, surfacing missing-init bugs at the access site rather
 * than producing silent undefined dereferences elsewhere.
 */
let _deps: ExtensionDeps | undefined;

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
export function setDeps(deps: ExtensionDeps): void {
    _deps = deps;
}

/**
 * Resolve the runtime dependencies. Throws if `setDeps` has not been
 * called yet. The throw is intentional: silently returning a half-formed
 * object would let an LLM call hit the network with a missing API key
 * and surface as a confusing 401 instead of a clear init bug.
 */
export function getDeps(): ExtensionDeps {
    if (_deps === undefined) {
        throw new Error(
            "[container] getDeps() called before setDeps() — the runtime " +
            "dependencies haven't been initialized. This usually means a " +
            "module that needs vscode.ExtensionContext is being imported " +
            "before extension activation, or the CLI is missing its " +
            "setDeps() bootstrap call."
        );
    }
    return _deps;
}

/**
 * Test-only helper to reset the container between tests. Production code
 * should never call this.
 */
export function resetDepsForTesting(): void {
    _deps = undefined;
}