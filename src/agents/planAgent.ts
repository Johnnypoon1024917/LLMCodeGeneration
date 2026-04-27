// src/agents/planAgent.ts

import { getLLMConfig, resilientFetch, authHeaders} from '../llmService';
import { agentToolDefinitions, executeAgentTool } from '../agentTools';

export async function runPlannerAgent(
    task: string,
    workspaceRoot: string,                                 // ABSOLUTE filesystem path — used by executeAgentTool
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

    const { endpoint, model, apiKey, enableTools } = await getLLMConfig();

    const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Task: ${task}\n\nExplore the codebase using your tools, then emit the final XML plan.` }
    ];

    const MAX_STEPS = 8; // ReAct loop ceiling — prevents runaway tool-call cycles

    for (let step = 0; step < MAX_STEPS; step++) {
        const response = await resilientFetch(endpoint, {
            method: 'POST',
            headers: authHeaders(apiKey),
            body: JSON.stringify({
                model: model,
                messages: messages,
                tools: enableTools ? agentToolDefinitions : undefined,
                tool_choice: enableTools ? "auto" : undefined,
                temperature: 0.2
            })
        }, (msg) => log(`Planner API hiccup: ${msg}`));

        const data = await response.json() as any;
        const aiMessage = data.choices?.[0]?.message;
        if (!aiMessage) {
            throw new Error("Planner Agent: empty response from LLM.");
        }
        messages.push(aiMessage);

        // ReAct: did the model invoke a tool?
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            for (const toolCall of aiMessage.tool_calls) {
                const funcName = toolCall.function.name;
                let funcArgs: any = {};
                try { funcArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch { /* tolerate malformed */ }

                log(
                    `Planner inspecting codebase…`,
                    "tool",
                    `${funcName}(${funcArgs.filepath || funcArgs.dirpath || funcArgs.keyword || ''})`
                );

                // workspaceRoot is now the ACTUAL filesystem path — tool calls work correctly.
                const toolResult = await executeAgentTool(toolCall, workspaceRoot);
                messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
            }
            continue; // Loop back so the LLM can react to the tool results
        }

        // No tools called — did it produce the structured plan?
        const content = (aiMessage.content || '').trim();

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
            role: "user",
            content: "You must either call a tool to explore further, or emit the final plan using the exact XML tags: <analysis>, <files_to_modify>, <execution_plan>, <verification_rules>. No prose outside those tags."
        });
    }

    throw new Error("Planner Agent failed to generate a valid execution plan.");
}