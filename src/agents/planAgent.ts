// src/agents/planAgent.ts
import { getLLMConfig } from '../llmService';

export async function runPlannerAgent(
    task: string,
    context: string,
    prd: string,
    design: string,
    failures: string,
    log: (msg: string) => void
): Promise<string> {
    log("🧠 Planner Agent: Architecting step-by-step spec...");

    //  THE COMPLETE ENTERPRISE PROMPT
    const systemPrompt = `You are the Principal Software Architect. Your objective is to generate a comprehensive execution plan based on the user's request and the provided workspace context.
You do not write implementation code. You generate strict architectural instructions.

CONTEXT PROVIDED:
- Workspace Context: Output from search tools and file reads.
- PRD: Strict business requirements (if available).
- System Design: Core architectural guidelines (if available).
- Anti-Patterns: Previous failures to avoid (if available).

OUTPUT FORMAT:
You must structure your response strictly using the following XML tags:
<analysis>Briefly analyze the requirements and how they fit into the existing codebase.</analysis>
<files_to_modify>
  <file>path/to/exact/file.ts</file>
</files_to_modify>
<execution_plan>
  Step-by-step technical instructions for the Coder agent. Detail exactly what logic to add, modify, or remove in each file. 
  CRITICAL RULES:
  - DO NOT write the raw code, write the logic requirements.
  - DO NOT include abstract human tasks like "test across browsers", "ensure responsiveness", or "deploy to production".
  - Write ONLY deterministic instructions for generating code syntax.
</execution_plan>
<verification_rules>
  Generate a strict bulleted list of syntax and logic conditions that MUST be true for this code to be considered complete.
  Example:
  - The file must export a 'loginUser' function.
  - The function must include a try/catch block.
  - It must return a 400 status code if the email is missing.
</verification_rules>`;

    const { endpoint, model, apiKey } = await getLLMConfig();

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Task: ${task}\n\nWorkspace Context (Grep/LSP Results):\n${context}` }
                ],
                temperature: 0.3
            })
        });

        const data = await response.json() as any;
        const spec = data.choices[0].message.content.trim();
        log("🧠 Planner Agent: Architecture spec generated.");
        return spec;
    } catch (e: any) {
        log(`🧠 Planner Agent Failed: ${e.message}`);
        throw new Error("Failed to generate plan.");
    }
}