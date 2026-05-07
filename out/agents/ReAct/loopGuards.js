"use strict";
// src/agents/ReAct/loopGuards.ts
//
// Hardening logic for the shared ReAct engine, extracted from the
// post-2B hotfixes that landed on planAgent.ts.
//
// Each guard is its own small class so the engine can compose them by
// hardening flags in ReActConfig. When a guard isn't enabled, the
// engine never instantiates it — zero overhead.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TotalCallBudget = exports.DispatchCache = exports.StuckLoopDetector = void 0;
const ReActConfig_1 = require("./ReActConfig");
/**
 * Hotfix 7: Stuck-loop detector.
 *
 * Models — especially aggressively quantized ones (W4A8 etc.) — can
 * land in a state where they emit the SAME set of tool calls every
 * turn, getting the same errors back, never learning. Without a loop
 * detector the planner burns the full step budget on identical no-
 * progress turns before failing.
 *
 * Detection: hash each turn's tool calls (sorted by name+args). If two
 * consecutive turns produce the same signature, the model is stuck.
 *
 * Reset condition: a non-tool turn (model produced narrative or final
 * output) clears the prior signature, since chatty intermissions
 * legitimately interrupt a stuck pattern.
 */
class StuckLoopDetector {
    lastTurnSignature = "";
    /**
     * Compute the signature for the current turn's tool calls. Sorted
     * so reorderings don't fool the detector. Returns the signature
     * regardless of whether it matches — caller decides what to do
     * with the result.
     */
    computeSignature(toolCalls) {
        return toolCalls
            .map(tc => `${tc.function.name}::${tc.function.arguments}`)
            .sort()
            .join('||');
    }
    /**
     * Check if this turn's signature matches the previous turn's. When
     * matched, throws ReActStuckLoopError. When not matched, records
     * the signature for next-turn comparison and returns silently.
     */
    checkAndRecord(signature) {
        if (signature === this.lastTurnSignature && signature !== "") {
            throw new ReActConfig_1.ReActStuckLoopError(signature);
        }
        this.lastTurnSignature = signature;
    }
    /**
     * Reset the recorded signature. Called after a non-tool turn so a
     * single chatty intermission doesn't break the next-turn comparison.
     */
    reset() {
        this.lastTurnSignature = "";
    }
}
exports.StuckLoopDetector = StuckLoopDetector;
/**
 * Hotfix 9: Per-session dedup cache.
 *
 * Read-only tools (read_file, list_directory, search_codebase) are
 * idempotent within a session — calling them twice with the same args
 * returns the same data. The cache short-circuits duplicates and
 * feeds back an "already-dispatched" message, steering the model
 * toward emitting the final output rather than re-exploring.
 *
 * Coder agent should NOT enable this — it intentionally re-reads
 * after edits to verify the change landed correctly.
 */
class DispatchCache {
    /** Map key format: `${tool_name}::${arguments_json_string}`.
     *  Map value: the turn number where this call first ran (0-indexed). */
    cache = new Map();
    /**
     * Compute the cache key for a tool call. Same format as the
     * stuck-loop signature's per-call component, so the two systems
     * agree on what "same call" means.
     */
    static keyFor(toolCall) {
        return `${toolCall.function.name}::${toolCall.function.arguments}`;
    }
    /** Has this exact call been dispatched before? Returns the turn
     *  number where it first ran, or undefined. */
    priorTurn(toolCall) {
        return this.cache.get(DispatchCache.keyFor(toolCall));
    }
    /** Record that this call has been dispatched at the given turn. */
    record(toolCall, turn) {
        this.cache.set(DispatchCache.keyFor(toolCall), turn);
    }
    /** Number of cached entries — exposed so the budget guard can
     *  generate a diagnosis when most calls are dedup hits. */
    size() {
        return this.cache.size;
    }
    /** Has this call been seen before? Boolean version of priorTurn. */
    has(toolCall) {
        return this.cache.has(DispatchCache.keyFor(toolCall));
    }
    /**
     * Build the synthetic "already dispatched" message that gets fed
     * back to the model in place of an actual tool result. The +1 on
     * turn is to convert from internal 0-indexed turn numbering to
     * the 1-indexed numbering the model sees in its message history.
     */
    static buildCachedMessage(priorTurn) {
        return (`This exact call was already dispatched earlier in this session ` +
            `(turn ${priorTurn + 1}). The result has not changed — refer to your prior ` +
            `tool result for the data. Do not repeat the call. If you have enough ` +
            `information now, emit the final output as your next message.`);
    }
}
exports.DispatchCache = DispatchCache;
/**
 * Hotfix 8: Cumulative tool-call budget.
 *
 * MAX_STEPS bounds round-trips, but the model emits PARALLEL tool
 * calls per round-trip — sometimes 10-30 of them. With 8 steps × 20
 * parallel calls, the agent can dispatch 160+ tool calls in a single
 * session before MAX_STEPS even fires. Most of them are useless when
 * the model has degenerated.
 *
 * The budget bounds the cumulative dispatch count. When exceeded we
 * throw with a tailored diagnostic rather than burning the rest of
 * the budget on a model that's clearly degenerated.
 *
 * 30 is the calibrated default for planner-style sessions: a healthy
 * planning session for a medium-sized task uses 6-15 tool calls.
 * 30 leaves 2x headroom for legitimate complex tasks; degenerate
 * sessions blow past 30 inside step 2-3.
 */
class TotalCallBudget {
    limit;
    dispatched = 0;
    constructor(limit) {
        this.limit = limit;
    }
    /**
     * Check whether dispatching `count` more calls would exceed the
     * budget. If so, throws ReActBudgetExceededError with a tailored
     * diagnosis based on the dominant failure pattern.
     *
     * The diagnosis classification helps the user know what to do:
     *   - mostly dedup hits → model is re-reading, not converging
     *   - mostly searches → keywords too generic
     *   - other → general non-convergence
     */
    checkBeforeDispatch(toolCalls, dedupCache) {
        if (this.dispatched + toolCalls.length <= this.limit)
            return;
        const dedupHits = dedupCache
            ? toolCalls.filter(tc => dedupCache.has(tc)).length
            : 0;
        const searchCalls = toolCalls.filter(tc => tc.function.name === 'search_codebase').length;
        let diagnosis;
        if (dedupHits >= toolCalls.length / 2) {
            diagnosis =
                "The model is re-reading files it has already seen. Most of the requested calls in " +
                    "the over-budget batch were duplicates of earlier reads. The model has the information " +
                    "it needs but is not stopping to emit the final output.";
        }
        else if (searchCalls >= toolCalls.length / 2) {
            diagnosis =
                "The model is making many search_codebase calls without converging. This often means " +
                    "the keywords are too generic to narrow the result set, or the model is not using " +
                    "search results to build the output.";
        }
        else {
            diagnosis =
                "The model is exploring without converging on a final output. This is unusual for a " +
                    "healthy session, which typically uses 6-15 tool calls.";
        }
        throw new ReActConfig_1.ReActBudgetExceededError(this.dispatched, this.limit, diagnosis);
    }
    /** Record that `count` calls have been dispatched. */
    record(count) {
        this.dispatched += count;
    }
    /** Total dispatched so far. */
    total() {
        return this.dispatched;
    }
}
exports.TotalCallBudget = TotalCallBudget;
//# sourceMappingURL=loopGuards.js.map