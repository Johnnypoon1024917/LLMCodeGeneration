// src/agents/testAgent.ts
import * as path from 'path';
import { getLLMConfig, resilientFetch,authHeaders} from '../llmService';
import { IEnvironment } from '../interfaces/IEnvironment';

export interface TestSetup {
    filepath: string;
    code: string;
    testCommand: string;
    testPlanFilepath: string;
}

/**
 * PHASE 1: GLOBAL QA PLANNER
 * Generates a human-readable Master Test Plan for the entire project based on the PRD.
 */
async function draftProjectTestPlan(
    activeRequirements: string,
    projectContext: string
): Promise<string> {
    const { endpoint, model, apiKey } = await getLLMConfig();
    
    const systemPrompt = `You are a Lead QA Engineer. Your job is to read the ENTIRE PRD and the COMPLETE Codebase Context, and write a comprehensive Master Test Plan.

🔥 TRACEABILITY RULES 🔥
You MUST extract the Acceptance Criteria from the PRD and map them to the existing files in the codebase.

Write the Test Plan in Markdown format using BDD (Behavior-Driven Development) style:
- Describe the global system scenarios using 'Given', 'When', 'Then'.
- Explicitly list edge cases and integration points between files.
- Do NOT write actual code. Write a human-readable plan.`;

    const userPrompt = `PRD (Business Rules):\n${activeRequirements}\n\nEntire Codebase Context:\n${projectContext}\n\nGenerate the Master Markdown Test Plan.`;

    const response = await resilientFetch(endpoint, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0.2
        })
    });

    const data = await response.json() as any;
    return data.choices[0].message.content.trim();
}

/**
 * PHASE 2: GLOBAL SDET CODER
 * Translates the Master Markdown Test Plan into an executable Integration/E2E Test file.
 */
async function draftProjectTestCode(
    testPlanMarkdown: string,
    projectContext: string
): Promise<{ filepath: string; code: string; testCommand: string }> {
    const { endpoint, model, apiKey } = await getLLMConfig();
    
    const systemPrompt = `You are an elite SDET (Software Development Engineer in Test).
Your job is to read the Master Test Plan and the Codebase Context, and translate it EXACTLY into a comprehensive Integration/E2E Unit Test file.

EXECUTION & SYNTAX RULES:
1. You must write a test using the standard framework for the language (e.g., Jest for TS/JS, PyTest for Python).
2. The test file MUST be placed in '.nexus/specs/main/tests/' (e.g., '.nexus/specs/main/tests/system.test.ts').
3. Return ONLY a valid JSON object matching this schema:
{
  "filepath": ".nexus/specs/main/tests/system.test.ts",
  "code": "import { ... } from '../../../../src/...';\\n\\ndescribe('System Integration Test', () => { ... });",
  "testCommand": "npx jest .nexus/specs/main/tests/system.test.ts"
}`;

    const userPrompt = `Codebase Context:\n${projectContext}\n\nMaster Test Plan to Implement:\n${testPlanMarkdown}`;

    const response = await resilientFetch(endpoint, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    const content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    return JSON.parse(content.substring(jsonStart, jsonEnd + 1));
}

export async function runProjectTestAgent(
    env: IEnvironment,
    activeRequirements: string,
    projectContext: string,
    workspaceRoot: string,
    logCallback: (msg: string, stepType?: string, details?: string) => void
): Promise<TestSetup | null> {
    
    try {
        // 🚀 PHASE 1: Generate the Markdown Master Plan
        logCallback(`TestAgent: Synthesizing Global PRD criteria into a Master Test Plan...`, "analyze");
        const testPlanMarkdown = await draftProjectTestPlan(activeRequirements, projectContext);
        
        // Force the output specifically into the nexuscode/ folder
        const testsDir = path.join('.nexus', 'specs', 'main', 'tests');
        const planFilepath = path.join(testsDir, 'system.testplan.md');
        const absolutePlanPath = path.join(workspaceRoot, planFilepath);
        await env.writeFile(absolutePlanPath, testPlanMarkdown);
        logCallback(`TestAgent: 📝 Master Test Plan written to ${planFilepath}`, "success");

        // 🚀 PHASE 2: Generate the Executable Test Code
        logCallback(`TestAgent: Translating Master Test Plan into executable System Tests...`, "code");
        let parsedTest = await draftProjectTestCode(testPlanMarkdown, projectContext);
        
        // Ensure the LLM didn't hallucinate the path outside of nexuscode/
        const ext = path.extname(parsedTest.filepath) || '.ts';
        parsedTest.filepath = path.join(testsDir, `system.test${ext}`);
        
        const absoluteTestPath = path.join(workspaceRoot, parsedTest.filepath);
        await env.writeFile(absoluteTestPath, parsedTest.code);
        logCallback(`TestAgent: 🧪 Global TDD Suite written to ${parsedTest.filepath}`, "success", `Command: ${parsedTest.testCommand}`);
        
        return {
            ...parsedTest,
            testPlanFilepath: planFilepath
        };

    } catch (e: any) {
        logCallback(`TestAgent: Failed to generate global TDD suite.`, "error", e.message);
        return null;
    }
}