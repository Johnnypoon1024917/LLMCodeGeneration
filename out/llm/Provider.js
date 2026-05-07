"use strict";
// src/llm/Provider.ts
//
// Provider interface — the LLM transport abstraction.
//
// Architecture (three layers, outside-in):
//
//   1. Orchestration layer  — `llmService.ts`'s exported functions.
//      Build prompts, manage history, emit audit records, decode
//      domain-specific JSON. Calls into the Provider for raw transport.
//
//   2. Provider layer       — this interface and its implementations.
//      Speaks one specific wire protocol (currently OpenAI-compatible
//      chat completions). Does retry, rate limiting, JSON-mode probing,
//      streaming protocol parsing. Knows nothing about prompts.
//
//   3. Network layer        — `RetryManager` + `RateLimitManager` +
//      raw `fetch`. Thread-safe primitives the Provider implementation
//      composes.
//
// Why this split:
//   - Adding a new wire protocol (Huawei MindIE, Anthropic, etc.) means
//     writing one new file that implements `Provider`. No changes to
//     llmService.ts or the 22 functions that build prompts.
//   - Audit emission stays in the orchestration layer. The Provider
//     doesn't carry IDE-specific concerns.
//   - Tests can inject a mock Provider without touching prompt
//     construction logic.
//
// Locked design decisions (per COMPONENT_1_PREWORK.md and COMPONENT_2A_PREWORK.md):
//   - A1: OpenAI-compatible only for v1.0
//   - B1: JSON-in-prompt for tool calls is the DOMAIN convention (no native
//         tool-call branch in user-facing flows). Component 2A relaxes this
//         specifically for INTERNAL ReAct loops (planAgent,
//         runAgenticExploration) — see chatCompletion() below.
//   - C1: SSE streaming required (every Provider must implement streamCompletion)
//   - D1: Single provider/model per session (factory returns one Provider)
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=Provider.js.map