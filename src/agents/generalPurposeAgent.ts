// src/agents/generalPurposeAgent.ts
import { getLLMConfig } from '../llmService';

export interface CodeDiff {
    filepath: string;
    action: 'replace' | 'insert_before' | 'append';
    targetLine?: string;
    code: string;
}

export async function runCoderAgent(
    spec: string,
    fileContext: string,
    lspBlastRadius: string,
    codingStyle: string,
    log: (msg: string) => void
): Promise<CodeDiff> {
    log("👨‍💻 Coder Agent: Translating spec into syntax...");

    // 🔥 THE COMPLETE ENTERPRISE PROMPT
    const systemPrompt = `You are an expert Software Engineer. Your objective is to translate the provided Technical Specification into production-ready code.
You must strictly adhere to the execution plan. Do not deviate, do not add unrequested features, and do not leave incomplete stubs (e.g., "// TODO").

RULES:
- You must output exactly one code modification block.
- Follow the provided Project Coding Style strictly.
- Respect the LSP Blast Radius. Do not alter signatures that break external dependents.

OUTPUT FORMAT:
You must output your modification strictly using the following XML format:
<filepath>path/to/target/file.ts</filepath>
<action>replace|insert_before|append</action>
<target>The exact existing line of code to insert above (Required ONLY if action is insert_before)</target>
<self_critique>Briefly verify you followed all instructions and left no stubs.</self_critique>
\`\`\`typescript
// The complete, production-ready implementation code here
\`\`\``;

    const { endpoint, model, apiKey } = await getLLMConfig();

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Technical Spec:\n${spec}\n\nTarget File Content:\n${fileContext}` }
                ],
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        const rawOutput = data.choices[0].message.content.trim();

        const filepathMatch = rawOutput.match(/<filepath>(.*?)<\/filepath>/s);
        const actionMatch = rawOutput.match(/<action>(.*?)<\/action>/s);
        const targetMatch = rawOutput.match(/<target>(.*?)<\/target>/s);
        const codeMatch = rawOutput.match(/```[a-zA-Z]*\n([\s\S]*?)```/);

        if (!filepathMatch || !codeMatch) {
            throw new Error("LLM failed to format output as XML.");
        }

        log("👨‍💻 Coder Agent: XML Diffs generated.");

        return {
            filepath: filepathMatch[1].trim(),
            action: (actionMatch ? actionMatch[1].trim() : 'replace') as any,
            targetLine: targetMatch ? targetMatch[1].trim() : undefined,
            code: codeMatch[1].trim()
        };
    } catch (e: any) {
        log(`👨‍💻 Coder Agent Failed: ${e.message}`);
        throw new Error("Failed to write code.");
    }
}