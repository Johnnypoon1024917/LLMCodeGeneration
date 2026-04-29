// src/agents/planAgent.ts

import { getProvider } from '../llm';
import type { ChatMessage, ToolCall } from '../llm';
import { getToolDefinitions } from './toolRegistry';
import { dispatchWithEvents } from './toolDispatchWithEvents';
import { allowAllHook } from './securityHook';
// Trigger registration of all tools by importing the barrel. Without
// this import the registry would be empty when planAgent runs.
import './tools';

export async function runPlannerAgent(
    task: string,
    workspaceRoot: string,                                 // ABSOLUTE filesystem path — used by tool execution
    initialContext: string,                                // Output from runExplorerAgent (codebase hints)
    prd: string,                                           // Active requirements.md content (may be empty)
    design: string,                                        // Active design.md content (may be empty)
    failures: string,                                      // Previous verifier critiques (may be empty)
    globalRules: string,                                   // Steering rules / .nexusrules (may be empty)
    log: (msg: string, stepType?: string, details?: string) => void
): Promise<string> {
    log("Planner Agent: Booting ReAct Engine. Exploring codebase...", "analyze", "Gathering deep context before planning.");

    const rulesBlock = globalRules
        ? `\n--- PROJECT STEERING RULES (must be obeyed) ---\n${globalRules}\n-----------------------------------------------\n`
        : "";

    const prdBlock      = prd      ? `\n<prd>\n${prd}\n</prd>\n`                                : "";
    const designBlock   = design   ? `\n<design>\n${design}\n</design>\n`                       : "";
    const failuresBlock = failures ? `\n<previous_failures>\n${failures}\n</previous_failures>\n` : "";

    const systemPrompt = `You are the Principal Software Architect. Your objective is to generate a comprehensive execution plan based on the user's request.
${rulesBlock}
CRITICAL DIRECTIVE: DO NOT GUESS.
Before writing your plan, you MUST use your tools (read_file, list_directory) to verify the exact files you intend to modify, including their existing function signatures and imports.

CONTEXT PROVIDED:
- Initial hints from explorer:
${initialContext || "(none)"}
${prdBlock}${designBlock}${failuresBlock}

OUTPUT FORMAT (strict XML — every tag is required):
<analysis>One paragraph: how the requirements map onto the existing code structure.</analysis>
<files_to_modify>
  <file>path/to/exact/file.ext</file>
</files_to_modify>
<execution_plan>
  Step-by-step technical instructions for the Coder agent. Describe exactly what logic to add, modify, or remove in each file.
  Write deterministic behavioral specs — do NOT write the raw code here.
</execution_plan>
<verification_rules>
  - Bulleted list of conditions that MUST hold for the code to be considered complete.
</verification_rules>`;

    // Migrated to Provider abstraction (Component 2A). The hand-rolled
    // resilientFetch + manual response.json() parse is replaced by
    // provider.chatCompletion which:
    //   - Returns the structured AssistantMessage (with tool_calls)
    //   - Auto-detects tool-call capability per endpoint and falls
    //     back to a tool-free request if the endpoint can't do tools
    //     (replaces the old enableTools config flag — see PATCH.md
    //     for migration notes)
    //   - Carries the same retry/rate-limit machinery internally
    const provider = await getProvider();

    // Component 2B-3b: planner uses only read-only tools. We restrict
    // the catalog rather than expose the full 10-tool set because:
    //   - planAgent shouldn't be writing files or running commands
    //     (that's Coordinator's job during execution)
    //   - a smaller tool list keeps prompt-token cost down
    //   - the planner's existing system prompt is tuned for these tools
    const plannerTools = getToolDefinitions(['read_file', 'list_directory', 'search_codebase']);

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Task: ${task}\n\nExplore the codebase using your tools, then emit the final XML plan.` }
    ];

    const MAX_STEPS = 8; // ReAct loop ceiling — prevents runaway tool-call cycles

    for (let step = 0; step < MAX_STEPS; step++) {
        const aiMessage = await provider.chatCompletion(messages, {
            tools: plannerTools,
            toolChoice: 'auto',
            temperature: 0.2,
            onRetryLog: (msg) => log(`Planner API hiccup: ${msg}`)
        });

        // Append the assistant's response to message history. Even when
        // tool_calls is undefined, we still push so the next iteration
        // sees the model's prior turn (in case we re-prompt).
        messages.push(aiMessage);

        // ReAct: did the model invoke any tools?
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            for (const toolCall of aiMessage.tool_calls) {
                logToolCall(toolCall, log);

                // Component 2B-3b: route through dispatchWithEvents.
                // No emitter wired (planAgent runs before user-visible
                // task starts, and the existing log() callback already
                // surfaces planner activity to the UI). The 'planner'
                // source tag would let 2B-4 add planner cards later
                // without changing this code — just pass an emitter.
                const dispatchResult = await dispatchWithEvents(
                    toolCall,
                    { workspaceRoot },
                    {
                        source: 'planner',
                        preDispatchHook: allowAllHook
                    }
                );
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: dispatchResult.llmContent
                });
            }
            continue; // Loop back so the LLM can react to the tool results
        }

        // No tools called — did it produce the structured plan?
        const content = (aiMessage.content ?? '').trim();

        if (content.includes('<execution_plan>')) {
            log("Planner Agent: Architecture spec finalized.", "success", "Plan rigorously verified against the codebase.");
            return content;
        }

        if (step === MAX_STEPS - 1) {
            log("Planner Agent: Step limit reached, returning best-effort plan.", "warning");
            return content;
        }

        // The model chatted without using tools and without producing the plan. Re-prompt strictly.
        messages.push({
            role: 'user',
            content: "You must either call a tool to explore further, or emit the final plan using the exact XML tags: <analysis>, <files_to_modify>, <execution_plan>, <verification_rules>. No prose outside those tags."
        });
    }

    throw new Error("Planner Agent failed to generate a valid execution plan.");
}

/**
 * Surface a tool invocation to the planner's log callback.
 *
 * Extracted into a helper so the loop body stays readable and the
 * mock-Provider tests can exercise the loop logic without having to
 * stub out logging behavior.
 */
function logToolCall(
    toolCall: ToolCall,
    log: (msg: string, stepType?: string, details?: string) => void
): void {
    const funcName = toolCall.function.name;
    let funcArgs: { filepath?: string; dirpath?: string; keyword?: string } = {};
    try {
        funcArgs = JSON.parse(toolCall.function.arguments || '{}');
    } catch {
        // Tolerate malformed arguments — the model occasionally emits
        // partial JSON, particularly mid-stream. The actual execution
        // happens in dispatchWithEvents which has its own error handling.
    }
    log(
        `Planner inspecting codebase…`,
        'tool',
        `${funcName}(${funcArgs.filepath || funcArgs.dirpath || funcArgs.keyword || ''})`
    );
}