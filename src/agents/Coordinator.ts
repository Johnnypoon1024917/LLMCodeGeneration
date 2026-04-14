// src/agents/Coordinator.ts
import { runExplorerAgent } from './exploreAgent';
import { runPlannerAgent } from './planAgent';
import { runVerificationAgent } from './verificationAgent';
import { streamQwenForCode } from '../llmService';

export interface CodeDiff {
    filepath: string;
    action: 'replace' | 'insert_before' | 'append';
    targetLine?: string;
    code: string;
}

export class SwarmCoordinator {
    /**
     * The Master Orchestration Loop. Called directly from SidebarProvider.ts
     */
    public static async executeTask(
        task: string, 
        workspaceRoot: string, 
        currentFileContent: string,
        lspBlastRadiusContext: string,
        activeRequirements: string,
        activeDesign: string,
        previousFailures: string,
        codingStyle: string,
        logCallback: (msg: string) => void,
        streamCallback: (token: string) => void // 🔥 Restored the UI streaming callback!
    ): Promise<CodeDiff | null> {
        logCallback("Coordinator: Task received. Initiating Swarm Orchestration...");

        try {
            // 1. Explorer Agent Phase (Gather Workspace Context via Grep)
            logCallback("Coordinator: Delegating to Explorer Agent...");
            const codebaseContext = await runExplorerAgent(task, workspaceRoot, logCallback);

            // 2. Planner Agent Phase (Create Architecture Spec)
            logCallback("Coordinator: Delegating to Planner Agent...");
            let techSpec = await runPlannerAgent(
                task, 
                codebaseContext, 
                activeRequirements, 
                activeDesign, 
                previousFailures, 
                logCallback
            );

            let finalDiff: CodeDiff | null = null;
            let attempts = 0;
            const MAX_RETRIES = 3;

            // 3. The Auto-Healing Loop (Coder vs. Verifier)
            while (attempts < MAX_RETRIES) {
                attempts++;
                logCallback(`Coordinator: Starting Coder attempt ${attempts}/${MAX_RETRIES}...`);
                
                let shadowCodeBuffer = "";
                let streamAction = 'replace';
                let streamTarget = '';
                let targetFilepath = 'unknown';

                // Combine the Planner's Spec and the LSP constraints for the Coder
                const coderPrompt = `EXECUTION PLAN:\n${techSpec}\n\nLSP BLAST RADIUS (DO NOT BREAK THESE):\n${lspBlastRadiusContext}`;

                // 🔥 Restored the Streaming Engine instead of the blocking runCoderAgent!
                await streamQwenForCode(
                    coderPrompt, 
                    [], // availableFiles
                    currentFileContent, 
                    codingStyle, 
                    [], // chatHistory
                    {
                        onSetup: async (action: string, filepath: string, target?: string) => {
                            streamAction = action;
                            targetFilepath = filepath;
                            streamTarget = target || '';
                        },
                        onToken: async (token: string) => {
                            // Clean markdown artifacts
                            const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                            shadowCodeBuffer += cleanToken;
                            
                            // Pipe the token directly to the React UI for the typing effect!
                            streamCallback(cleanToken);
                        }
                    },
                    undefined, // abortSignal
                    attempts === 1 ? 'creator' : 'rewriter' // Change persona based on retry attempt
                );

                const draftDiff: CodeDiff = {
                    filepath: targetFilepath,
                    action: streamAction as any,
                    targetLine: streamTarget,
                    code: shadowCodeBuffer
                };
                
                // Verifier audits the Coder's XML output against the Spec
                logCallback("Coordinator: Delegating to Verification Agent...");
                const verification = await runVerificationAgent(techSpec, draftDiff, logCallback);

                if (verification.passed) {
                    finalDiff = draftDiff;
                    logCallback("Coordinator: QA Passed. Breaking loop.");
                    break; 
                } else {
                    logCallback(`Coordinator: Verifier rejected attempt ${attempts}. Injecting critique back into spec...`);
                    
                    // Append the failure to the spec so the Coder learns from its mistake on the next loop.
                    // Notice the prompt here is totally sterile, with NO emojis.
                    techSpec += `\n\nCRITICAL ERROR IN PREVIOUS ATTEMPT.\nVerifier Critique: ${verification.critique}\nYou MUST fix this in your next output.`;
                }
            }

            if (finalDiff) {
                logCallback("Coordinator: Swarm execution complete. Handing verified diff back to system.");
                return finalDiff;
            } else {
                logCallback("Coordinator: Swarm failed to produce verified code after maximum attempts.");
                return null;
            }
            
        } catch (error: any) {
            logCallback(`Coordinator Error: ${error.message}`);
            return null;
        }
    }
}