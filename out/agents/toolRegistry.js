"use strict";
// src/agents/toolRegistry.ts
//
// Component 2B-2: tool registry plumbing.
//
// Q6=6B locked: object registry (vs class hierarchy or switch statement).
// This file defines the executor type and the registry data structure.
// Individual tool implementations live in `src/agents/tools/*.ts` —
// one file per tool, each registering itself via `registerTool()`.
//
// Why split: 10 tools is a lot of code in one file. Per-tool isolation
// makes review and testing easier. Each tool's implementation lives
// next to its tests; the registry just routes calls.
//
// Lifecycle:
//   1. Tool files (read_file.ts, write_file.ts, etc.) call
//      registerTool() at module load time.
//   2. The barrel `src/agents/tools/index.ts` imports all tool files,
//      triggering registrations.
//   3. `agentTools.ts` (the back-compat shim) re-exports a list of
//      tool definitions and an executeAgentTool function that routes
//      through the registry.
//
// The registry is in-process state. Tests can clear it via
// `resetRegistryForTesting()` to isolate per-test setups.
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTool = registerTool;
exports.unregisterTool = unregisterTool;
exports.dispatchTool = dispatchTool;
exports.getAllToolDefinitions = getAllToolDefinitions;
exports.getToolDefinitions = getToolDefinitions;
exports.resetRegistryForTesting = resetRegistryForTesting;
exports.getRegisteredToolNames = getRegisteredToolNames;
const registry = new Map();
/**
 * Register a tool. Called by tool files at module load time.
 *
 * The name in the definition must match the key the LLM will use
 * (`function.name`). Re-registering the same name silently replaces
 * the prior entry — useful for tests, but production callers should
 * register exactly once.
 *
 * Why no validation against re-registration in production: the
 * existing pattern (used by jest.mock for tests) replaces module
 * exports. Throwing here would prevent test setups from working.
 * If a real-world ambiguity emerges later, add a strict mode flag.
 */
function registerTool(definition, executor) {
    registry.set(definition.function.name, { definition, executor });
}
/**
 * P2.1 SDK: remove a tool from the registry. Symmetric to registerTool.
 *
 * Returns true if a tool with that name was present (and is now
 * removed); false if the name wasn't in the registry.
 *
 * Use case: when an MCP server disconnects, its tools should no
 * longer be advertised to the LLM or dispatchable. Built-in tools
 * never call this — they're registered once at startup and stay.
 */
function unregisterTool(name) {
    return registry.delete(name);
}
/**
 * Run a tool by name. Used by Coordinator (2B-3) and by the
 * back-compat `executeAgentTool` shim in `agentTools.ts`.
 *
 * Returns `{ kind: 'error' }` when:
 *   - Tool name is unknown
 *   - Arguments fail JSON parsing
 *
 * The error is structured so the Coordinator can render an error
 * card AND propagate the message back to the LLM. This avoids
 * silent failures when the model hallucinates a tool name.
 */
async function dispatchTool(toolCall, ctx) {
    const entry = registry.get(toolCall.function.name);
    if (!entry) {
        const msg = `Unknown tool: ${toolCall.function.name}. Available tools: ${Array.from(registry.keys()).join(', ')}`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    let args;
    try {
        args = JSON.parse(toolCall.function.arguments || '{}');
    }
    catch (e) {
        const msg = `Invalid JSON arguments for ${toolCall.function.name}: ${e instanceof Error ? e.message : String(e)}`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    try {
        return await entry.executor(args, ctx);
    }
    catch (e) {
        // Truly exceptional path — executor threw. Per the docstring
        // on ToolExecutor, this is a programmer error (or genuine
        // exceptional condition). Wrap in error result rather than
        // letting it bubble to the Coordinator's outer try/catch
        // which has less context.
        const msg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : undefined;
        const errorPayload = {
            kind: 'error',
            message: msg
        };
        if (stack) {
            errorPayload.stack = stack;
        }
        return {
            llmContent: `Error executing ${toolCall.function.name}: ${msg}`,
            uiPayload: errorPayload
        };
    }
}
/**
 * Get all registered tool definitions. Used by callers that need to
 * pass the catalog to the LLM (planAgent, Coordinator).
 *
 * Returns a fresh array each call — callers can safely mutate the
 * return value. Sorted by name for deterministic ordering across
 * test runs.
 */
function getAllToolDefinitions() {
    return Array.from(registry.values())
        .map(e => e.definition)
        .sort((a, b) => a.function.name.localeCompare(b.function.name));
}
/**
 * Get a subset of tool definitions by name. Used by callers that
 * want only specific tools available to the LLM (planAgent restricts
 * to read-only tools; runAgenticExploration uses a custom subset).
 *
 * Names not found in the registry are silently skipped. The caller
 * is responsible for ensuring all expected names exist (e.g. by
 * importing the tools barrel before calling this).
 */
function getToolDefinitions(names) {
    const out = [];
    for (const name of names) {
        const entry = registry.get(name);
        if (entry) {
            out.push(entry.definition);
        }
    }
    return out;
}
/**
 * Test-only: clear the registry. Used by jest setup to ensure each
 * test starts with a known state.
 *
 * Production code should never need this; export is for tests only.
 */
function resetRegistryForTesting() {
    registry.clear();
}
/**
 * Test-only: peek at registry contents. Useful for assertions like
 * "after importing the tools barrel, all 10 tools are registered."
 */
function getRegisteredToolNames() {
    return Array.from(registry.keys()).sort();
}
//# sourceMappingURL=toolRegistry.js.map