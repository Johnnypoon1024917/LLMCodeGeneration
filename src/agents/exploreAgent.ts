// src/agents/exploreAgent.ts
import { runAgenticExploration } from '../llmService';
import { getProjectContext } from '../projectContext';

export async function runExplorerAgent(
    task: string,
    workspaceRoot: string,
    logCallback: (msg: string, stepType?: string, details?: string) => void
): Promise<string> {
    logCallback("Planner Agent: Booting ReAct Engine. Exploring codebase...", "analyze", "Gathering deep context before planning.");

    // 🚀 FAST-TRACK: Pre-fetch the AST so the AI doesn't have to guess!
    const projectContext = await getProjectContext(workspaceRoot);

    const explorationContext = await runAgenticExploration(
        task,
        projectContext,
        workspaceRoot,
        (stepType, desc, details) => {
            logCallback(`Executing ${desc} on ${details || ''}`, stepType);
        }
    );

    return explorationContext;
}