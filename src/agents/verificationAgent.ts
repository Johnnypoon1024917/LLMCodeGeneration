// src/agents/verificationAgent.ts
import { getLLMConfig } from '../llmService';

export async function runVerificationAgent(spec: string, diff: any, log: (msg: string) => void): Promise<{ passed: boolean, critique: string }> {
    log("⚔️ Verification Agent: Auditing code diffs...");

    const systemPrompt = `You are an elite Quality Assurance Automation Engineer. 
Your objective is to audit the code diff produced by the engineering agent against the original architectural specification.

AUDIT CRITERIA:
1. Did the engineer complete every step in the execution plan?
2. Are there any lazy placeholders (e.g., "// TODO", "...")?
3. Are there obvious syntax errors or hallucinations of non-existent imports?

OUTPUT FORMAT:
You must return a valid JSON object matching this exact schema:
{
    "status": "PASS" | "FAIL",
    "critique": "If FAIL, provide a highly specific, actionable explanation of what the engineer missed so they can fix it. If PASS, output 'Verification successful.'"
}`;

    const { endpoint, model, apiKey } = await getLLMConfig();

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Spec:\n${spec}\n\nCoder's Output:\nFile: ${diff.filepath}\nAction: ${diff.action}\nCode:\n${diff.code}` }
                ],
                response_format: { type: "json_object" }, // Force JSON output if supported by model
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        let jsonStr = data.choices[0].message.content.trim();

        // Clean markdown JSON wrapping if present
        jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```/g, '').trim();

        const result = JSON.parse(jsonStr);

        if (result.passed) {
            log("⚔️ Verification Agent: Code APPROVED.");
        } else {
            log(`⚔️ Verification Agent: Code REJECTED. Critique: ${result.critique}`);
        }

        return { passed: !!result.passed, critique: result.critique || "Review complete." };
    } catch (e: any) {
        log(`⚔️ Verification Agent Failed: ${e.message}. Defaulting to fail-safe rejection.`);
        return { passed: false, critique: "Verification engine failed to parse code. Please review manually." };
    }
}