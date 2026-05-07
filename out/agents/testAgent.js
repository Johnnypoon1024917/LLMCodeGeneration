"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProjectTestAgent = runProjectTestAgent;
// src/agents/testAgent.ts
const path = __importStar(require("path"));
const llm_1 = require("../llm");
const errors_1 = require("../utilities/errors");
/**
 * PHASE 1: GLOBAL QA PLANNER
 * Generates a human-readable Master Test Plan for the entire project based on the PRD.
 */
async function draftProjectTestPlan(activeRequirements, projectContext) {
    // Migrated to Provider abstraction (Component 1, Session 2). Same
    // request shape as before — non-streaming completion at temperature 0.2.
    const provider = await (0, llm_1.getProvider)();
    const systemPrompt = `You are a Lead QA Engineer. Your job is to read the ENTIRE PRD and the COMPLETE Codebase Context, and write a comprehensive Master Test Plan.

🔥 TRACEABILITY RULES 🔥
You MUST extract the Acceptance Criteria from the PRD and map them to the existing files in the codebase.

Write the Test Plan in Markdown format using BDD (Behavior-Driven Development) style:
- Describe the global system scenarios using 'Given', 'When', 'Then'.
- Explicitly list edge cases and integration points between files.
- Do NOT write actual code. Write a human-readable plan.`;
    const userPrompt = `PRD (Business Rules):\n${activeRequirements}\n\nEntire Codebase Context:\n${projectContext}\n\nGenerate the Master Markdown Test Plan.`;
    const result = await provider.completion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ], { temperature: 0.2 });
    return result.trim();
}
/**
 * PHASE 2: GLOBAL SDET CODER
 * Translates the Master Markdown Test Plan into an executable Integration/E2E Test file.
 */
async function draftProjectTestCode(testPlanMarkdown, projectContext) {
    // Migrated to Provider abstraction (Component 1, Session 2). The
    // hand-rolled JSON extraction (strip markdown fences, slice between
    // first { and last }) is preserved verbatim — moving this to
    // jsonCompletion would require defining a JsonSchema, which is
    // worthwhile but out of scope for the migration grind.
    const provider = await (0, llm_1.getProvider)();
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
    const raw = await provider.completion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ], { temperature: 0.1 });
    const content = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    return JSON.parse(content.substring(jsonStart, jsonEnd + 1));
}
async function runProjectTestAgent(env, activeRequirements, projectContext, workspaceRoot, logCallback) {
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
    }
    catch (e) {
        const msg = (0, errors_1.errorMessage)(e);
        logCallback(`TestAgent: Failed to generate global TDD suite.`, "error", msg);
        return null;
    }
}
//# sourceMappingURL=testAgent.js.map