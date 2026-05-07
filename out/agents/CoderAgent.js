"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoderAgent = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const ReAct_1 = require("./ReAct");
const toolRegistry_1 = require("./toolRegistry");
const securityHook_1 = require("./securityHook");
const rateLimiter_1 = require("./rateLimiter");
const rateLimitHook_1 = require("./rateLimitHook");
const container_1 = require("../container");
// V2.0: per-role thinking-mode profile.
const llmService_1 = require("../llmService");
// Trigger registration of all tools by importing the barrel.
require("./tools");
// P1.2-followup (2026-05): Coder system prompt rewritten for Qwen3.6.
//
// The previous prompt was tuned for Qwen2.5-Coder, which needed heavy
// hand-holding around tool-call format and frequent reminders to
// "actually emit the tool call." Qwen3.6 has:
//   - Native function calling via the `qwen3_coder` tool-call parser
//   - Hybrid thinking mode (<think>...</think> blocks supported and
//     improve quality on complex tasks)
//   - Better instruction following (Qwen2.5's repeat-the-rule pattern
//     is no longer necessary; one clear statement is enough)
//   - 256K context (the verbose reminders no longer "cost nothing"
//     since longer prompts crowd out useful retrieval)
//
// Changes from the previous version:
//   - Length: ~2500 → ~1000 tokens (60% reduction)
//   - Removed text-based <tool_call>...</tool_call> fallback format —
//     was a Qwen2.5 workaround; Qwen3.6 handles native function calls
//   - Replaced 4× "MUST end with tool call" repetition with single
//     clear statement; modern Qwen instruction-followers don't need
//     the reinforcement
//   - Removed "NEVER emit reasoning-only text" prohibition — Qwen3.6
//     thinking mode emits useful <think> blocks; we want them
//   - Surfaced the planner's per-file <file_impact_analysis> so the
//     Coder reads the targeted file's existing_role / planned_change /
//     risk before writing
//   - Steering rules moved AFTER tool listing so they're closer to
//     the user's task instruction (recency bias of LLM attention)
//
// What stayed:
//   - The single-file modification invariant (NO PHANTOM IMPORTS)
//   - The package-list and type-symbol injection points
//   - The signature so all callers work unchanged
const SYSTEM_PROMPT_TEMPLATE = (filepath, globalRules, packagesSection, typeSymbolsSection) => `You are an elite AI Coder Agent executing one autonomous sub-task: modify a single file based on the Technical Spec from the Planner.

## Your turn must end with a write_file or edit_file tool call

That's the contract. The verifier checks for actual file modification; a turn without one is rejected.

If you need more information first, that's fine — emit a read_file / list_directory / search_codebase call instead, and the next turn writes the file. Do NOT mix exploration and writing in the same turn; each turn does one thing.

If you have nothing concrete to write because the previous turn already wrote it, emit a brief one-line summary with no tool call — that signals task completion.

## Tools

- read_file: re-read a file's current content
- list_directory: explore neighboring files
- search_codebase: find references to a symbol
- write_file: replace the entire content of a file (preferred for new files or major changes)
- edit_file: surgical edit of a specific block (preferred for small targeted changes)

## Reading the Planner's spec

The Technical Spec from the Planner contains a <file_impact_analysis> block with per-file reasoning. Find the entry for ${filepath}:

  <file path="${filepath}">
    <existing_role>...</existing_role>
    <planned_change>...</planned_change>
    <risk>low|medium|high</risk>
    <depends_on>...</depends_on>
  </file>

The <planned_change> describes WHAT to change. The <existing_role> tells you what the file does today (so you don't break unrelated functionality). <risk> calibrates your care: low-risk = quick edit, high-risk = careful symmetry with existing patterns.

If the spec lacks <file_impact_analysis> (legacy format), use the <execution_plan> block instead — same intent, less structured.

## Constraints

1. SINGLE-FILE MODE. Modify only ${filepath}. Don't refactor logic into other files that don't exist yet — write or keep the logic INLINE.

2. NO PHANTOM LIBRARIES. Don't import packages that aren't in the project's package.json (or equivalent for non-Node projects). If you genuinely need a new dependency, mention it in your one-line summary AFTER the tool call so the build system can install it.

3. NO MARKDOWN CODE BLOCKS as substitutes for tool calls. Code in \`\`\`typescript ... \`\`\` does NOT touch the filesystem. Only write_file / edit_file actually modifies disk.

4. Keep the one-line summary AFTER the tool call brief — what changed, in plain language. Don't explain what you're about to do; the user can see the diff.

${packagesSection}${typeSymbolsSection}## Project rules (.nexus/steering)

${globalRules ? globalRules : "No custom rules defined. Follow standard best practices and conventions for the language of the target file."}

## Final note

Your reasoning belongs INSIDE the file as comments where it adds value, NOT in chat. Use thinking mode to plan your edit; emit the tool call decisively. The user is watching a code editor, not a discussion.`;
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
function readRateLimitConfig() {
    const config = {};
    try {
        const cfg = (0, container_1.getDeps)().config;
        const maxTotalRaw = cfg.get('rateLimits.maxToolCallsPerTask');
        // Accept any non-negative integer. 0 is valid (effectively
        // disable). Negative values fall back to the default.
        if (typeof maxTotalRaw === 'number' && maxTotalRaw >= 0 && Number.isInteger(maxTotalRaw)) {
            config.maxTotal = maxTotalRaw;
        }
        const perToolRaw = cfg.get('rateLimits.perTool');
        // Validate shape: must be a plain object whose values are
        // non-negative integers. Reject malformed entries individually
        // rather than rejecting the whole map — a customer with one
        // typo'd tool name shouldn't lose all rate limits.
        if (perToolRaw !== null && typeof perToolRaw === 'object' && !Array.isArray(perToolRaw)) {
            const perTool = {};
            for (const [k, v] of Object.entries(perToolRaw)) {
                if (typeof v === 'number' && v >= 0 && Number.isInteger(v)) {
                    perTool[k] = v;
                }
            }
            if (Object.keys(perTool).length > 0) {
                config.perTool = perTool;
            }
        }
    }
    catch {
        // vscode unavailable (CLI/test). Use defaults.
    }
    return config;
}
async function restorePreModContent(workspaceRoot, filepath, fileContent) {
    if (filepath === 'unknown') {
        return null;
    }
    const targetUri = vscode.Uri.file(path.join(workspaceRoot, filepath));
    try {
        await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(fileContent));
    }
    catch {
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
async function readPostModContent(targetUri) {
    if (!targetUri) {
        return '';
    }
    try {
        const fileData = await vscode.workspace.fs.readFile(targetUri);
        return new TextDecoder().decode(fileData);
    }
    catch {
        return '';
    }
}
class CoderAgent {
    /**
     * Run the Coder against one task. Always returns a CodeDiff —
     * never throws on "no modification" (that's signalled via
     * `noModifyingToolCalls: true`). Throws only on engine errors
     * (budget exceeded, provider failure, abort).
     */
    static async run(opts) {
        // ─── Pre-mod restore ──────────────────────────────────────────
        // Each retry attempt starts from the same on-disk baseline.
        const targetUri = await restorePreModContent(opts.workspaceRoot, opts.filepath, opts.fileContent);
        // ─── Tool catalog ────────────────────────────────────────────
        // Read + write tools. No bash_exec/run_tests/install_package/
        // git_commit (verifier owns those). No web_fetch (not needed
        // for drafting).
        const tools = (0, toolRegistry_1.getToolDefinitions)([
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
        const rateLimiter = new rateLimiter_1.RateLimiter(readRateLimitConfig());
        // ─── Prompts ─────────────────────────────────────────────────
        const systemPrompt = SYSTEM_PROMPT_TEMPLATE(opts.filepath, opts.globalRules, opts.installedPackagesSection ?? '', opts.typeSymbolsSection ?? '');
        const userPrompt = `Task Spec:\n${opts.techSpec}\n\n` +
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
                    : 'assistant'),
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
        const accumulatingStreamCallback = (token) => {
            outputBuffer += token;
            if (opts.streamCallback) {
                opts.streamCallback(token);
            }
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
        // V2.0: fetch the thinking-mode profile for the Coder role.
        // Reads nexuscode.thinkingCoder + nexuscode.preserveThinking
        // from config; defaults to thinking ON for Qwen 3.6. When the
        // endpoint is non-thinking, extra_body is treated as opaque
        // pass-through and the request still succeeds.
        const thinkingProfile = await (0, llmService_1.getThinkingProfile)('coder');
        const config = {
            systemPrompt,
            userPrompt,
            // Per-agent model routing for the Coder role happens at the
            // provider layer via getLLMConfig('coder'), not via this
            // config. V2.0's thinkingProfile (set below) is the new
            // engine-level mechanism for per-role tuning of sampling
            // parameters and thinking-mode toggles.
            chatHistory: normalizedHistory,
            tools,
            workspaceRoot: opts.workspaceRoot,
            // Same 6-step ceiling as legacy swarmDraftCode.
            maxSteps: 6,
            // Same 0.1 temperature as legacy swarmDraftCode. Intentional
            // override of the V2.0 thinking-profile default of 0.6 —
            // the Coder values determinism more than the planner. The
            // engine picks config.temperature first, then the profile.
            temperature: 0.1,
            // V2.0: forward enableThinking/preserveThinking + sampling
            // params (top_p, top_k, presence_penalty) to chatCompletion.
            thinkingProfile,
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
            preDispatchHook: (0, rateLimitHook_1.composeHooks)((0, securityHook_1.buildSecurityHook)(), (0, rateLimitHook_1.buildRateLimitHook)(rateLimiter)),
            // Source tag for lifecycle events. Coder events render with
            // the 'coordinator' source — that's what the legacy
            // swarmDraftCode used and the webview's card design assumes.
            eventSource: 'coordinator',
            ...(opts.emitter
                ? { emitter: opts.emitter, taskId: opts.taskId }
                : {}),
            // V2.1.2 spec-fix-12 — Bug #1: forward approval hook so the
            // ReAct engine gates write_file / edit_file dispatch on it.
            ...(opts.approvalHook ? { approvalHook: opts.approvalHook } : {}),
            log: () => undefined, // Coder doesn't surface its own log lines —
            // the swarm-logs UI shows tool cards directly.
            streamCallback: accumulatingStreamCallback,
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            ...(opts.usageCallback ? { usageCallback: opts.usageCallback } : {}),
            // Track modifying tool calls. Only successful dispatches
            // count (status='error' uiPayload kind doesn't count
            // toward "real work").
            onToolDispatched: (toolCall, dispatchResult) => {
                if ((toolCall.function.name === 'write_file' ||
                    toolCall.function.name === 'edit_file') &&
                    dispatchResult.uiPayload.kind !== 'error') {
                    didModifyingToolCall = true;
                }
            }
        };
        // ─── Run the engine ───────────────────────────────────────────
        await (0, ReAct_1.runReActStreaming)(config);
        // ─── Post-mod read + diff synthesis ───────────────────────────
        const postModContent = await readPostModContent(targetUri);
        const result = {
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
exports.CoderAgent = CoderAgent;
//# sourceMappingURL=CoderAgent.js.map