// src/agents/CoderAgent.ts
//
// Streaming ReAct agent that drafts code for a single task. Replaces
// the legacy `swarmDraftCode` helper from Coordinator.ts as part of
// the C-4 sub-session of the Coordinator rewrite.
//
// Design (per COORDINATOR_REWRITE_DESIGN.md and the C-4 streaming
// decision):
//   - Uses `runReActStreaming` so model text deltas surface live to
//     the user via streamCallback. The Coder phase is the longest-
//     running visible part of execution; live tokens preserve the
//     "model is thinking" feedback users expect.
//   - 6-step ReAct ceiling — same as legacy swarmDraftCode.
//   - Tools: read_file, list_directory, search_codebase (read-only)
//     plus write_file, edit_file (modifying). No bash_exec/run_tests
//     (verifier owns those) and no web_fetch (not needed for code
//     drafting).
//   - Hardening: total-call budget ON; dedup OFF (Coder intentionally
//     re-reads after edits to verify changes landed); stuck-detector
//     OFF (rationale documented in the post-C-3 disable-stuck-detector
//     hotfix — dedup + budget cover what the detector caught).
//   - Atomic file ops: pre-mod content is restored to disk BEFORE the
//     loop runs (so retry attempts start from the same baseline) and
//     post-mod content is read AFTER the loop completes (the model's
//     write_file/edit_file tools write directly to disk during the
//     loop). This is intentional — keeping it inside CoderAgent
//     makes each run an atomic operation from the caller's view.
//   - Tracks `didModifyingToolCall` via the engine's onToolDispatched
//     callback. The Coordinator uses this to short-circuit verifier
//     when the model produced no real writes (common failure mode
//     when the endpoint's tool-call-parser is misconfigured).
//
// The function signature is wrapped in a static method (not a free
// function like swarmDraftCode was) for parity with PlannerAgent's
// shape — both are `Agent.run(opts)` with a single options bag.

import * as path from 'path';
import * as vscode from 'vscode';
import { runReActStreaming } from './ReAct';
import type { ReActConfig } from './ReAct';
import { getToolDefinitions } from './toolRegistry';
import { buildSecurityHook } from './securityHook';
import { RateLimiter, type RateLimiterConfig } from './rateLimiter';
import { buildRateLimitHook, composeHooks } from './rateLimitHook';
import type { ToolEventEmitter } from './toolEventEmitter';
import type { CodeDiff } from './Coordinator';
// Trigger registration of all tools by importing the barrel.
import './tools';

/**
 * Re-export `CodeDiff` from Coordinator.ts so callers can rely on a
 * single shape across both the legacy path (still emitting CodeDiffs
 * from generated SEARCH/REPLACE blocks) and the new CoderAgent path
 * (emitting CodeDiffs from in-memory write_file/edit_file dispatches).
 *
 * The two paths produce semantically equivalent CodeDiffs:
 *   - filepath: same
 *   - searchBlock: pre-modification full content (was: SEARCH block)
 *   - replaceBlock: post-modification full content (was: REPLACE block)
 *   - fullOutputBuffer: model narrative for logs
 *   - finalContent: opt-in field — when set, the apply path uses it
 *     directly (CoderAgent always sets it)
 *   - noModifyingToolCalls: opt-in flag for "model produced no real
 *     writes" failure mode
 */
export type { CodeDiff } from './Coordinator';

/**
 * Inputs for one Coder run.
 */
export interface CoderAgentOptions {
    /** The technical spec produced by the Planner — what to do. */
    techSpec: string;

    /** Target file path (workspace-relative). May be 'unknown' for
     *  new-file scenarios where the planner couldn't resolve a path
     *  ahead of time. */
    filepath: string;

    /** Pre-modification content of the target file. Empty string for
     *  new files. The Coder writes this back to disk before the loop
     *  so retry attempts start from the same baseline. */
    fileContent: string;

    /** Conversation history from the chat thread (system/user/assistant
     *  turns prior to this task). Plumbed into the model's context. */
    chatHistory: { role: string; content: string }[];

    /** Steering rules from .nexusrules / .nexus/steering. Injected
     *  into the system prompt. */
    globalRules: string;

    /** Absolute filesystem path used by tool dispatches. */
    workspaceRoot: string;

    /** Task ID for lifecycle event sequence stamping. Same convention
     *  as Coordinator: `${task}::${filepath}` so multi-file tasks
     *  don't collide on seq counters. */
    taskId: string;

    /** Streaming callback for live token output. Required for the
     *  webview's per-task chat panel. Optional — if omitted, the
     *  engine still works (text accumulates internally) but no UI
     *  updates fire. */
    streamCallback?: (token: string) => void;

    /** Abort signal. Propagated to the provider's stream and tool
     *  dispatches. */
    abortSignal?: AbortSignal;

    /** Token usage callback. Forwarded from provider.streamChatCompletion. */
    usageCallback?: (usage: unknown) => void;

    /** Lifecycle event emitter for tool calls. When provided, rich
     *  cards render in the webview as the Coder dispatches each tool. */
    emitter?: ToolEventEmitter;
}

const SYSTEM_PROMPT_TEMPLATE = (filepath: string, globalRules: string) =>
    `You are an elite AI Coder Agent executing an autonomous sub-task.
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

/**
 * Restore pre-modification content to disk so each retry attempt
 * starts from the same baseline. Skipped when filepath === 'unknown'
 * (new-file case where the planner couldn't resolve the path) or
 * when fileContent is empty.
 *
 * Failures here are tolerated — parent directory might not exist yet
 * for new files; the model's write_file tool will handle creation.
 */
/**
 * Reads rate-limit config from VS Code settings with safe fallbacks.
 * Mirrors the readMaxRetries pattern in Coordinator.ts — wraps the
 * vscode call in try/catch so headless / CLI mode (where vscode is
 * unavailable) gets the defaults rather than crashing.
 *
 * Settings consulted:
 *   - `nexuscode.rateLimits.maxToolCallsPerTask` (number)
 *   - `nexuscode.rateLimits.perTool` (object: tool name → cap)
 *
 * If a setting is missing or has an invalid shape, the corresponding
 * RateLimiter default is used (RateLimiter.DEFAULT_MAX_TOTAL = 100;
 * empty perTool map = no per-tool caps).
 */
function readRateLimitConfig(): RateLimiterConfig {
    const config: RateLimiterConfig = {};
    try {
        const cfg = vscode.workspace.getConfiguration('nexuscode');

        const maxTotalRaw = cfg.get<number>('rateLimits.maxToolCallsPerTask');
        // Accept any non-negative integer. 0 is valid (effectively
        // disable). Negative values fall back to the default.
        if (typeof maxTotalRaw === 'number' && maxTotalRaw >= 0 && Number.isInteger(maxTotalRaw)) {
            config.maxTotal = maxTotalRaw;
        }

        const perToolRaw = cfg.get<unknown>('rateLimits.perTool');
        // Validate shape: must be a plain object whose values are
        // non-negative integers. Reject malformed entries individually
        // rather than rejecting the whole map — a customer with one
        // typo'd tool name shouldn't lose all rate limits.
        if (perToolRaw !== null && typeof perToolRaw === 'object' && !Array.isArray(perToolRaw)) {
            const perTool: Record<string, number> = {};
            for (const [k, v] of Object.entries(perToolRaw as Record<string, unknown>)) {
                if (typeof v === 'number' && v >= 0 && Number.isInteger(v)) {
                    perTool[k] = v;
                }
            }
            if (Object.keys(perTool).length > 0) {
                config.perTool = perTool;
            }
        }
    } catch {
        // vscode unavailable (CLI/test). Use defaults.
    }
    return config;
}

async function restorePreModContent(
    workspaceRoot: string,
    filepath: string,
    fileContent: string
): Promise<vscode.Uri | null> {
    if (filepath === 'unknown') return null;
    const targetUri = vscode.Uri.file(path.join(workspaceRoot, filepath));
    try {
        await vscode.workspace.fs.writeFile(
            targetUri,
            new TextEncoder().encode(fileContent)
        );
    } catch {
        // Tolerate — parent dir may not exist (new-file case).
    }
    return targetUri;
}

/**
 * Read post-modification content from disk after the loop completes.
 * The model's write_file/edit_file calls have already executed during
 * the loop; the disk reflects their cumulative effect.
 *
 * If the file still doesn't exist (model didn't create it), returns
 * "" — the Coordinator's retry loop handles re-prompting via the
 * verifier critique path.
 */
async function readPostModContent(targetUri: vscode.Uri | null): Promise<string> {
    if (!targetUri) return '';
    try {
        const fileData = await vscode.workspace.fs.readFile(targetUri);
        return new TextDecoder().decode(fileData);
    } catch {
        return '';
    }
}

export class CoderAgent {
    /**
     * Run the Coder against one task. Always returns a CodeDiff —
     * never throws on "no modification" (that's signalled via
     * `noModifyingToolCalls: true`). Throws only on engine errors
     * (budget exceeded, provider failure, abort).
     */
    static async run(opts: CoderAgentOptions): Promise<CodeDiff> {
        // ─── Pre-mod restore ──────────────────────────────────────────
        // Each retry attempt starts from the same on-disk baseline.
        const targetUri = await restorePreModContent(
            opts.workspaceRoot,
            opts.filepath,
            opts.fileContent
        );

        // ─── Tool catalog ────────────────────────────────────────────
        // Read + write tools. No bash_exec/run_tests/install_package/
        // git_commit (verifier owns those). No web_fetch (not needed
        // for drafting).
        const tools = getToolDefinitions([
            'read_file',
            'list_directory',
            'search_codebase',
            'write_file',
            'edit_file'
        ]);

        // ─── Rate limiter (D12) ──────────────────────────────────────
        // Per-task limiter constructed fresh for every CoderAgent.run.
        // Reads VS Code settings; falls back to RateLimiter defaults
        // (100 calls per task, no per-tool caps) when settings are
        // absent or malformed. The limiter is consumed by the
        // preDispatchHook composition below.
        const rateLimiter = new RateLimiter(readRateLimitConfig());

        // ─── Prompts ─────────────────────────────────────────────────
        const systemPrompt = SYSTEM_PROMPT_TEMPLATE(opts.filepath, opts.globalRules);
        const userPrompt =
            `Task Spec:\n${opts.techSpec}\n\n` +
            `Target File: ${opts.filepath}\n\n` +
            `Current Content:\n\`\`\`\n${opts.fileContent}\n\`\`\``;

        // Normalize chat history into the engine's ChatMessage shape.
        // The legacy swarmDraftCode did the same: collapse anything
        // that isn't 'user' or 'system' into 'assistant'.
        const normalizedHistory = opts.chatHistory.map(m => ({
            role: (m.role === 'user'
                ? 'user'
                : m.role === 'system'
                    ? 'system'
                    : 'assistant') as 'user' | 'system' | 'assistant',
            content: m.content
        }));

        // ─── Track narrative + modifying-tool-call usage ──────────────
        // outputBuffer accumulates ALL text content the streaming loop
        // produces — both via the user's streamCallback (live UI) and
        // for the returned CodeDiff (logs). We synthesize this from
        // the engine's streamCallback rather than relying on result
        // fields, so we capture it correctly even when no UI callback
        // is wired.
        let outputBuffer = '';
        const accumulatingStreamCallback = (token: string): void => {
            outputBuffer += token;
            if (opts.streamCallback) opts.streamCallback(token);
        };

        // didModifyingToolCall tracks whether the model ever
        // successfully dispatched a write_file or edit_file. Common
        // failure modes that produce false here:
        //   - Endpoint's tool-call-parser doesn't match the model's
        //     emission format
        //   - Model emitted tool-call XML inside content rather than
        //     as native tool_calls
        //   - Token limit hit before the tool-call structure completed
        //   - Model genuinely chatted instead of writing
        let didModifyingToolCall = false;

        // ─── Engine config ────────────────────────────────────────────
        const config: ReActConfig = {
            systemPrompt,
            userPrompt,
            // Per-agent routing: Coder uses 'coder' role so the model
            // can be tuned independently from Planner. Falls back to
            // the global default when `nexuscode.modelCoder` unset.
            role: 'coder',
            chatHistory: normalizedHistory,
            tools,
            workspaceRoot: opts.workspaceRoot,
            // Same 6-step ceiling as legacy swarmDraftCode.
            maxSteps: 6,
            // Same 0.1 temperature as legacy swarmDraftCode.
            temperature: 0.1,

            // No specific termination string — the Coder is "done" when
            // it stops calling tools. With no `repromptOnNonDone`, the
            // engine treats any non-tool turn as completion. Matches
            // the legacy behavior exactly.
            isDone: () => true,

            // Hardening: budget on, dedup off, stuck-detector off.
            // Rationale documented in the module header above.
            hardening: {
                enableTotalCallBudget: true,
                enableDedupCache: false,
                enableStuckLoopDetector: false
            },

            // Modifying tools deserve real security gating. The Planner
            // uses allowAllHook (read-only); the Coder needs the full
            // hook so dangerous bash_exec etc. (if ever added) gets
            // checked. write_file/edit_file have their own internal
            // checks for dangerous paths.
            //
            // D12: rate limiting composed AFTER security. Order matters
            // — security checks block dangerous calls regardless of
            // rate, then rate limiting catches the runaway-volume case.
            // See composeHooks docstring for the full rationale.
            preDispatchHook: composeHooks(
                buildSecurityHook(),
                buildRateLimitHook(rateLimiter)
            ),

            // Source tag for lifecycle events. Coder events render with
            // the 'coordinator' source — that's what the legacy
            // swarmDraftCode used and the webview's card design assumes.
            eventSource: 'coordinator',
            ...(opts.emitter
                ? { emitter: opts.emitter, taskId: opts.taskId }
                : {}),

            log: () => undefined, // Coder doesn't surface its own log lines —
                                   // the swarm-logs UI shows tool cards directly.

            streamCallback: accumulatingStreamCallback,

            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            ...(opts.usageCallback ? { usageCallback: opts.usageCallback } : {}),

            // Track modifying tool calls. Only successful dispatches
            // count (status='error' uiPayload kind doesn't count
            // toward "real work").
            onToolDispatched: (toolCall, dispatchResult) => {
                if (
                    (toolCall.function.name === 'write_file' ||
                     toolCall.function.name === 'edit_file') &&
                    dispatchResult.uiPayload.kind !== 'error'
                ) {
                    didModifyingToolCall = true;
                }
            }
        };

        // ─── Run the engine ───────────────────────────────────────────
        await runReActStreaming(config);

        // ─── Post-mod read + diff synthesis ───────────────────────────
        const postModContent = await readPostModContent(targetUri);

        const result: CodeDiff = {
            filepath: opts.filepath,
            searchBlock: opts.fileContent,
            replaceBlock: postModContent,
            fullOutputBuffer: outputBuffer,
            finalContent: postModContent
        };
        if (!didModifyingToolCall) {
            result.noModifyingToolCalls = true;
        }
        return result;
    }
}