// src/agents/Coordinator.ts

import * as path from 'path';
import * as vscode from 'vscode';
import { runExplorerAgent } from './exploreAgent';
import { runPlannerAgent } from './planAgent';
import { runVerificationAgent } from './verificationAgent';
import { getProvider } from '../llm';
import type { ChatMessage } from '../llm';
import { IEnvironment } from '../interfaces/IEnvironment';
import { errorMessage, isAbortError } from '../utilities/errors';
// Component 2B-3c: tool dispatch + lifecycle events (Option C stepping-stone).
import { getToolDefinitions } from './toolRegistry';
import { dispatchWithEvents } from './toolDispatchWithEvents';
import { buildSecurityHook } from './securityHook';
import type { ToolEventEmitter } from './toolEventEmitter';

export interface CodeDiff {
    filepath: string;
    searchBlock: string;
    replaceBlock: string;
    fullOutputBuffer: string;
    /**
     * Component 2B-3c (stepping-stone Option C): when present, this is
     * the post-modification full content of the target file. The apply
     * path in SidebarProvider uses it directly rather than running the
     * legacy search/replace dance.
     *
     * Why opt-in: legacy callers (planner that returns SEARCH/REPLACE
     * blocks, verifier that synthesizes CodeDiff from text output) keep
     * working without setting this field. Only swarmDraftCode (which
     * now uses tool calls that actually modify the file) populates it.
     *
     * Invariant when set: searchBlock holds the pre-modification full
     * file content, replaceBlock holds the post-modification full
     * content. This preserves the verifier's existing input contract
     * (it still receives a usable CodeDiff) without forcing every
     * caller to understand the new mechanism.
     */
    finalContent?: string;
    /**
     * Component 2B-3c (post-2B audit): set to true when swarmDraftCode's
     * ReAct loop completed but the model never dispatched a successful
     * write_file or edit_file call. Common cause: endpoint's tool-call
     * parser doesn't recognize the model's emission format, so what
     * looked like a tool call to the model was treated as plain text
     * by the adapter and never reached our dispatcher.
     *
     * The Coordinator's retry loop checks this flag before the verifier
     * runs — there's no point compiling a file the model never modified.
     * Setting this flag short-circuits to a corrective retry message
     * rather than a false-pass via the compiler.
     */
    noModifyingToolCalls?: boolean;
}

/**
 * Component 2B-3c: swarmDraftCode rewritten for stepping-stone Option C.
 *
 * The model emits `write_file` / `edit_file` tool calls (instead of
 * markdown SEARCH/REPLACE blocks). The dispatcher actually applies
 * those calls — the file on disk changes during this function.
 *
 * Compatibility shim: synthesizes a CodeDiff with searchBlock=pre-mod,
 * replaceBlock=post-mod, finalContent=post-mod. The existing verifier
 * gets a usable CodeDiff (Q8=8C lock honored — verifier stays procedural).
 * The apply path (SidebarProvider) uses finalContent when present.
 *
 * Rollback contract:
 *   - Caller passes pre-mod content via `fileContent` param
 *   - This function writes pre-mod to disk BEFORE the ReAct loop, so
 *     each retry attempt starts from the same baseline (rollback is
 *     implicit: the next attempt's setup wipes the previous attempt's
 *     changes)
 *   - On verifier rejection → next swarmDraftCode call → pre-mod restored
 *   - On final rejection (max retries) → caller's responsibility to
 *     restore (Coordinator does this in the outer loop)
 *
 * ReAct loop:
 *   - System prompt instructs the model to use write_file/edit_file
 *   - streamChatCompletion yields text + tool_call deltas
 *   - Tool calls dispatch through dispatchWithEvents (lifecycle events
 *     surface to UI, security hook gates bash_exec)
 *   - Loop ends when finish delta has reason='stop' (model says done)
 *     or when MAX_STEPS is reached (runaway protection)
 */
export async function swarmDraftCode(
    techSpec: string,
    filepath: string,
    fileContent: string,
    chatHistory: { role: string; content: string }[],
    globalRules: string,
    workspaceRoot: string,
    taskId: string,
    streamCallback?: (token: string) => void,
    signal?: AbortSignal,
    usageCallback?: (usage: any) => void,
    emitter?: ToolEventEmitter
): Promise<CodeDiff> {
    const provider = await getProvider();

    // STEP 1: Restore pre-mod content to disk. Each attempt starts from
    // the same baseline — without this, attempt 2 would build on
    // attempt 1's rejected state (which the verifier didn't approve).
    // Skip for new-file case (filepath === 'unknown' or content is "").
    const targetUri = vscode.Uri.file(path.join(workspaceRoot, filepath));
    if (filepath !== 'unknown') {
        try {
            await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(fileContent));
        } catch {
            // Parent directory might not exist yet (new-file case). The
            // model's write_file tool will handle creation.
        }
    }

    // STEP 2: Build the tool catalog. Code drafting uses file
    // manipulation + read tools. Excludes bash_exec/run_tests/
    // install_package/git_commit (verifier owns those) and web_fetch
    // (not needed for code drafting).
    const codingTools = getToolDefinitions([
        'read_file',
        'list_directory',
        'search_codebase',
        'write_file',
        'edit_file'
    ]);

    const systemPrompt = `You are an elite AI Coder Agent executing an autonomous sub-task.
Your sole purpose is to modify a single file based on the Technical Spec.

--- CRITICAL PROJECT RULES (.nexus/steering) ---
${globalRules ? globalRules : "No custom rules defined. Follow standard best practices and conventions for the language of the target file."}
-------------------------------------------------------

You have tools available:
  - read_file: re-read a file's current content
  - list_directory: explore neighboring files
  - search_codebase: find references to a symbol
  - write_file: replace the entire content of a file (preferred for new files or major changes)
  - edit_file: surgical edit of a specific block (preferred for small targeted changes)

CRITICAL RULES:
1. ALWAYS use write_file or edit_file to make your changes — do NOT emit code in chat or markdown blocks. The chat output is for your reasoning only.
2. NO PHANTOM IMPORTS: You are in SINGLE-FILE MODE. Modify only ${filepath}. Do NOT refactor logic into other files that don't exist yet. Write or keep the logic INLINE.
3. When you finish, end with a brief one-line summary of what you changed. Do NOT keep calling tools after the file is written.`;

    const userPrompt = `Task Spec:\n${techSpec}\n\nTarget File: ${filepath}\n\nCurrent Content:\n\`\`\`\n${fileContent}\n\`\`\``;

    const normalizedHistory = chatHistory.map(m => ({
        role: (m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant') as 'user' | 'system' | 'assistant',
        content: m.content
    }));

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
        ...normalizedHistory
    ];

    const securityHook = buildSecurityHook();
    const MAX_STEPS = 6; // ReAct ceiling — prevents runaway tool cycles

    let outputBuffer = '';
    // Component 2B-3c (post-2B audit): track whether the model ever
    // dispatched a modifying tool call (write_file or edit_file).
    // If the model emits chat narrative without a single write/edit
    // tool call, the file on disk is left as pre-mod — for a new file
    // that means an empty file gets silently written. We need to
    // detect that and fail loudly so the Coordinator can re-prompt
    // (or surface the failure to the user). Common causes:
    //   - Endpoint's tool-call-parser doesn't match the model's
    //     emission format (e.g., vLLM --tool-call-parser qwen25_coder
    //     against a Qwen3-Coder model that uses a different tag scheme)
    //   - Model genuinely refused to emit a tool call and just chatted
    //   - Token limit hit before the tool-call structure completed
    let didModifyingToolCall = false;

    for (let step = 0; step < MAX_STEPS; step++) {
        // Build per-call options. tools/toolChoice on every iteration —
        // the model needs them on every turn to know what's available.
        const options: import('../llm').CompletionOptions = {
            tools: codingTools,
            toolChoice: 'auto',
            temperature: 0.1
        };
        if (signal) options.signal = signal;
        if (usageCallback) options.onUsage = usageCallback;

        const stream = await provider.streamChatCompletion(messages, options);

        // Accumulate the assistant's response from streamed deltas.
        let assistantText = '';
        const assistantToolCalls: import('../llm').ToolCall[] = [];
        let finishReason: string = 'stop';

        for await (const delta of stream) {
            if (delta.kind === 'text') {
                assistantText += delta.content;
                outputBuffer += delta.content;
                if (streamCallback) streamCallback(delta.content);
            } else if (delta.kind === 'tool_call') {
                assistantToolCalls.push(delta.toolCall);
            } else if (delta.kind === 'finish') {
                finishReason = delta.reason;
            }
        }

        // Push the assistant message to history for next iteration. We
        // include both content and tool_calls — providers expect this
        // structure (content can be empty when tool_calls present).
        const assistantMessage: import('../llm').AssistantMessage = {
            role: 'assistant',
            content: assistantText
        };
        if (assistantToolCalls.length > 0) {
            assistantMessage.tool_calls = assistantToolCalls;
        }
        messages.push(assistantMessage);

        // Dispatch tool calls if present.
        if (assistantToolCalls.length > 0) {
            for (const toolCall of assistantToolCalls) {
                const dispatchOpts: import('./toolDispatchWithEvents').DispatchWithEventsOptions = {
                    source: 'coordinator',
                    taskId,
                    preDispatchHook: securityHook
                };
                if (emitter) dispatchOpts.emitter = emitter;
                const ctx: import('./toolRegistry').ToolExecutionContext = { workspaceRoot };
                if (signal) ctx.signal = signal;

                const dispatchResult = await dispatchWithEvents(toolCall, ctx, dispatchOpts);

                // Track whether this dispatch actually modified the file.
                // We only flag write_file / edit_file calls that succeeded
                // (status='success'); read-only tools and failed writes
                // don't count toward "the model did real work."
                if (
                    (toolCall.function.name === 'write_file' ||
                     toolCall.function.name === 'edit_file') &&
                    dispatchResult.uiPayload.kind !== 'error'
                ) {
                    didModifyingToolCall = true;
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: dispatchResult.llmContent
                });
            }
            // Loop back so the LLM can react to the tool results.
            continue;
        }

        // No tool calls in this turn. If finish was 'stop', the model
        // is done. Otherwise treat as anomaly and break (rare —
        // 'length' means token limit, 'content_filter' is provider-side).
        if (finishReason === 'stop' || finishReason === 'tool_calls') {
            break;
        }
        // Unexpected finish reason — log and break.
        if (streamCallback) {
            streamCallback(`\n[Coder] Unexpected finish reason: ${finishReason}\n`);
        }
        break;
    }

    // STEP 3: Read the post-modification content from disk. The model's
    // write_file/edit_file calls have already executed; disk reflects
    // their cumulative effect.
    let postModContent = '';
    if (filepath !== 'unknown') {
        try {
            const fileData = await vscode.workspace.fs.readFile(targetUri);
            postModContent = new TextDecoder().decode(fileData);
        } catch {
            // File still doesn't exist — model didn't create it. This
            // is a soft failure; we return an empty diff and let the
            // verifier reject. The Coordinator's retry loop handles
            // re-prompting.
            postModContent = '';
        }
    }

    // STEP 4: Synthesize CodeDiff. searchBlock = pre-mod, replaceBlock
    // = post-mod, finalContent = post-mod. The verifier sees a usable
    // diff; the SidebarProvider apply path uses finalContent directly.
    //
    // If the ReAct loop completed without ever dispatching a successful
    // write_file/edit_file, flag the diff so the Coordinator can fail
    // the attempt with a corrective message rather than feeding empty
    // output to the verifier.
    const result: CodeDiff = {
        filepath,
        searchBlock: fileContent,        // pre-modification
        replaceBlock: postModContent,    // post-modification
        fullOutputBuffer: outputBuffer,  // model's narrative for logs/debugging
        finalContent: postModContent     // signal to apply path: use this directly
    };
    if (!didModifyingToolCall) {
        result.noModifyingToolCalls = true;
    }
    return result;
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
        _lspContext: string,
        activeRequirements: string,
        activeDesign: string,
        previousFailures: string,
        globalRules: string,
        logCallback: (msg: string, stepType?: string, details?: string) => void,
        streamCallback?: (token: string) => void,
        signal?: AbortSignal,
        usageCallback?: (usage: any) => void,
        // Component 2B-3c: per-session lifecycle event emitter. When
        // provided, swarmDraftCode's tool calls emit started/output/
        // completed events. When absent, dispatch is silent — useful
        // for headless invocations (CLI runtime, tests).
        toolEventEmitter?: ToolEventEmitter
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

            if (explicitTargetMatch && explicitTargetMatch[1] !== undefined) {
                filesToModify.push(explicitTargetMatch[1].trim());
                logCallback(
                    `Coordinator: Strict target detected [${explicitTargetMatch[1].trim()}]. Lock-on engaged.`,
                    "analyze"
                );
            } else {
                // Fall back to the planner's <files_to_modify> block.
                const filesMatch = techSpec.match(/<files_to_modify>([\s\S]*?)<\/files_to_modify>/);
                if (filesMatch && filesMatch[1] !== undefined) {
                    const fileRegex = /<file>([^<]+)<\/file>/g;
                    let match: RegExpExecArray | null;
                    while ((match = fileRegex.exec(filesMatch[1])) !== null) {
                        if (match[1] !== undefined) filesToModify.push(match[1].trim());
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

                    const draftDiff: CodeDiff = await swarmDraftCode(
                        techSpec,
                        filepath,
                        fileContentStr,
                        chatHistory,
                        globalRules,
                        workspaceRoot,
                        // taskId for lifecycle event seq stamping. The
                        // task descriptor `task` is already a unique
                        // string for this run; suffix with filepath so
                        // multi-file tasks don't collide on seq counters.
                        `${task}::${filepath}`,
                        streamCallback,
                        signal,
                        usageCallback,
                        toolEventEmitter
                    );

                    // Component 2B-3c (post-2B audit): short-circuit if
                    // the model never dispatched a write_file/edit_file
                    // tool call. Running the verifier in this case is
                    // wasteful (compiling unchanged code) AND can mask
                    // the failure (an empty new file compiles "fine"
                    // for some tsc configs, leading the user to think
                    // their request succeeded when nothing was written).
                    //
                    // Symptoms diagnosed in the wild:
                    //   - Model emitted `<tool_call>` XML inside content
                    //     instead of OpenAI tool_calls (parser config
                    //     mismatch on vLLM)
                    //   - Model truncated mid-tool-call due to token
                    //     limit
                    //   - Model genuinely refused to use tools
                    //
                    // We treat this as a verification failure with a
                    // corrective message to the next attempt's history.
                    if (draftDiff.noModifyingToolCalls) {
                        const critique =
                            `Model did not invoke write_file or edit_file. The file on disk was not modified.\n\n` +
                            `Common causes:\n` +
                            `  - Tool-call format not recognized by the endpoint (check vLLM --tool-call-parser config)\n` +
                            `  - Model emitted a malformed tool-call wrapper instead of the expected JSON\n` +
                            `  - Model wrote code in chat narrative instead of using the tool\n\n` +
                            `You MUST use the write_file or edit_file tool to modify the file. Do not output code in chat.`;

                        logCallback(
                            `Coder [${filepath}]: No modifying tool calls in attempt ${attempts}.`,
                            "error",
                            critique
                        );

                        if (streamCallback) {
                            streamCallback(
                                `\n\n> ❌ **Attempt ${attempts} produced no file modifications.** Re-prompting model.\n`
                            );
                        }

                        chatHistory.push({ role: "assistant", content: draftDiff.fullOutputBuffer });
                        chatHistory.push({ role: "user", content: critique });
                        // Skip verifier; go to next attempt.
                        continue;
                    }

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

                    // Component 2B-3c: pass the model's narrative output
                    // back as assistant turn for the next retry. The
                    // file on disk will be reverted by swarmDraftCode at
                    // the start of the next attempt (it writes pre-mod
                    // content before the ReAct loop), so the "REVERTED"
                    // claim in the next user turn remains truthful.
                    chatHistory.push({ role: "assistant", content: draftDiff.fullOutputBuffer });
                    chatHistory.push({
                        role: "user",
                        content: `🚨 VERIFIER REJECTED YOUR CODE 🚨\n\nCritique:\n${verification.critique}\n\nCRITICAL REVERT NOTICE: Because your code was rejected, it was NOT saved. The file has been REVERTED to its original state. If using <<<<SEARCH, it MUST target the original file content, NOT your failed code.\n\nPHANTOM IMPORT WARNING: If you received a "Cannot find module" or "is not a module" error, you hallucinated an import. Do NOT try to create the missing file via markdown. Either fix the import or write the logic INLINE in this current file.\n\nYou MUST fix the errors in your next attempt.`
                    });
                }

                if (finalDiff) {
                    allDiffs.push(finalDiff);
                } else {
                    // Component 2B-3c (post-2B audit): max retries exhausted.
                    // Under Option C the file on disk is whatever the last
                    // attempt left there (post-mod for whatever the model
                    // produced, which the verifier rejected). Restore the
                    // file to its pre-mod content before throwing — without
                    // this, an existing file gets clobbered with the failed
                    // model output and the user loses their original code.
                    //
                    // For new-file case (filepath was 'unknown' or the file
                    // didn't exist when swarmDraftCode started), pre-mod
                    // content was empty, so we delete the file rather than
                    // leave a zero-byte stub on disk.
                    if (filepath !== 'unknown') {
                        const targetUri = vscode.Uri.file(path.join(workspaceRoot, filepath));
                        try {
                            if (fileContentStr !== "") {
                                // File pre-existed — restore the original content.
                                await vscode.workspace.fs.writeFile(
                                    targetUri,
                                    new TextEncoder().encode(fileContentStr)
                                );
                            } else {
                                // Pre-mod was empty (new file). Delete the
                                // partial result rather than leave it.
                                try {
                                    await vscode.workspace.fs.delete(targetUri);
                                } catch {
                                    // Ignore if already gone or never created.
                                }
                            }
                        } catch (restoreErr: unknown) {
                            // Restoration is best-effort. Log but don't
                            // mask the original failure with a restore error.
                            logCallback(
                                `Coordinator: Could not restore ${filepath} after retry exhaustion: ${errorMessage(restoreErr)}`,
                                "error"
                            );
                        }
                    }

                    throw new Error(
                        `Swarm failed to generate verified code for ${filepath} after ${MAX_RETRIES} attempts.`
                    );
                }
            }

            return allDiffs;

        } catch (error: unknown) {
            // Catch wrapped abort errors from cancel button or timeout.
            if (isAbortError(error)) {
                logCallback(`Coordinator: Task Cancelled or Timed Out.`, "error", "AbortError");
                const abortErr = new Error('AbortError');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
            const msg = errorMessage(error);
            logCallback(`Coordinator Error: ${msg}`, "error", msg);
            return null;
        }
    }
}