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

import type { ToolDefinition, ToolCall } from '../llm';
import type { ToolDispatchResult } from './toolProtocol';

/**
 * Context passed to every tool executor. Tools may need any of these:
 *
 *   - `workspaceRoot`: absolute filesystem path. Required by every
 *     tool that touches the workspace (read_file, write_file, bash_exec).
 *   - `signal`: abort signal for cancellation (Q5=5B per-task cancel).
 *     Tools that take time (bash_exec, run_tests, web_fetch) MUST
 *     honor this. Tools that finish quickly (read_file) may ignore.
 *   - `onOutputChunk`: callback for streaming output. Long-running
 *     tools call this with stdout/stderr fragments as they arrive.
 *     The Coordinator (in 2B-3) wires this to emit `toolCallOutput`
 *     lifecycle events. Tools that finish atomically don't call it.
 *
 * Adding a new field (e.g. `auditLog` for Component 3 integration in
 * 2B-3) is additive — existing dispatchers ignore unknown fields.
 */
export interface ToolExecutionContext {
    workspaceRoot: string;
    signal?: AbortSignal;
    onOutputChunk?: (chunk: string) => void;
}

/**
 * Function signature for a tool dispatcher.
 *
 * Inputs:
 *   - `args`: parsed JSON arguments from the LLM's tool_call. The
 *     dispatcher is responsible for validating its own args; type
 *     `Record<string, unknown>` reflects the wire-level reality
 *     (anything could be in there).
 *   - `ctx`: execution context (see ToolExecutionContext).
 *
 * Output:
 *   - `Promise<ToolDispatchResult>`: the split bundle from Q4=4C.
 *     LLM-bound string content + structured UI payload.
 *
 * Errors:
 *   - Per Q5=5D, executors should NOT throw on tool-level failures
 *     (file not found, command exited non-zero, etc.). Instead,
 *     return a `{ kind: 'error' }` UI payload + a descriptive
 *     `llmContent` string. The LLM reasons about errors via its
 *     message history; throwing would short-circuit the ReAct loop.
 *   - Executors MAY throw on TRULY exceptional conditions (out of
 *     memory, programmer error in the executor itself). These
 *     bubble to the Coordinator which renders a generic error card.
 */
export type ToolExecutor = (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext
) => Promise<ToolDispatchResult>;

/**
 * Internal registry shape. One entry per tool name. The `definition`
 * is the OpenAI-shape ToolDefinition (advertised to the LLM); the
 * `executor` is the dispatcher function that runs when the LLM calls
 * the tool.
 */
interface ToolRegistryEntry {
    definition: ToolDefinition;
    executor: ToolExecutor;
}

const registry = new Map<string, ToolRegistryEntry>();

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
export function registerTool(definition: ToolDefinition, executor: ToolExecutor): void {
    registry.set(definition.function.name, { definition, executor });
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
export async function dispatchTool(
    toolCall: ToolCall,
    ctx: ToolExecutionContext
): Promise<ToolDispatchResult> {
    const entry = registry.get(toolCall.function.name);
    if (!entry) {
        const msg = `Unknown tool: ${toolCall.function.name}. Available tools: ${Array.from(registry.keys()).join(', ')}`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }

    let args: Record<string, unknown>;
    try {
        args = JSON.parse(toolCall.function.arguments || '{}');
    } catch (e) {
        const msg = `Invalid JSON arguments for ${toolCall.function.name}: ${e instanceof Error ? e.message : String(e)}`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }

    try {
        return await entry.executor(args, ctx);
    } catch (e) {
        // Truly exceptional path — executor threw. Per the docstring
        // on ToolExecutor, this is a programmer error (or genuine
        // exceptional condition). Wrap in error result rather than
        // letting it bubble to the Coordinator's outer try/catch
        // which has less context.
        const msg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : undefined;
        const errorPayload: { kind: 'error'; message: string; stack?: string } = {
            kind: 'error',
            message: msg
        };
        if (stack) errorPayload.stack = stack;
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
export function getAllToolDefinitions(): ToolDefinition[] {
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
export function getToolDefinitions(names: string[]): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const name of names) {
        const entry = registry.get(name);
        if (entry) out.push(entry.definition);
    }
    return out;
}

/**
 * Test-only: clear the registry. Used by jest setup to ensure each
 * test starts with a known state.
 *
 * Production code should never need this; export is for tests only.
 */
export function resetRegistryForTesting(): void {
    registry.clear();
}

/**
 * Test-only: peek at registry contents. Useful for assertions like
 * "after importing the tools barrel, all 10 tools are registered."
 */
export function getRegisteredToolNames(): string[] {
    return Array.from(registry.keys()).sort();
}