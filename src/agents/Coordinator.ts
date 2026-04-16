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
    public static async executeTask(
        task: string, 
        workspaceRoot: string, 
        currentFileContent: string,
        lspBlastRadiusContext: string,
        activeRequirements: string,
        activeDesign: string,
        previousFailures: string,
        codingStyle: string,
        //  UPGRADED: Added stepType and details for selective UI persistence
        logCallback: (msg: string, stepType?: string, details?: string) => void,
        streamCallback: (token: string) => void
    ): Promise<CodeDiff | null> {
        logCallback("Coordinator: Task received. Initiating Swarm Orchestration...", "analyze", "Booting Swarm Agents");

        try {
            const codebaseContext = await runExplorerAgent(task, workspaceRoot, logCallback);

            let techSpec = await runPlannerAgent(
                task, codebaseContext, activeRequirements, activeDesign, previousFailures, logCallback
            );

            let finalDiff: CodeDiff | null = null;
            let attempts = 0;
            const MAX_RETRIES = 3;

            while (attempts < MAX_RETRIES) {
                attempts++;
                logCallback(`Coordinator: Starting Coder attempt ${attempts}/${MAX_RETRIES}...`, "analyze", `Drafting code (Attempt ${attempts})`);
                
                let shadowCodeBuffer = "";
                let streamAction = 'replace';
                let streamTarget = '';
                let targetFilepath = 'unknown';

                //  FORTIFIED PROMPT: Explicitly remind the Coder about the XML tags!
                const coderPrompt = `EXECUTION PLAN:\n${techSpec}\n\nLSP BLAST RADIUS:\n${lspBlastRadiusContext}\n\nCRITICAL: You MUST wrap your code in <filepath>, <action>, and triple backticks. Failure to do so will break the system.`;

                await streamQwenForCode(
                    coderPrompt, [], currentFileContent, codingStyle, [],
                    {
                        onSetup: async (action: string, filepath: string, target?: string) => {
                            streamAction = action;
                            targetFilepath = filepath;
                            streamTarget = target || '';
                        },
                        onToken: async (token: string) => {
                            const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                            shadowCodeBuffer += cleanToken;
                            streamCallback(cleanToken);
                        }
                    },
                    undefined,
                    attempts === 1 ? 'creator' : 'rewriter'
                );

                const draftDiff: CodeDiff = {
                    filepath: targetFilepath,
                    action: streamAction as any,
                    targetLine: streamTarget,
                    code: shadowCodeBuffer
                };
                
                const verification = await runVerificationAgent(techSpec, draftDiff, logCallback);

                if (verification.passed) {
                    finalDiff = draftDiff;
                    logCallback("Coordinator: QA Passed. Breaking loop.", "success", "Code verified against spec.");
                    break; 
                } else {
                    //  PERSISTENT LOG: Send the QA Rejection directly to the chat UI!
                    logCallback(`Coordinator: Verifier rejected attempt ${attempts}.`, "error", `QA Critique:\n${verification.critique}`);
                    techSpec += `\n\nCRITICAL ERROR IN PREVIOUS ATTEMPT.\nVerifier Critique: ${verification.critique}\nYou MUST fix this in your next output. Make sure you use <filepath> tags!`;
                }
            }

            return finalDiff;
        } catch (error: any) {
            logCallback(`Coordinator Error: ${error.message}`, "error", error.message);
            return null;
        }
    }
}