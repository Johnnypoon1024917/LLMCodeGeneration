// src/agents/planAgent.ts
import { getLLMConfig, resilientFetch } from '../llmService';
import { agentToolDefinitions, executeAgentTool } from '../agentTools';

export async function runPlannerAgent(
    task: string,
    workspaceRoot: string,     // 🚀 UPGRADED: We now need the workspace root to execute tools!
    initialContext: string,    // The LSP/Grep blast radius
    prd: string,
    design: string,
    failures: string,
    log: (msg: string, stepType?: string, details?: string) => void
): Promise<string> {
    log("🧠 Planner Agent: Booting ReAct Engine. Exploring codebase...", "analyze", "Gathering deep context before planning.");

    const systemPrompt = `You are the Principal Software Architect. Your objective is to generate a comprehensive execution plan based on the user's request.
    
    🛑 CRITICAL DIRECTIVE: DO NOT GUESS. 🛑
    BEFORE writing your plan, you MUST use your tools (like read_file or list_directory) to explore the exact files you need to modify. 
    Verify the existing function signatures and imports.

    CONTEXT PROVIDED:
    - Initial Hints: \n${initialContext}\n
    - PRD: ${prd || "None"}
    - System Design: ${design || "None"}

    OUTPUT FORMAT:
    When you have finished exploring and are 100% confident, structure your response strictly using the following XML tags:
    <analysis>Briefly analyze the requirements and how they fit into the existing codebase.</analysis>
    <files_to_modify>
      <file>path/to/exact/file.ts</file>
    </files_to_modify>
    <execution_plan>
      Step-by-step technical instructions for the Coder agent. Detail exactly what logic to add, modify, or remove in each file. 
      Write ONLY deterministic instructions for generating code syntax. Do NOT write the raw code here.
    </execution_plan>
    <verification_rules>
      Generate a strict bulleted list of syntax and logic conditions that MUST be true for this code to be considered complete.
    </verification_rules>`;

    const { endpoint, model, apiKey, enableTools } = await getLLMConfig();

    let messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Task: ${task}\n\nExplore the codebase to figure out exactly how to implement this.` }
    ];

    const MAX_STEPS = 8; // Prevent infinite loops

    for (let step = 0; step < MAX_STEPS; step++) {
        const response = await resilientFetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: messages,
                tools: enableTools ? agentToolDefinitions : undefined,
                tool_choice: enableTools ? "auto" : undefined,
                temperature: 0.2
            })
        }, (msg) => log(`⚠️ Planner API Intercept: ${msg}`));

        const data = await response.json() as any;
        const aiMessage = data.choices[0].message;
        messages.push(aiMessage);

        // 🚀 THE REACT LOOP: Did the LLM decide to call a tool?
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            for (const toolCall of aiMessage.tool_calls) {
                const funcName = toolCall.function.name;
                const funcArgs = JSON.parse(toolCall.function.arguments);
                
                log(`🧠 Planner Agent inspecting codebase...`, "tool", `Executing ${funcName} on ${funcArgs.filepath || 'directory'}`);
                
                // Execute the tool locally in the user's filesystem
                const toolResult = await executeAgentTool(toolCall, workspaceRoot);
                
                // Feed the raw file contents back into the LLM's memory!
                messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
            }
        } else {
            // No tools called. Did it output our plan?
            if (aiMessage.content && aiMessage.content.includes('<execution_plan>')) {
                log("🧠 Planner Agent: Architecture spec finalized.", "success", "Plan rigorously verified against codebase.");
                return aiMessage.content.trim();
            } else if (step === MAX_STEPS - 1) {
                log("🧠 Planner Agent: Max steps reached. Forcing plan output.", "warning");
                return aiMessage.content.trim();
            } else {
                // The AI tried to chat without using tools or outputting the XML. Force it back on track.
                messages.push({ role: "user", content: "You must either use a tool to explore further, or output the final plan using the exact XML tags: <analysis>, <files_to_modify>, <execution_plan>, <verification_rules>."});
            }
        }
    }

    throw new Error("Planner Agent failed to generate a valid execution plan.");
}