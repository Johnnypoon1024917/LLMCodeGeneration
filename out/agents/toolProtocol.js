"use strict";
// src/agents/toolProtocol.ts
//
// Component 2B protocol types — the contract between the agent layer
// (Coordinator, Verifier, future agents) and the rest of the system
// (audit log, UI, tool dispatch).
//
// What this file defines:
//   - `ToolResult` union (Q4=4C lock — split encoding: LLM gets a
//     plain string, UI gets a structured payload)
//   - `ToolLifecycleEvent` discriminated union (Q3=3C lock — sequenced
//     event stream)
//   - `ToolEventSource` — distinguishes real LLM-emitted tool calls
//     from Verifier-internal pseudo-tool-calls (Q8=8C "soft lie" tag)
//
// What this file deliberately doesn't define:
//   - Tool registry / dispatcher shape (2B-2)
//   - Coordinator integration with the protocol (2B-3)
//   - postMessage envelope shape going to the webview (2B-3 / 2B-4)
//   - UI card variants (2B-4)
//
// Locked decisions (per COMPONENT_2B_DESIGN.md):
//   - Q3: 3C — events carry monotonic sequence numbers per task,
//          enabling replay/undo and reliable reconstruction
//   - Q4: 4C — tool results split into `llmContent: string` (for the
//          model's message history) and `uiPayload: ToolResult` (for
//          the user interface)
//   - Q5: 5B+5D — per-task cancel only, no auto-retry (errors
//          propagate to the model via `llmContent`)
//   - Q8: 8C — Verifier emits events with `source: 'verifier-internal'`
//          even though no real LLM tool call exists upstream
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=toolProtocol.js.map