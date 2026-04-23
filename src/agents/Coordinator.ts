// src/agents/Coordinator.ts
import * as path from 'path';
import { runExplorerAgent } from './exploreAgent';
import { runPlannerAgent } from './planAgent';
import { runVerificationAgent } from './verificationAgent';
import { getLLMConfig, resilientFetch } from '../llmService';
import { IEnvironment } from '../interfaces/IEnvironment';

export interface CodeDiff {
    filepath: string;
    searchBlock: string;
    replaceBlock: string;
    fullOutputBuffer: string; 
}

async function swarmDraftCode(
    techSpec: string,
    filepath: string,
    fileContent: string,
    streamCallback?: (token: string) => void
): Promise<string> {
    const { endpoint, model, apiKey } = await getLLMConfig();
    
    const systemPrompt = `You are an elite AI Coder Agent executing an autonomous sub-task. 
Your sole purpose is to modify a single file based on the Technical Spec.
You MUST use the EXACT SEARCH/REPLACE block format to modify the file safely.

Output Format:
<<<<SEARCH
[exact code to replace from the existing file]
====
[new syntactically correct code to insert]
>>>>REPLACE

CRITICAL RULES:
1. The SEARCH block MUST match the existing file content exactly.
2. If you are creating a completely new file, simply output the code directly (no SEARCH/REPLACE blocks needed).
3. Do NOT output conversational filler. Output the code.`;

    const userPrompt = `Task Spec:\n${techSpec}\n\nTarget File: ${filepath}\n\nCurrent Content:\n\`\`\`\n${fileContent}\n\`\`\``;

    const response = await resilientFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0.1,
            stream: true
        })
    });

    if (!response.body) throw new Error("No readable stream");
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                try {
                    const dataStr = line.substring(6).trim();
                    if (!dataStr) continue;
                    
                    const data = JSON.parse(dataStr);
                    const token = data.choices[0]?.delta?.content || "";
                    buffer += token;
                    
                    if (streamCallback && token) streamCallback(token);
                } catch (e) {}
            }
        }
    }
    
    return buffer;
}

export class SwarmCoordinator {
    static async executeTask(
        env: IEnvironment,
        task: string,
        workspaceRoot: string,
        lspContext: string,
        activeRequirements: string,
        activeDesign: string,
        previousFailures: string,
        codingStyle: string,
        logCallback: (msg: string, stepType?: string, details?: string) => void,
        streamCallback?: (token: string) => void
    ): Promise<CodeDiff[] | null> {
        
        logCallback("Coordinator: Task received. Initiating Swarm Orchestration...", "analyze", "Booting Swarm Agents");

        try {
            const codebaseContext = await runExplorerAgent(task, workspaceRoot, logCallback);
            
            let techSpec = await runPlannerAgent(
                task, 
                codebaseContext, 
                activeRequirements, 
                activeDesign, 
                previousFailures, 
                codingStyle, 
                logCallback
            );

            const filesToModify: string[] = [];
            const filesMatch = techSpec.match(/<files_to_modify>([\s\S]*?)<\/files_to_modify>/);
            
            if (filesMatch) {
                const fileRegex = /<file>([^<]+)<\/file>/g;
                let match;
                while ((match = fileRegex.exec(filesMatch[1])) !== null) {
                    filesToModify.push(match[1].trim());
                }
            }

            if (filesToModify.length === 0) {
                logCallback("Coordinator: No explicit files to modify found in plan. Falling back to dynamic inference.", "analyze");
                filesToModify.push("unknown");
            }

            const allDiffs: CodeDiff[] = [];
            const MAX_RETRIES = 3;

            for (const filepath of filesToModify) {
                logCallback(`Coordinator: Spawning Coder Agent for [${filepath}]...`, "code");

                let fileContentStr = "";
                if (filepath !== "unknown") {
                    try {
                        const absolutePath = path.join(workspaceRoot, filepath);
                        fileContentStr = await env.readFile(absolutePath);
                    } catch (e) {
                        logCallback(`Coordinator: File ${filepath} not found on disk. Assuming new file creation.`, "analyze");
                    }
                }

                let attempts = 0;
                let finalDiff: CodeDiff | null = null;

                while (attempts < MAX_RETRIES) {
                    attempts++;
                    logCallback(`Coordinator: Drafting ${filepath} (Attempt ${attempts}/${MAX_RETRIES})...`, "code", "Coder Agent activated.");
                    
                    const shadowCodeBuffer = await swarmDraftCode(
                        techSpec, 
                        filepath,
                        fileContentStr,
                        streamCallback
                    );
                    
                    const searchMatch = shadowCodeBuffer.match(/<<<<SEARCH\n([\s\S]*?)\n====/);
                    const replaceMatch = shadowCodeBuffer.match(/====\n([\s\S]*?)\n>>>>REPLACE/);
                    
                    const parsedFilepathMatch = shadowCodeBuffer.match(/```[a-z]*\n\/\/\s*(.*)\n/);
                    const parsedFilepath = parsedFilepathMatch ? parsedFilepathMatch[1].trim() : filepath;

                    const draftDiff: CodeDiff = {
                        filepath: filepath === 'unknown' ? parsedFilepath : filepath,
                        searchBlock: searchMatch ? searchMatch[1] : "",
                        replaceBlock: replaceMatch ? replaceMatch[1] : "",
                        fullOutputBuffer: shadowCodeBuffer
                    };
                    
                    // 🚀 Pass undefined for the testCommand so it runs fast!
                    const verification = await runVerificationAgent(env, techSpec, draftDiff, workspaceRoot, undefined, logCallback);

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