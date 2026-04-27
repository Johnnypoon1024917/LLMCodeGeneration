// src/agents/exploreAgent.ts
import * as vscode from 'vscode';
import { runAgenticExploration } from '../llmService';
import { getSmartASTContext } from '../context/codeGraph';

export async function runExplorerAgent(
    task: string,
    workspaceRoot: string,
    logCallback: (msg: string, stepType?: string, details?: string) => void
): Promise<string> {
    logCallback("Planner Agent: Booting ReAct Engine. Exploring codebase...", "analyze", "Gathering deep context before planning.");

    let projectContext = "";
    try {
        // 🚀 FAST-TRACK: Pre-fetch the AST so the AI doesn't have to guess file paths!
        projectContext = await getSmartASTContext(workspaceRoot);
    } catch (e) {
        console.warn("Failed to fetch AST Context, falling back to empty context.");
    }

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