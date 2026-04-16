import { getLLMConfig, safeParseJSON } from '../llmService';

export async function runVerificationAgent(spec: string, diff: any, log: (msg: string) => void): Promise<{ passed: boolean, critique: string }> {
    log("Verification Agent: Auditing code diffs...");
    
    const systemPrompt = `You are an elite Quality Assurance Automation Engineer. 
    Your objective is to audit the code diff produced by the engineering agent against the architectural specification.

    AUDIT CRITERIA:
    1. Read the <verification_rules> from the Spec. Did the engineer satisfy EVERY SINGLE rule?
    2. Are there any lazy placeholders (e.g., "// TODO", "...")?
    3. Are there obvious syntax errors or hallucinations of non-existent imports?
    4. CRITICAL: <action>replace</action> is the correct, valid action for creating new files. Do NOT reject the code for using 'replace' instead of 'create'.

    OUTPUT FORMAT:
    You must return a valid JSON object matching this exact schema:
    {
        "status": "PASS" | "FAIL",
        "failed_rules": ["List any specific verification rules from the spec that failed, or leave empty if all passed"],
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
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        const jsonStr = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const result = safeParseJSON<{ status?: string, passed?: boolean, critique: string }>(jsonStr);

        //  THE FIX: Check for "status": "PASS" or "passed": true
        const isApproved = result.status === "PASS" || result.passed === true;

        if (isApproved) log("Verification Agent: Code APPROVED.");
        else log(`Verification Agent: Code REJECTED. Critique: ${result.critique}`);

        return { passed: isApproved, critique: result.critique || "Review complete." };
    } catch (e: any) {
        log(`Verification Agent Failed: ${e.message}.`);
        return { passed: false, critique: "Verification engine failed to parse code." };
    }
}