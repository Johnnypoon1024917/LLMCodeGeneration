// src/agents/ReAct/ReActEngine.ts
//
// Shared ReAct loop infrastructure for NexusCode's agents.
//
// Extracted as part of the Coordinator rewrite (per
// COORDINATOR_REWRITE_DESIGN.md). This file consolidates three legacy
// loops (all now deleted as of C-4):
//   - runPlannerAgent (planAgent.ts, deleted in C-2)
//   - runAgenticExploration (llmService.ts, deleted in C-3)
//   - swarmDraftCode (Coordinator.ts, deleted in C-4)
//
// Two engine variants live here:
//
//   - `runReAct`: non-streaming. Used by PlannerAgent (build + explore
//     modes). Targets `provider.chatCompletion`.
//
//   - `runReActStreaming`: streaming. Used by CoderAgent. Targets
//     `provider.streamChatCompletion` and surfaces text tokens via
//     `config.streamCallback` as they arrive. Per-turn semantics
//     (hardening, dispatch, termination) are identical to runReAct.
//
// The unified loop follows the shared shape:
//   1. Send the chat completion (streaming or not, depending on variant)
//   2. If model emits tool_calls → dispatch them, loop back
//   3. If model emits content → check termination, return or re-prompt
//
// Differences are configurable through ReActConfig.

import { getProvider } from '../../llm';
import { extractFallbackToolCalls } from '../../llm/toolCallFallback';
import { recordToolUsageResult } from '../../llm/OpenAICompatibleProvider';
import type {
    ChatMessage,
    ToolCall,
    AssistantMessage,
    CompletionOptions
} from '../../llm';
import { dispatchWithEvents, type DispatchWithEventsOptions } from '../toolDispatchWithEvents';
import type { ToolDispatchResult } from '../toolProtocol';
import {
    DispatchCache,
    StuckLoopDetector,
    TotalCallBudget
} from './loopGuards';
import type { ReActConfig, ReActResult } from './ReActConfig';

/**
 * Runs one ReAct session against the configured LLM.
 *
 * The engine is stateless across runs — each call to `runReAct`
 * constructs its own guard instances. This makes it safe to invoke
 * concurrently (e.g., parallel planning sessions for different files).
 *
 * Errors:
 *   - ReActStuckLoopError when stuck-loop detector fires
 *   - ReActBudgetExceededError when total-call budget exhausted
 *   - Generic Error for engine misconfigurations (emitter without
 *     taskId, maxSteps <= 0)
 *   - Provider-level errors (network, rate limit) propagate as-is
 *
 * @returns ReActResult containing the final assistant content (or
 *          best-effort content if maxSteps was reached), plus
 *          diagnostics for analysis.
 */
export async function runReAct(config: ReActConfig): Promise<ReActResult> {
    // ─── Validate configuration ───────────────────────────────────────
    if (config.maxSteps <= 0) {
        throw new Error(`ReActConfig.maxSteps must be > 0 (got ${config.maxSteps}).`);
    }
    if (config.emitter && !config.taskId) {
        throw new Error(
            'ReActConfig: when `emitter` is provided, `taskId` is required ' +
            'so lifecycle events can be sequence-numbered per task.'
        );
    }

    const provider = await getProvider();

    // Build the initial message stack.
    const messages: ChatMessage[] = [
        { role: 'system', content: config.systemPrompt },
        { role: 'user',   content: config.userPrompt },
        ...(config.chatHistory ?? [])
    ];

    // Construct guards based on hardening flags. Each is undefined
    // when its flag is false — zero overhead for opted-out callers.
    const stuckDetector = config.hardening?.enableStuckLoopDetector
        ? new StuckLoopDetector()
        : undefined;
    const dedupCache = config.hardening?.enableDedupCache
        ? new DispatchCache()
        : undefined;
    const budget = config.hardening?.enableTotalCallBudget
        ? new TotalCallBudget(config.maxTotalToolCalls ?? 30)
        : undefined;

    const assistantMessages: AssistantMessage[] = [];
    let totalToolCalls = 0;

    for (let step = 0; step < config.maxSteps; step++) {
        // ─── 1. Call the LLM ─────────────────────────────────────────
        // Effective temperature: explicit config.temperature wins;
        // otherwise the thinking profile contributes; otherwise the
        // historical 0.2 default.
        const effectiveTemperature =
            config.temperature ??
            config.thinkingProfile?.temperature ??
            0.2;
        const completionOpts: CompletionOptions = {
            tools: config.tools,
            toolChoice: 'auto',
            temperature: effectiveTemperature
        };
        if (config.thinkingProfile) {
            completionOpts.enableThinking = config.thinkingProfile.enableThinking;
            completionOpts.preserveThinking = config.thinkingProfile.preserveThinking;
            completionOpts.topP = config.thinkingProfile.topP;
            completionOpts.topK = config.thinkingProfile.topK;
            completionOpts.presencePenalty = config.thinkingProfile.presencePenalty;
        }
        if (config.abortSignal) { completionOpts.signal = config.abortSignal; }
        if (config.usageCallback) {
            completionOpts.onUsage = (usage) => config.usageCallback!(usage);
        }
        completionOpts.onRetryLog = (msg) => config.log(`API hiccup: ${msg}`);

        const aiMessage = await provider.chatCompletion(messages, completionOpts);
        assistantMessages.push(aiMessage);
        messages.push(aiMessage);

        // ─── 2. Branch: tool calls vs content ────────────────────────
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            // Budget check: if THIS turn would push us over, abort
            // BEFORE dispatching. The model has already shown it's
            // not converging on a final output. Note that budget is
            // checked against the FULL set of tool_calls (including
            // ones that will dedup) — the dedup short-circuit still
            // counts as model intent for budget purposes.
            if (budget) {
                budget.checkBeforeDispatch(aiMessage.tool_calls, dedupCache);
            }

            // Dispatch each tool call. Order matters within a turn —
            // the model implicitly assumes sequential execution of its
            // own emitted calls. Each call returns whether it was a
            // dedup hit so we can assess "real" stuck-loop signature
            // from non-deduped calls only.
            const nonDedupedCalls: ToolCall[] = [];
            for (const toolCall of aiMessage.tool_calls) {
                const { dedupHit } = await dispatchOneCall(
                    toolCall, step, config, dedupCache, messages
                );
                if (!dedupHit) {
                    nonDedupedCalls.push(toolCall);
                }
            }

            // Stuck-loop detection: compute signature from the
            // NON-DEDUPED calls only. Layered defense rationale:
            //
            //   - If every call this turn hit the dedup cache, the
            //     model is asking for things it already saw. The
            //     synthetic "already dispatched, emit final output"
            //     messages have been pushed; we WANT the model to get
            //     a chance to react. Don't abort — let the next turn
            //     happen.
            //
            //   - If the model emits the SAME non-deduped calls two
            //     turns in a row (post-dedup signature matches), then
            //     the model genuinely IS stuck — it's emitting new-
            //     to-cache calls that match the previous turn's
            //     non-cached calls. That's pathological behavior the
            //     dedup cache can't catch (each call is "new" the
            //     first time it appears, so dedup waits a turn).
            //
            // Why the reorder matters: previous behavior was to check
            // signature BEFORE dispatch, which meant duplicated calls
            // would trigger stuck-detection on turn 2 — before the
            // dedup cache had a chance to feed back the "already
            // dispatched" guidance. The user's complaint about
            // "ReAct loop stuck" mid-conversation was triggered by
            // exactly this: model retried, dedup would have helped,
            // but stuck-detector aborted first.
            if (stuckDetector) {
                const signature = stuckDetector.computeSignature(nonDedupedCalls);
                stuckDetector.checkAndRecord(signature);
            }

            // Record budget AFTER dispatch so the next turn's check
            // reflects what actually ran (including dedup-shortcircuited
            // calls — they still count as model intent).
            if (budget) { budget.record(aiMessage.tool_calls.length); }
            totalToolCalls += aiMessage.tool_calls.length;

            // Last-step-with-tool-calls case: the legacy swarmDraftCode
            // ended the loop naturally after dispatching the final batch
            // (relying on disk state to capture the result). The engine
            // does the same — return best-effort with the accumulated
            // assistant message rather than continuing the for-loop and
            // hitting the post-loop throw. completedNormally=false
            // signals to callers that the budget was hit; they can
            // decide whether that's a failure or a soft cap.
            if (step === config.maxSteps - 1) {
                config.log(
                    "ReAct loop: max steps reached after dispatching final tool batch.",
                    "warning"
                );
                return {
                    finalContent: (aiMessage.content ?? '').trim(),
                    totalToolCalls,
                    totalSteps: config.maxSteps,
                    completedNormally: false,
                    assistantMessages
                };
            }

            continue; // Back to step 1 — let the model react to results.
        }

        // ─── 3. No tool calls — termination check ───────────────────
        if (stuckDetector) { stuckDetector.reset(); }
        const content = (aiMessage.content ?? '').trim();

        if (config.isDone(content)) {
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: step + 1,
                completedNormally: true,
                assistantMessages
            };
        }

        // Last step — return best-effort content even if not done.
        // Mirrors the legacy "Step limit reached, returning best-effort
        // plan" behavior in planAgent.ts:343.
        if (step === config.maxSteps - 1) {
            config.log(
                "ReAct loop: max steps reached, returning best-effort content.",
                "warning"
            );
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: config.maxSteps,
                completedNormally: false,
                assistantMessages
            };
        }

        // Re-prompt for next turn if a builder is configured. Without
        // one, treat any non-tool, non-done turn as completion (the
        // legacy swarmDraftCode pattern: "model stopped calling tools,
        // assume it's finished").
        if (config.repromptOnNonDone) {
            messages.push({
                role: 'user',
                content: config.repromptOnNonDone(step + 1)
            });
        } else {
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: step + 1,
                completedNormally: true,
                assistantMessages
            };
        }
    }

    // Defensive — only reachable if maxSteps was 0, which we reject
    // at validation. Kept as a safety net for type-narrowing.
    /* istanbul ignore next */
    throw new Error('ReAct loop exited without producing a result.');
}

/**
 * Streaming variant of {@link runReAct}.
 *
 * Same per-turn semantics — same hardening guards, same dedup, same
 * isDone / repromptOnNonDone behavior — but uses
 * `provider.streamChatCompletion` instead of `provider.chatCompletion`,
 * so the model's text output streams to `config.streamCallback` token-
 * by-token as it arrives.
 *
 * Used by the Coder agent (C-4 migration). The Planner intentionally
 * stays on the non-streaming variant: planner output is structured
 * XML that's only useful as a complete document, so token-by-token
 * streaming would just be visual noise for the user.
 *
 * Streaming-specific notes:
 *
 *   - Tool calls in the stream arrive as complete units (the provider
 *     accumulates partial argument deltas internally and emits them as
 *     a single `kind: 'tool_call'` delta when complete). We don't try
 *     to render partial tool-call args.
 *
 *   - `finish_reason` from the stream is observed but doesn't drive
 *     termination directly. The same isDone / has-tool-calls logic
 *     as runReAct decides what happens next. A 'length' finish is
 *     treated as best-effort completion (token limit hit).
 *
 *   - If `config.streamCallback` is undefined, text deltas are still
 *     accumulated for the AssistantMessage but no tokens are surfaced.
 *     Useful for tests and CLI contexts that don't have a UI to stream
 *     into.
 *
 * @returns Same {@link ReActResult} shape as runReAct.
 */
export async function runReActStreaming(config: ReActConfig): Promise<ReActResult> {
    // ─── Validate configuration ───────────────────────────────────────
    if (config.maxSteps <= 0) {
        throw new Error(`ReActConfig.maxSteps must be > 0 (got ${config.maxSteps}).`);
    }
    if (config.emitter && !config.taskId) {
        throw new Error(
            'ReActConfig: when `emitter` is provided, `taskId` is required ' +
            'so lifecycle events can be sequence-numbered per task.'
        );
    }

    const provider = await getProvider();

    const messages: ChatMessage[] = [
        { role: 'system', content: config.systemPrompt },
        { role: 'user',   content: config.userPrompt },
        ...(config.chatHistory ?? [])
    ];

    const stuckDetector = config.hardening?.enableStuckLoopDetector
        ? new StuckLoopDetector()
        : undefined;
    const dedupCache = config.hardening?.enableDedupCache
        ? new DispatchCache()
        : undefined;
    const budget = config.hardening?.enableTotalCallBudget
        ? new TotalCallBudget(config.maxTotalToolCalls ?? 30)
        : undefined;

    const assistantMessages: AssistantMessage[] = [];
    let totalToolCalls = 0;

    for (let step = 0; step < config.maxSteps; step++) {
        // ─── 1. Stream the LLM response and accumulate the turn ──────
        // Streaming path: forward sampling params from the thinking
        // profile if present, but FORCE enableThinking=false. The SSE
        // parser doesn't yet handle `delta.reasoning_content` —
        // surfacing reasoning to streaming consumers is a separate PR.
        // For now, streaming users see the final answer only; users
        // who want to see reasoning use the non-streaming path
        // (PlannerAgent / VerifierAgent in V2.0).
        const streamingTemperature =
            config.temperature ??
            config.thinkingProfile?.temperature ??
            0.2;
        const completionOpts: CompletionOptions = {
            tools: config.tools,
            toolChoice: 'auto',
            temperature: streamingTemperature
        };
        if (config.thinkingProfile) {
            // Forward sampling params, but keep thinking off for stream.
            completionOpts.enableThinking = false;
            completionOpts.topP = config.thinkingProfile.topP;
            completionOpts.topK = config.thinkingProfile.topK;
            completionOpts.presencePenalty = config.thinkingProfile.presencePenalty;
        }
        if (config.abortSignal) { completionOpts.signal = config.abortSignal; }
        if (config.usageCallback) {
            completionOpts.onUsage = (usage) => config.usageCallback!(usage);
        }
        completionOpts.onRetryLog = (msg) => config.log(`API hiccup: ${msg}`);

        const stream = await provider.streamChatCompletion(messages, completionOpts);

        let assistantText = '';
        const assistantToolCalls: ToolCall[] = [];
        let finishReason: string = 'stop';

        for await (const delta of stream) {
            if (delta.kind === 'text') {
                assistantText += delta.content;
                if (config.streamCallback) { config.streamCallback(delta.content); }
            } else if (delta.kind === 'tool_call') {
                assistantToolCalls.push(delta.toolCall);
            } else if (delta.kind === 'finish') {
                finishReason = delta.reason;
            }
        }

        // V2.0 follow-up: client-side fallback for inference servers
        // that didn't surface tool calls in the native delta channel.
        // When (a) the stream emitted no native tool_calls, and
        // (b) the accumulated text contains a fallback-parseable
        // structure, synthesize tool_calls and clean the text.
        //
        // Why HERE in the engine, not in the SSE parser:
        //   - The SSE parser stays pure: yields deltas as they arrive,
        //     no buffering, no second-guessing
        //   - The engine has all info at the right point (post-stream)
        //   - The user already saw the raw text via streamCallback,
        //     which is OK behavior — they SEE what the agent decided
        //     to do, and we still dispatch the action
        //
        // This is invisible to all downstream code: aiMessage looks
        // exactly like a normal tool-call response would.
        // Snapshot the native tool-call count BEFORE the fallback
        // parser potentially synthesizes more. We want the capability
        // tracker to see "did the server's native tool-call channel
        // produce anything", not "did the fallback path also work".
        // Fallback-recovered calls are a sign the endpoint is
        // misconfigured even if the agent succeeded.
        const nativeToolCallCount = assistantToolCalls.length;

        if (assistantToolCalls.length === 0 && assistantText.length > 0) {
            const fallback = extractFallbackToolCalls(assistantText);
            if (fallback.toolCalls.length > 0) {
                for (const tc of fallback.toolCalls) { assistantToolCalls.push(tc); }
                assistantText = fallback.cleanContent;
                config.log(
                    `Tool-call fallback parser recovered ${fallback.toolCalls.length} call(s) ` +
                    `from format(s): ${fallback.formatsDetected.join(', ')}. ` +
                    `Inference server's --tool-call-parser is likely misconfigured for this model.`
                );
            } else {
                // Diagnostic: when no tool_calls AND no fallback match,
                // log a preview of what the model actually emitted. This
                // is the only signal a remote debugger has when an agent
                // run fails with "no modifying tool calls" — without it,
                // you can't tell whether the model emitted nothing, or
                // an unrecognized format, or the wrong format silently.
                //
                // 500-char preview keeps log size bounded; full text
                // lives in the audit log via the regular llm_call entry.
                const preview = assistantText.length > 500
                    ? assistantText.slice(0, 500) + '\n...(truncated, ' + assistantText.length + ' total chars)'
                    : assistantText;
                config.log(
                    `[DIAGNOSTIC] No tool_calls + no fallback match. assistantText preview:\n${preview}`
                );
            }
        }

        const aiMessage: AssistantMessage = {
            role: 'assistant',
            content: assistantText
        };
        if (assistantToolCalls.length > 0) {
            aiMessage.tool_calls = assistantToolCalls;
        }

        // Record native tool-calling success/failure for this endpoint.
        // We use the snapshot taken BEFORE fallback ran — fallback
        // recovery is itself a signal of degradation, so counting it
        // as a success would mask the problem and keep the endpoint
        // out of text-injection mode forever.
        try {
            recordToolUsageResult(provider.endpoint, nativeToolCallCount > 0);
        } catch {
            // Defensive: tracking is observability, not load-bearing.
            // A failure here must NOT abort the engine run.
        }

        assistantMessages.push(aiMessage);
        messages.push(aiMessage);

        // ─── 2. Branch: tool calls vs content ────────────────────────
        // (Identical post-stream flow to runReAct's tool-calls branch.)
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            if (budget) {
                budget.checkBeforeDispatch(aiMessage.tool_calls, dedupCache);
            }

            const nonDedupedCalls: ToolCall[] = [];
            for (const toolCall of aiMessage.tool_calls) {
                const { dedupHit } = await dispatchOneCall(
                    toolCall, step, config, dedupCache, messages
                );
                if (!dedupHit) {
                    nonDedupedCalls.push(toolCall);
                }
            }

            if (stuckDetector) {
                const signature = stuckDetector.computeSignature(nonDedupedCalls);
                stuckDetector.checkAndRecord(signature);
            }

            if (budget) { budget.record(aiMessage.tool_calls.length); }
            totalToolCalls += aiMessage.tool_calls.length;

            // Same last-step-with-tool-calls handling as runReAct: the
            // Coder pattern (swarmDraftCode) ended naturally after the
            // final batch and read the result from disk. Engine matches
            // that contract here.
            if (step === config.maxSteps - 1) {
                config.log(
                    "ReAct loop: max steps reached after dispatching final tool batch.",
                    "warning"
                );
                return {
                    finalContent: (aiMessage.content ?? '').trim(),
                    totalToolCalls,
                    totalSteps: config.maxSteps,
                    completedNormally: false,
                    assistantMessages
                };
            }

            continue;
        }

        // ─── 3. No tool calls — termination check ───────────────────
        if (stuckDetector) { stuckDetector.reset(); }
        const content = (aiMessage.content ?? '').trim();

        // Streaming-specific: if the model hit the token limit, treat
        // that as a soft completion. Logging it via the configured log
        // callback so the user can see what happened in CLI contexts;
        // the streamCallback already showed the truncation visually.
        if (finishReason === 'length') {
            config.log(
                "Streaming completion truncated by token limit; returning partial output.",
                "warning"
            );
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: step + 1,
                completedNormally: false,
                assistantMessages
            };
        }
        // Other unusual finish reasons (e.g., 'content_filter') —
        // surface in logs and treat as best-effort termination.
        if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
            config.log(
                `Streaming completion ended with unexpected finish reason: ${finishReason}.`,
                "warning"
            );
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: step + 1,
                completedNormally: false,
                assistantMessages
            };
        }

        if (config.isDone(content)) {
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: step + 1,
                completedNormally: true,
                assistantMessages
            };
        }

        if (step === config.maxSteps - 1) {
            config.log(
                "ReAct loop: max steps reached, returning best-effort content.",
                "warning"
            );
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: config.maxSteps,
                completedNormally: false,
                assistantMessages
            };
        }

        if (config.repromptOnNonDone) {
            messages.push({
                role: 'user',
                content: config.repromptOnNonDone(step + 1)
            });
        } else {
            return {
                finalContent: content,
                totalToolCalls,
                totalSteps: step + 1,
                completedNormally: true,
                assistantMessages
            };
        }
    }

    /* istanbul ignore next */
    throw new Error('ReAct streaming loop exited without producing a result.');
}

/**
 * Dispatch a single tool call, applying dedup and routing through
 * either dispatchWithEvents (registered tools) or a custom resolver
 * (legacy inline tools). Pushes the resulting `tool` message onto the
 * shared messages array.
 *
 * Pulled out to keep the main loop body readable. Modifies `messages`
 * by reference — the only mutation site outside the main loop.
 */
async function dispatchOneCall(
    toolCall: ToolCall,
    currentStep: number,
    config: ReActConfig,
    dedupCache: DispatchCache | undefined,
    messages: ChatMessage[]
): Promise<{ dedupHit: boolean }> {
    // Dedup short-circuit: if we've seen this exact call before, feed
    // back the synthetic "already dispatched" message instead of
    // re-running the tool.
    if (dedupCache) {
        const priorTurn = dedupCache.priorTurn(toolCall);
        if (priorTurn !== undefined) {
            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: DispatchCache.buildCachedMessage(priorTurn)
            });
            return { dedupHit: true };
        }
        dedupCache.record(toolCall, currentStep);
    }

    // Custom resolver path: legacy inline tools that aren't in the
    // registered catalog (runAgenticExploration's grep_search and
    // find_file). These don't go through dispatchWithEvents.
    const customResolver = config.customToolResolvers?.[toolCall.function.name];
    if (customResolver) {
        const result = await customResolver(toolCall, config.workspaceRoot);
        messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.llmContent
        });
        // Custom resolvers handle their own UI/event surfacing — they
        // run outside dispatchWithEvents, so the lifecycle event
        // emitter does NOT see them. But we DO fire onToolDispatched
        // so callers can accumulate per-call data uniformly across
        // resolution paths (used by PlannerAgent's explore mode to
        // build gatheredContext from all tool results).
        //
        // We synthesize a minimal ToolDispatchResult: llmContent is
        // the resolver's content; uiPayload is whatever the resolver
        // provided OR a synthetic { kind: 'error' } stub if it didn't
        // (since uiPayload is required on the type but resolvers may
        // legitimately not have one).
        if (config.onToolDispatched) {
            const synthesizedResult: ToolDispatchResult = {
                llmContent: result.llmContent,
                uiPayload: (result.uiPayload as ToolDispatchResult['uiPayload'])
                    ?? { kind: 'error', message: '' }
            };
            config.onToolDispatched(toolCall, synthesizedResult);
        }
        return { dedupHit: false };
    }

    // Standard path: dispatchWithEvents for registered tools.
    const dispatchOpts: DispatchWithEventsOptions = {
        source: config.eventSource,
        preDispatchHook: config.preDispatchHook
    };
    if (config.emitter) {
        dispatchOpts.emitter = config.emitter;
        if (config.taskId) { dispatchOpts.taskId = config.taskId; }
    }

    const dispatchResult: ToolDispatchResult = await dispatchWithEvents(
        toolCall,
        { workspaceRoot: config.workspaceRoot },
        dispatchOpts
    );

    messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: dispatchResult.llmContent
    });

    if (config.onToolDispatched) {
        config.onToolDispatched(toolCall, dispatchResult);
    }
    return { dedupHit: false };
}