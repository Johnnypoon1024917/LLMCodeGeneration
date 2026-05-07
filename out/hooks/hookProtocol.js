"use strict";
// src/hooks/hookProtocol.ts
//
// PR P1.4: lifecycle events for hook firing. Mirrors the
// toolProtocol pattern but is a separate type because:
//
//   1. Hooks are NOT tool calls. They're triggered by file save,
//      schedule, or manual invocation — not invoked by the LLM.
//   2. They have no `arguments` object (a hook's prompt template is
//      part of the hook definition, not per-fire).
//   3. They have no LLM-visible result (hooks output to chat + audit,
//      not back into the agent's context).
//   4. The source discriminator is different ('hook' vs the
//      coordinator/planner/verifier-internal triad on tool events).
//
// Folding hooks into ToolLifecycleEvent would require adding nullable
// fields on every variant and would obscure intent at every consumer.
// A parallel protocol with the same shape language is cleaner.
//
// Wire format (host → webview):
//   { type: 'hookEvent', event: HookLifecycleEvent }
//
// The webview's reducer (hookEvents.ts) accumulates state by hookFireId
// the same way toolEvents.ts accumulates by callId.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=hookProtocol.js.map