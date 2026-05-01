// src/agents/ReAct/index.ts
//
// Barrel for the shared ReAct engine. Callers import from
// `'../ReAct'` rather than reaching into individual files.

export { runReAct, runReActStreaming } from './ReActEngine';

export type {
    ReActConfig,
    ReActResult,
    ReActEventSource,
    ReActLogCallback,
    ReActStreamCallback,
    ReActUsageCallback,
    ReActHardeningFlags,
    ReActTerminationCheck,
    ReActReprompt,
    CustomToolResolver
} from './ReActConfig';

export {
    ReActStuckLoopError,
    ReActBudgetExceededError
} from './ReActConfig';

export {
    DispatchCache,
    StuckLoopDetector,
    TotalCallBudget
} from './loopGuards';