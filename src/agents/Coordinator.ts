// src/agents/Coordinator.ts

import * as path from 'path';
import * as vscode from 'vscode';
// Coordinator rewrite:
//   C-2: PlannerAgent replaces explorer + planner.
//   C-4: CoderAgent replaces swarmDraftCode (formerly inline in this
//        file). The swarmDraftCode function and its tool-dispatch
//        helpers are gone — all the Coder logic lives in CoderAgent now.
import { PlannerAgent } from './PlannerAgent';
import { CoderAgent } from './CoderAgent';
import { getProjectContext } from '../projectContext';
import { VerifierAgent } from './VerifierAgent';
import { IEnvironment } from '../interfaces/IEnvironment';
import { errorMessage, isAbortError } from '../utilities/errors';
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
     * working without setting this field. Only the CoderAgent path
     * (which uses tool calls that actually modify the file) populates it.
     *
     * Invariant when set: searchBlock holds the pre-modification full
     * file content, replaceBlock holds the post-modification full
     * content. This preserves the verifier's existing input contract
     * (it still receives a usable CodeDiff) without forcing every
     * caller to understand the new mechanism.
     */
    finalContent?: string;
    /**
     * Component 2B-3c (post-2B audit): set to true when the Coder's
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

/**
 * Options for {@link runTask}. Replaces the legacy 13-positional-arg
 * `SwarmCoordinator.executeTask` signature with a named-params object
 * (Coordinator rewrite C-5).
 *
 * Why named params: the legacy signature was a maintenance hazard.
 * Adding/removing/reordering parameters required updating every call
 * site and was error-prone — the SidebarProvider call site had 13
 * positional arguments, several of which had similar types
 * (`string`, callback functions). Named params eliminate the entire
 * class of "passed callback A where callback B was expected" bugs.
 *
 * Also note: the legacy `_lspContext` parameter was dead code (the
 * leading underscore acknowledged this — it was passed but never
 * used). It has been removed from the new shape entirely. The
 * SidebarProvider call site no longer computes the placeholder
 * `lspBlastRadiusContext` value.
 */
export interface RunTaskOptions {
    /** Environment abstraction (file system, LLM provider) — same
     *  shape as the legacy `env` parameter. */
    env: IEnvironment;

    /** The task description from the planner's task list, or the
     *  raw user prompt for ad-hoc execution. */
    task: string;

    /** Absolute filesystem path of the workspace. Used by tool
     *  dispatches and disk operations. */
    workspaceRoot: string;

    /** Active requirements.md content. Empty string if no PRD. */
    activeRequirements: string;

    /** Active design.md content. Empty string if no design doc. */
    activeDesign: string;

    /** Verifier critique from previous attempts (retry-with-context). */
    previousFailures: string;

    /** Steering rules from .nexusrules / .nexus/steering. */
    globalRules: string;

    /** High-level status messages from the Coordinator. The planner
     *  and coder use their own log surfaces; this is for top-level
     *  orchestration messages ("Coordinator: Task received...",
     *  "Coordinator: Verifier rejected..."). */
    log: (msg: string, stepType?: string, details?: string) => void;

    /** Live token streaming callback for the Coder phase. When omitted,
     *  the Coder still works (text accumulates internally) but no
     *  progressive UI updates fire. */
    streamCallback?: (token: string) => void;

    /** Abort signal — propagated to LLM calls and tool dispatches.
     *  Triggered by the cancel button or external timeout. */
    abortSignal?: AbortSignal;

    /** Token usage telemetry callback. Forwarded from the LLM provider's
     *  `onUsage` hook to the webview's tokenUsage panel. */
    usageCallback?: (usage: unknown) => void;

    /** Per-session lifecycle event emitter. When provided, the Coder's
     *  and Planner's tool calls emit started/output/completed events
     *  for the rich-card UI. When absent, dispatch is silent — used
     *  for headless invocations (CLI runtime, tests). */
    toolEventEmitter?: ToolEventEmitter;
}

/**
 * Run one task end-to-end: Planner → Coder → Verifier (with retries).
 * Returns the array of `CodeDiff` to apply, or `null` if the task
 * could not be completed (after all retries / on abort / on error).
 *
 * Replaces the legacy `SwarmCoordinator.executeTask` (Coordinator
 * rewrite C-5). Same external contract — same return shape, same
 * error handling — just a cleaner call signature.
 */
export async function runTask(opts: RunTaskOptions): Promise<CodeDiff[] | null> {
    // Destructure preserves the inner variable names used throughout
    // the body — keeps the C-5 diff localized to the call signature.
    const {
        env,
        task,
        workspaceRoot,
        activeRequirements,
        activeDesign,
        previousFailures,
        globalRules,
        log: logCallback,
        streamCallback,
        abortSignal: signal,
        usageCallback,
        toolEventEmitter,
    } = opts;

    logCallback("Coordinator: Task received. Initiating Swarm Orchestration...", "analyze", "Booting Swarm Agents");

    try {
        // Coordinator rewrite C-2: single planner replaces the
        // legacy explorer-then-planner pair. Context for the
        // planner now comes from `getProjectContext` (the
        // directory tree) instead of `runAgenticExploration`'s
        // 2-step pre-pass — the Planner does its own exploration
        // via the ReAct loop, so the pre-pass was redundant.
        //
        // This change resolves three of the audit's findings:
        //   - "Initializing Dynamic Search" hang (Explorer is gone)
        //   - Two visualization styles (Explorer used legacy
        //     statusCallback log lines; PlannerAgent uses rich
        //     toolEventEmitter cards)
        //   - Duplicate "Booting ReAct Engine" boot message
        //     (both agents emitted the same string)
        const codebaseContext = await getProjectContext(workspaceRoot);

        const plannerResult = await PlannerAgent.run({
            mode: 'build',
            task,
            workspaceRoot,
            initialContext:    codebaseContext,
            prd:               activeRequirements,
            design:            activeDesign,
            previousFailures,
            globalRules,
            log:               logCallback,
            ...(toolEventEmitter ? { toolEventEmitter } : {}),
            ...(signal ? { abortSignal: signal } : {}),
            ...(usageCallback ? { usageCallback } : {})
        });

        const techSpec = plannerResult.techSpec;

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

                const draftDiff: CodeDiff = await CoderAgent.run({
                    techSpec,
                    filepath,
                    fileContent: fileContentStr,
                    chatHistory,
                    globalRules,
                    workspaceRoot,
                    // taskId for lifecycle event seq stamping. The
                    // task descriptor `task` is already a unique
                    // string for this run; suffix with filepath so
                    // multi-file tasks don't collide on seq counters.
                    taskId: `${task}::${filepath}`,
                    ...(streamCallback ? { streamCallback } : {}),
                    ...(signal ? { abortSignal: signal } : {}),
                    ...(usageCallback ? { usageCallback } : {}),
                    ...(toolEventEmitter ? { emitter: toolEventEmitter } : {})
                });

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

                const verification = await VerifierAgent.run({
                    env,
                    techSpec,
                    draftDiff,
                    workspaceRoot,
                    log: logCallback,
                    // Coordinator rewrite C-6: optional emitter wiring.
                    // When provided, the verifier's tsc / npm install /
                    // test commands render as rich bash_output cards.
                    // taskId is suffixed `::verifier::filepath` so events
                    // don't collide with planner/coder events.
                    ...(toolEventEmitter ? { emitter: toolEventEmitter } : {}),
                    taskId: `${task}::verifier::${draftDiff.filepath}`,
                });

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
                // file on disk will be reverted by CoderAgent at
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
                // didn't exist when CoderAgent started), pre-mod
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