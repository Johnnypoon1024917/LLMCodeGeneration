"use strict";
// src/agents/ReAct/ReActConfig.ts
//
// Type definitions for the shared ReAct engine. Extracted as part of
// the Coordinator rewrite (C-1, per COORDINATOR_REWRITE_DESIGN.md).
//
// Three legacy ReAct loops are being consolidated into one engine:
//   1. runPlannerAgent (planAgent.ts) — read-only, 8-step ceiling, full
//      hardening (path guard, dedup, budget, stuck-loop)
//   2. swarmDraftCode (Coordinator.ts) — write-capable, 6-step ceiling,
//      tracks didModifyingToolCall
//   3. runAgenticExploration (llmService.ts) — read-only, 2-step ceiling,
//      no hardening, has inline custom tool implementations for
//      grep_search and find_file
//
// The engine's surface area is wide enough to support all three patterns
// without any caller having to fall back to its own loop.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReActBudgetExceededError = exports.ReActStuckLoopError = void 0;
/**
 * Specific error class thrown when the stuck-loop detector fires.
 * Callers can catch this specifically vs generic Error.
 */
class ReActStuckLoopError extends Error {
    turnSignature;
    constructor(turnSignature) {
        super("ReAct loop stuck — same tool calls dispatched twice in a row. " +
            "This usually means the model is producing corrupted tool arguments " +
            "and not recovering from the resulting errors. Try regenerating, or " +
            "check the model/endpoint.");
        this.turnSignature = turnSignature;
        this.name = 'ReActStuckLoopError';
    }
}
exports.ReActStuckLoopError = ReActStuckLoopError;
/**
 * Thrown when the cumulative tool-call budget is exhausted.
 */
class ReActBudgetExceededError extends Error {
    totalDispatched;
    budget;
    diagnosis;
    constructor(totalDispatched, budget, diagnosis) {
        super(`ReAct loop exceeded tool-call budget (${budget}) without producing output. ` +
            diagnosis +
            ` Possible remedies: rephrase the task with more specific scope, simplify the project, ` +
            `or use a stronger / less-quantized model.`);
        this.totalDispatched = totalDispatched;
        this.budget = budget;
        this.diagnosis = diagnosis;
        this.name = 'ReActBudgetExceededError';
    }
}
exports.ReActBudgetExceededError = ReActBudgetExceededError;
//# sourceMappingURL=ReActConfig.js.map