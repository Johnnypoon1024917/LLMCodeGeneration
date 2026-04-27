// src/agents/Coordinator.ts

import * as path from 'path';
import * as vscode from 'vscode';
import { runExplorerAgent } from './exploreAgent';
import { runPlannerAgent } from './planAgent';
import { runVerificationAgent } from './verificationAgent';
import { getLLMConfig, resilientFetch, authHeaders  } from '../llmService';
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
    chatHistory: { role: string; content: string }[],
    globalRules: string,
    streamCallback?: (token: string) => void,
    signal?: AbortSignal,
    usageCallback?: (usage: any) => void
): Promise<string> {
    const { endpoint, model, apiKey } = await getLLMConfig();

    const systemPrompt = `You are an elite AI Coder Agent executing an autonomous sub-task.
Your sole purpose is to modify a single file based on the Technical Spec.

--- CRITICAL PROJECT RULES (.nexus/steering) ---
${globalRules ? globalRules : "No custom rules defined. Follow standard best practices and conventions for the language of the target file."}
-------------------------------------------------------

Output Format Options:
OPTION 1: Full File Rewrite (Preferred for new files or major changes)
Just output the complete, syntactically correct code inside a standard markdown block. No SEARCH/REPLACE tags needed.

OPTION 2: Search and Replace (Preferred for small targeted edits)
<<<<SEARCH
[exact code to replace from the existing file]
====
[new syntactically correct code to insert]
>>>>REPLACE

CRITICAL RULES:
1. The SEARCH block MUST match the existing file content exactly, including whitespace and indentation.
2. EXTREMELY IMPORTANT: Output ONLY ONE format. NEVER output multiple SEARCH blocks.
3. Do NOT output conversational filler. Output only the requested code.
4. NO PHANTOM IMPORTS: You are in SINGLE-FILE MODE. You cannot create or edit multiple files at once. DO NOT refactor logic into controllers, services, or middlewares that do not exist yet. Write or keep the logic INLINE.`;

    const userPrompt = `Task Spec:\n${techSpec}\n\nTarget File: ${filepath}\n\nCurrent Content:\n\`\`\`\n${fileContent}\n\`\`\``;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
        ...chatHistory
    ];

    const response = await resilientFetch(endpoint, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.1,
            stream: true,
            stream_options: { include_usage: true }
        }),
        signal: signal
    });

    if (!response.body) {
        throw new Error("No readable stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                try {
                    const dataStr = line.substring(6).trim();
                    if (!dataStr) {
                        continue;
                    }

                    const data = JSON.parse(dataStr);

                    if (data.usage && usageCallback) {
                        usageCallback(data.usage);
                    }

                    const token = data.choices?.[0]?.delta?.content || "";
                    buffer += token;

                    if (streamCallback && token) {
                        streamCallback(token);
                    }
                } catch (e) {
                    // Tolerate malformed SSE frames silently — they happen on partial chunks
                }
            }
        }
    }

    return buffer;
}

/**
 * Reads `nexuscode.maxVerificationRetries` from VS Code config with a safe fallback.
 * Falls back to the default if vscode.workspace.getConfiguration is unavailable
 * (e.g. when this file is exercised from `cli.ts` outside the extension host).
 */
function readMaxRetries(defaultValue: number = 2): number {
    try {
        const cfg = vscode.workspace.getConfiguration('nexuscode');
        const v = cfg.get<number>('maxVerificationRetries');
        if (typeof v === 'number' && v >= 1 && v <= 5) {
            return v;
        }
    } catch {
        // Headless / CLI mode — vscode may be undefined
    }
    return defaultValue;
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
        globalRules: string,
        logCallback: (msg: string, stepType?: string, details?: string) => void,
        streamCallback?: (token: string) => void,
        signal?: AbortSignal,
        usageCallback?: (usage: any) => void
    ): Promise<CodeDiff[] | null> {

        logCallback("Coordinator: Task received. Initiating Swarm Orchestration...", "analyze", "Booting Swarm Agents");

        try {
            const codebaseContext = await runExplorerAgent(task, workspaceRoot, logCallback);

            // ──────────────────────────────────────────────────────────────────
            // FIXED CALL — arguments now line up with the planner's signature.
            // Order:  task → workspaceRoot → initialContext → prd → design
            //         → failures → globalRules → log
            // ──────────────────────────────────────────────────────────────────
            const techSpec = await runPlannerAgent(
                task,                   // task
                workspaceRoot,          // workspaceRoot  (real filesystem path — used by tool calls)
                codebaseContext,        // initialContext (output of the explorer)
                activeRequirements,     // prd
                activeDesign,           // design
                previousFailures,       // failures
                globalRules,            // globalRules    (steering rules — newly threaded through)
                logCallback             // log
            );

            const filesToModify: string[] = [];

            // Strict target lock-on: if the UI already passed a target file in the
            // task description, trust it over anything the planner inferred.
            const explicitTargetMatch =
                task.match(/Target File:\s*([^\n]+)/i) ||
                task.match(/File:\s*`([^`]+)`/i);

            if (explicitTargetMatch) {
                filesToModify.push(explicitTargetMatch[1].trim());
                logCallback(
                    `Coordinator: Strict target detected [${explicitTargetMatch[1].trim()}]. Lock-on engaged.`,
                    "analyze"
                );
            } else {
                // Fall back to the planner's <files_to_modify> block.
                const filesMatch = techSpec.match(/<files_to_modify>([\s\S]*?)<\/files_to_modify>/);
                if (filesMatch) {
                    const fileRegex = /<file>([^<]+)<\/file>/g;
                    let match: RegExpExecArray | null;
                    while ((match = fileRegex.exec(filesMatch[1])) !== null) {
                        filesToModify.push(match[1].trim());
                    }
                }
            }

            if (filesToModify.length === 0) {
                logCallback(
                    "Coordinator: No explicit files to modify found in plan. Falling back to dynamic inference.",
                    "analyze"
                );
                filesToModify.push("unknown");
            }

            const allDiffs: CodeDiff[] = [];
            const MAX_RETRIES = readMaxRetries(2);

            for (const filepath of filesToModify) {
                logCallback(`Coordinator: Spawning Coder Agent for [${filepath}]...`, "code");

                let fileContentStr = "";
                if (filepath !== "unknown") {
                    try {
                        const absolutePath = path.join(workspaceRoot, filepath);
                        fileContentStr = await env.readFile(absolutePath);
                    } catch (e) {
                        logCallback(
                            `Coordinator: File ${filepath} not found on disk. Assuming new file creation.`,
                            "analyze"
                        );
                    }
                }

                let attempts = 0;
                let finalDiff: CodeDiff | null = null;
                const chatHistory: { role: string; content: string }[] = [];

                while (attempts < MAX_RETRIES) {
                    attempts++;
                    logCallback(
                        `Coordinator: Drafting ${filepath} (Attempt ${attempts}/${MAX_RETRIES})...`,
                        "code",
                        "Coder Agent activated."
                    );

                    if (streamCallback) {
                        const separator = attempts === 1
                            ? `\n\n### Attempt 1 of ${MAX_RETRIES}\n`
                            : `\n\n---\n### Attempt ${attempts} of ${MAX_RETRIES}\n`;
                        streamCallback(separator);
                    }

                    const shadowCodeBuffer = await swarmDraftCode(
                        techSpec,
                        filepath,
                        fileContentStr,
                        chatHistory,
                        globalRules,
                        streamCallback,
                        signal,
                        usageCallback
                    );

                    const fullOutput = shadowCodeBuffer.replace(/\r\n/g, '\n');
                    const blockRegex = /<<<<SEARCH\s*?\n([\s\S]*?)\n\s*?====\s*?\n([\s\S]*?)\n\s*?>>>>REPLACE/g;
                    const matches = [...fullOutput.matchAll(blockRegex)];

                    let searchBlock = "";
                    let replaceBlock = "";

                    if (matches.length > 0) {
                        const lastMatch = matches[matches.length - 1];
                        searchBlock = lastMatch[1];
                        replaceBlock = lastMatch[2];
                    }

                    const parsedFilepathMatch = shadowCodeBuffer.match(/```[a-z]*\n\/\/\s*(.*)\n/);
                    const parsedFilepath = parsedFilepathMatch ? parsedFilepathMatch[1].trim() : filepath;

                    const draftDiff: CodeDiff = {
                        filepath: filepath === 'unknown' ? parsedFilepath : filepath,
                        searchBlock: searchBlock,
                        replaceBlock: replaceBlock,
                        fullOutputBuffer: shadowCodeBuffer
                    };

                    const verification = await runVerificationAgent(
                        env,
                        techSpec,
                        draftDiff,
                        workspaceRoot,
                        undefined,
                        logCallback
                    );

                    if (verification.usage && usageCallback) {
                        usageCallback(verification.usage);
                    }

                    if (verification.passed) {
                        finalDiff = draftDiff;

                        if (streamCallback) {
                            streamCallback(`\n\n✅ **Verification Passed!** Code approved for deployment.\n`);
                        }
                        logCallback(`Coder [${filepath}]: QA Passed.`, "success");
                        break;
                    }

                    logCallback(
                        `Coder [${filepath}]: Verifier rejected attempt ${attempts}.`,
                        "error",
                        `QA Critique:\n${verification.critique}`
                    );

                    if (streamCallback) {
                        streamCallback(
                            `\n\n> ❌ **Verifier Rejected Attempt ${attempts}:**\n> \n> ${verification.critique.replace(/\n/g, '\n> ')}\n`
                        );
                    }

                    chatHistory.push({ role: "assistant", content: shadowCodeBuffer });
                    chatHistory.push({
                        role: "user",
                        content: `🚨 VERIFIER REJECTED YOUR CODE 🚨\n\nCritique:\n${verification.critique}\n\nCRITICAL REVERT NOTICE: Because your code was rejected, it was NOT saved. The file has been REVERTED to its original state. If using <<<<SEARCH, it MUST target the original file content, NOT your failed code.\n\nPHANTOM IMPORT WARNING: If you received a "Cannot find module" or "is not a module" error, you hallucinated an import. Do NOT try to create the missing file via markdown. Either fix the import or write the logic INLINE in this current file.\n\nYou MUST fix the errors in your next attempt.`
                    });
                }

                if (finalDiff) {
                    allDiffs.push(finalDiff);
                } else {
                    throw new Error(
                        `Swarm failed to generate verified code for ${filepath} after ${MAX_RETRIES} attempts.`
                    );
                }
            }

            return allDiffs;

        } catch (error: any) {
            // Catch wrapped abort errors from cancel button or timeout.
            if (error?.name === 'AbortError' || error?.message?.includes('aborted')) {
                logCallback(`Coordinator: Task Cancelled or Timed Out.`, "error", "AbortError");
                const abortErr = new Error('AbortError');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
            logCallback(`Coordinator Error: ${error?.message ?? String(error)}`, "error", error?.message);
            return null;
        }
    }
}