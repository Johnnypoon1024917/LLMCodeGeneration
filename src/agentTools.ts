// src/agentTools.ts
//
// Component 2B-2: this file is now a BACK-COMPAT SHIM over the new
// tool registry in `src/agents/tools/`.
//
// Existing callers (planAgent, runAgenticExploration) imported from
// './agentTools' to get `agentToolDefinitions` and `executeAgentTool`.
// To avoid touching those call sites in 2B-2 (Coordinator wire-up
// is 2B-3's job), we keep the old API surface here:
//
//   - `agentToolDefinitions` — returns ALL registered tool definitions
//     from the new registry. Callers that want a subset use the new
//     `getToolDefinitions(names)` helper from toolRegistry directly.
//
//   - `executeAgentTool(toolCall, workspaceRoot)` — routes through
//     the registry's `dispatchTool`. Returns the LLM-bound string
//     (the new `llmContent` field) for back-compat. The structured
//     UI payload is discarded — Coordinator wire-up in 2B-3 will
//     switch callers to `dispatchTool` directly to get both halves.
//
// Once 2B-3 lands and migrates the call sites, this file can be
// deleted entirely. It's a stepping stone, not a permanent abstraction.

// Trigger registration of all tools by importing the barrel.
import './agents/tools';

import type { ToolDefinition } from './llm';
import { dispatchTool, getAllToolDefinitions, type ToolExecutionContext } from './agents/toolRegistry';

/**
 * The full catalog of registered tools, for callers that want to
 * pass them all to the LLM. Most callers should use the more
 * specific `getToolDefinitions(names)` helper from
 * `./agents/toolRegistry` to scope down — for example, planAgent
 * only wants read-only tools.
 *
 * This snapshot is captured at module-load time, AFTER all tool
 * registrations from the barrel above. Tests that mutate the
 * registry should clear and re-import via the test helper rather
 * than reading this constant.
 */
export const agentToolDefinitions: ToolDefinition[] = getAllToolDefinitions();

/**
 * Back-compat shim. Routes through the registry but returns only the
 * LLM-bound string content, matching the old signature.
 *
 * `toolCall` is typed loosely (matching the previous `any` import) to
 * avoid forcing call sites to update their types in 2B-2. 2B-3 will
 * migrate them to use `dispatchTool` directly with the typed
 * `ToolCall` interface.
 */
export async function executeAgentTool(
    toolCall: { id?: string; type?: string; function: { name: string; arguments: string } },
    workspaceRoot: string
): Promise<string> {
    const ctx: ToolExecutionContext = { workspaceRoot };
    // Coerce the loose toolCall type to the registry's typed ToolCall
    // shape. The runtime values match; only the type is widened here.
    const result = await dispatchTool(
        {
            id: toolCall.id ?? '',
            type: 'function',
            function: toolCall.function
        },
        ctx
    );
    return result.llmContent;
}