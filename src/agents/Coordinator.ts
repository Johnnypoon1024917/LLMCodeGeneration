// src/agents/Coordinator.ts
import * as vscode from 'vscode'; // 🚀 We need this to dynamically read files during the loop
import { runExplorerAgent } from './exploreAgent';
import { runPlannerAgent } from './planAgent';
import { runVerificationAgent } from './verificationAgent';
import { streamQwenForCode } from '../llmService';

export interface CodeDiff {
    filepath: string;
    searchBlock: string;
    replaceBlock: string;
    fullOutputBuffer: string; 
}

export class SwarmCoordinator {
    // 🚀 UPGRADED: Now returns Promise<CodeDiff[]>
    public static async executeTask(
        task: string, 
        workspaceRoot: string, 
        _deprecatedInitialContent: string, // No longer used, we fetch dynamically
        lspBlastRadiusContext: string,
        activeRequirements: string,
        activeDesign: string,
        previousFailures: string,
        codingStyle: string,
        logCallback: (msg: string, stepType?: string, details?: string) => void,
        streamCallback: (token: string) => void
    ): Promise<CodeDiff[] | null> {
        logCallback("Coordinator: Task received. Initiating Swarm Orchestration...", "analyze", "Booting Swarm Agents");

        try {
            // 1. EXPLORE & PLAN (Phase 3 ReAct Engine)
            const codebaseContext = await runExplorerAgent(task, workspaceRoot, logCallback);
            let techSpec = await runPlannerAgent(task, workspaceRoot, codebaseContext, activeRequirements, activeDesign, previousFailures, logCallback);

            // 2. PARSE THE DAG (Extract Target Files)
            const filesToModifyMatch = techSpec.match(/<files_to_modify>([\s\S]*?)<\/files_to_modify>/);
            let targetFiles: string[] = [];
            
            if (filesToModifyMatch) {
                const fileRegex = /<file>(.*?)<\/file>/g;
                let match;
                while ((match = fileRegex.exec(filesToModifyMatch[1])) !== null) {
                    targetFiles.push(match[1].trim());
                }
            }

            if (targetFiles.length === 0) {
                logCallback("Coordinator: Warning - No <files_to_modify> found. Defaulting to autonomous hunt.", "warning");
                targetFiles.push("unknown"); 
            }

            let allDiffs: CodeDiff[] = [];

            // 3. THE SUB-TASK LOOP: Spawn a fresh Coder for EACH file!
            for (const filepath of targetFiles) {
                logCallback(`Coordinator: Spawning Coder for ${filepath}...`, "analyze", `Executing sub-task for ${filepath}`);

                // Read the exact state of the file right now (in case a previous Coder in the loop modified a shared dependency)
                let currentFileContent = "";
                if (filepath !== 'unknown') {
                    try {
                        const fileUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filepath);
                        const fileData = await vscode.workspace.fs.readFile(fileUri);
                        currentFileContent = new TextDecoder().decode(fileData);
                    } catch (e) {
                        logCallback(`Coordinator: ${filepath} is a new file. Proceeding with creation.`, "analyze");
                    }
                }

                let finalDiff: CodeDiff | null = null;
                let attempts = 0;
                const MAX_RETRIES = 3;

                while (attempts < MAX_RETRIES) {
                    attempts++;
                    logCallback(`Coder [${filepath}]: Drafting code (Attempt ${attempts}/${MAX_RETRIES})...`, "analyze", `Drafting ${filepath}`);
                    
                    let shadowCodeBuffer = "";
                    let parsedFilepath = filepath;

                    // 🚀 The Phase 1 Search/Replace prompt, now forcefully scoped to a SINGLE file
                    const coderPrompt = `EXECUTION PLAN:\n${techSpec}\n\nLSP BLAST RADIUS:\n${lspBlastRadiusContext}\n\n` +
                    `CRITICAL: You are currently executing the sub-task for ONE file: ${filepath}\n` +
                    `Output EXACTLY ONE SEARCH/REPLACE block for this specific file. DO NOT output code for any other file right now.\n\n` +
                    `<filepath>${filepath}</filepath>\n` +
                    `<<<<SEARCH\n[exact existing code you want to replace]\n====\n[the new code you are inserting]\n>>>>REPLACE\n\n`;

                    await streamQwenForCode(
                        coderPrompt, [], currentFileContent, codingStyle, [],
                        {
                            onSetup: async (action: string, fp: string) => { parsedFilepath = fp; },
                            onToken: async (token: string) => {
                                shadowCodeBuffer += token;
                                streamCallback(token);
                            }
                        },
                        undefined,
                        attempts === 1 ? 'creator' : 'rewriter'
                    );

                    const searchMatch = shadowCodeBuffer.match(/<<<<SEARCH\n([\s\S]*?)\n====/);
                    const replaceMatch = shadowCodeBuffer.match(/====\n([\s\S]*?)\n>>>>REPLACE/);

                    const draftDiff: CodeDiff = {
                        filepath: parsedFilepath !== 'unknown' ? parsedFilepath : filepath,
                        searchBlock: searchMatch ? searchMatch[1] : "",
                        replaceBlock: replaceMatch ? replaceMatch[1] : "",
                        fullOutputBuffer: shadowCodeBuffer
                    };
                    
                    const verification = await runVerificationAgent(techSpec, draftDiff, workspaceRoot, logCallback);
                    
                    if (verification.passed) {
                        finalDiff = draftDiff;
                        logCallback(`Coder [${filepath}]: QA Passed.`, "success");
                        break; 
                    } else {
                        logCallback(`Coder [${filepath}]: Verifier rejected attempt ${attempts}.`, "error", `QA Critique:\n${verification.critique}`);
                        techSpec += `\n\nCRITICAL ERROR IN PREVIOUS ATTEMPT ON ${filepath}.\nVerifier Critique: ${verification.critique}\nYou MUST fix this in your next output!`;
                    }
                }

                if (finalDiff) {
                    allDiffs.push(finalDiff);
                } else {
                    throw new Error(`Swarm failed to generate verified code for ${filepath} after ${MAX_RETRIES} attempts.`);
                }
            }

            return allDiffs;
        } catch (error: any) {
            logCallback(`Coordinator Error: ${error.message}`, "error", error.message);
            return null;
        }
    }
}