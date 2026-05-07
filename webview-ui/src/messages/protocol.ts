// webview-ui/src/messages/protocol.ts
//
// M-6 fix: shared message protocol between the webview and the
// extension host. Both sides post 34+ message types over `postMessage`.
// Until now the protocol was implicit — any typo in a `data.type` field
// silently no-ops, and there was no way to spot a renamed-but-not-
// updated message at compile time.
//
// What this module provides:
//
//   1. `WebviewToHost` — discriminated union of every `vscode.postMessage`
//      payload the webview sends to the host. Each variant has a literal
//      `type` field; TypeScript can narrow on it.
//
//   2. `HostToWebview` — the reverse direction. The webview's
//      `useEffect` `messageHandler` switch over `data.type` is type-safe
//      against this union.
//
//   3. `parseHostMessage(data)` — runtime validator. Accepts an unknown
//      payload, returns either a parsed message or a structured error
//      with the offending `type`. Surfaces unknown messages via the
//      webview logger so they don't silently no-op.
//
// Why hand-rolled (not zod): zod adds ~12KB gzipped for a 36-case
// validator. We only need: (a) `type` is a string, (b) `type` is one
// we know about. Anything richer would belong in TypeScript's compile-
// time type system, not runtime — the runtime guard exists to catch
// drift, not to deeply validate every field. Keep it cheap.
//
// Adding a new message: extend the relevant union below + add the
// literal to the corresponding `KNOWN_*_TYPES` set. Both sides will
// fail to compile if they reference a type that doesn't exist on the
// other side.

import { log } from '../utils/log';

// ─── webview → host ──────────────────────────────────────────────────
// Each message the webview sends. Cases come from the `case "..."`
// switch in src/SidebarProvider.ts:onDidReceiveMessage.
//
// As with HostToWebview, we type the discriminator literal but leave
// other payload fields as `Record<string, unknown>`. This is enough
// to catch typos at the call site (`type: 'cnacelTask'` is a compile
// error) without forcing every consumer to update for a per-variant
// shape. Per-variant typing is a future refactor.

export type WebviewToHost =
    | { type: 'webviewReady' }
    | { type: 'requestWorkspaceGraph'; forceRefresh?: boolean }
    | { type: 'saveNexusRules'; [k: string]: unknown }
    | { type: 'verifyTask'; [k: string]: unknown }
    | { type: 'generateRequirements'; [k: string]: unknown }
    | { type: 'generateDesign' }
    | { type: 'generateProjectTasks' }
    | { type: 'requestRevision'; [k: string]: unknown }
    | { type: 'approvePhase'; [k: string]: unknown }
    | { type: 'rejectPhase'; [k: string]: unknown }
    | { type: 'startOver' }
    | { type: 'setCurrentFeature'; slug: string }
    | { type: 'createFeature'; name: string }
    | { type: 'updateRequirements'; [k: string]: unknown }
    | { type: 'updateDesign'; [k: string]: unknown }
    | { type: 'syncHistory'; [k: string]: unknown }
    | { type: 'clearHistory' }
    | { type: 'saveApiKey'; [k: string]: unknown }
    | { type: 'processUserMessage'; [k: string]: unknown }
    | { type: 'cancelTask' }
    | { type: 'executeTask'; [k: string]: unknown }
    | { type: 'refreshCodeLens' }
    | { type: 'undoTaskEdit'; [k: string]: unknown }
    | { type: 'runGlobalCompiler' }
    | { type: 'searchFiles'; [k: string]: unknown }
    | { type: 'showDiff'; [k: string]: unknown }
    | { type: 'openFile'; [k: string]: unknown }
    | { type: 'readFileContext'; [k: string]: unknown }
    | { type: 'executeAllTasks'; [k: string]: unknown }
    | { type: 'commitAtomicEdits'; [k: string]: unknown }
    | { type: 'generateAndRunTests'; [k: string]: unknown }
    | { type: 'executeCommand'; [k: string]: unknown }
    | { type: 'requestModels' }
    | { type: 'setModel'; [k: string]: unknown }
    | { type: 'approveCommand' }
    | { type: 'rejectCommand' }
    | { type: 'generateProjectTests' }
    // M-8: webview signals that the user opted to disable the security
    // gate for this session after seeing a monitor-unavailable banner.
    | { type: 'setSecurityGate'; enabled: boolean }
    /** P0: webview's response to a bash-exec confirmation prompt. */
    | { type: 'respondBashApproval'; mode: 'allow' | 'block' | 'allow-always' }
    // PR 3.2: hooks panel. Webview asks the host for the current hook
    // list, and toggles or runs hooks.
    | { type: 'requestHookList' }
    | { type: 'toggleHook'; id: string; enabled: boolean }
    | { type: 'runHook'; id: string }
    | { type: 'openHookFile'; id: string }
    // PR 3.3: steering rules panel. Webview asks for the current
    // steering file list; user-driven actions create or open files.
    | { type: 'requestSteeringList' }
    | { type: 'createSteeringFile'; id: string }
    | { type: 'requestSteeringList' }
    | { type: 'createSteeringFile'; [k: string]: unknown }
    | { type: 'openSteeringFile'; id: string }
    // V2.1.2 spec-fix-10 P5.2: explore-mode "Apply this fix" flow.
    // Payload carries the user's original prompt and the assistant's
    // explore response so the host can synthesize a build-mode prompt
    // and route through the existing planner→coder pipeline.
    // `source` distinguishes button click vs auto-apply for audit.
    | { type: 'applyExploreFix'; originalPrompt: string; exploreResponse: string; source: 'button' | 'auto' }
    // V2.2 hotfix #2: export current session to JSON file. Carries the
    // webview's React-state copies of chat + task progression — host
    // doesn't have its own copy of these (they live in webview state
    // only, not workspaceState).
    | { type: 'exportSession'; messages?: unknown; taskStatuses?: unknown; taskSummaries?: unknown; taskFiles?: unknown; taskSteps?: unknown; taskReasoning?: unknown; activePlan?: unknown }
    // V2.2 hotfix-clear-reopen-mermaid: non-destructive nav back to PRD.
    | { type: 'reopenPRD' }
    // P3.1: timeline tab requests all session events for the active feature.
    | { type: 'getTimelineEvents' }
    // V2.1.2 spec-fix-12 — inline tool approval responses.
    | { type: 'approveToolCall'; callId: string }
    | { type: 'rejectToolCall'; callId: string };

const KNOWN_WEBVIEW_TO_HOST_TYPES: ReadonlySet<WebviewToHost['type']> = new Set([
    'webviewReady', 'requestWorkspaceGraph', 'saveNexusRules', 'verifyTask',
    'generateRequirements', 'generateDesign', 'generateProjectTasks',
    'requestRevision', 'approvePhase', 'rejectPhase', 'startOver',
    'setCurrentFeature', 'createFeature', 'updateRequirements',
    'updateDesign', 'syncHistory', 'clearHistory', 'saveApiKey',
    'processUserMessage', 'cancelTask', 'executeTask', 'refreshCodeLens',
    'undoTaskEdit', 'runGlobalCompiler', 'searchFiles', 'showDiff',
    'openFile', 'readFileContext', 'executeAllTasks', 'commitAtomicEdits',
    'generateAndRunTests', 'executeCommand', 'requestModels', 'setModel',
    'approveCommand', 'rejectCommand', 'generateProjectTests', 'setSecurityGate',
    'respondBashApproval',
    'requestHookList', 'toggleHook', 'runHook', 'openHookFile',
    'requestSteeringList', 'createSteeringFile', 'openSteeringFile',
    'applyExploreFix',
    // V2.2 hotfix #2 — session export
    'exportSession',
    // V2.2 hotfix-clear-reopen-mermaid — non-destructive PRD nav
    'reopenPRD',
    // P3.1: timeline tab data fetch
    'getTimelineEvents',
    // V2.1.2 spec-fix-12 — inline approval responses
    'approveToolCall', 'rejectToolCall'
]);

// ─── host → webview ──────────────────────────────────────────────────
// Each message the host sends to the webview. Drawn from the
// `webview.postMessage({ type: ... })` call sites in SidebarProvider
// and from `data.type ===` branches in App.tsx.
//
// Many variants carry feature-specific payload fields beyond `type`.
// We keep them as `[k: string]: unknown` index signatures rather than
// fully typed shapes — fully typing each variant would require touching
// every consumer in App.tsx (currently 36 branches), which is out of
// scope for this audit fix. The runtime validator only checks that
// `type` is one we know about; field-level typing remains a future
// refactor (the App.tsx split that's already on the audit backlog).

export type HostToWebview =
    | { type: 'addContext'; [k: string]: unknown }
    | { type: 'addUserMessageAndSubmit'; [k: string]: unknown }
    | { type: 'agentStep'; [k: string]: unknown }
    | { type: 'allTasksCompleted'; [k: string]: unknown }
    | { type: 'chatToken'; [k: string]: unknown }
    | { type: 'clearTerminalStream'; [k: string]: unknown }
    | { type: 'designGenerated'; [k: string]: unknown }
    | { type: 'errorBanner'; [k: string]: unknown }
    | { type: 'generationFailed'; [k: string]: unknown }
    | { type: 'glassBrain'; [k: string]: unknown }
    | { type: 'historyCompacted'; [k: string]: unknown }
    | { type: 'initState'; [k: string]: unknown }
    | { type: 'injectTerminalTask'; [k: string]: unknown }
    | { type: 'insertText'; [k: string]: unknown }
    | { type: 'metaModeChanged'; [k: string]: unknown }
    | { type: 'phaseStateUpdated'; [k: string]: unknown }
    | { type: 'reqStep'; [k: string]: unknown }
    | { type: 'requestCommandApproval'; [k: string]: unknown }
    | { type: 'requestBashApproval'; command?: string }
    | { type: 'requestReview'; [k: string]: unknown }
    | { type: 'requirementsGenerated'; [k: string]: unknown }
    | { type: 'requirementsUpdated'; [k: string]: unknown }
    | { type: 'reviewEdits'; [k: string]: unknown }
    | { type: 'searchResults'; [k: string]: unknown }
    // V2.2 hotfix #2 (2b): session replay envelope. Sent by the host
    // on webview connect to restore previous session state from the
    // event log on disk. The webview unwraps replayEvent and re-
    // dispatches inner events through the normal handler path.
    | { type: 'replayBegin'; count: number }
    | { type: 'replayEvent'; ts: string; event: { type: string; [k: string]: unknown } }
    | { type: 'replayEnd' }
    // P3.1: timeline tab — host sends all session events for the
    // active feature in response to a getTimelineEvents request.
    // The webview reduces these into a TimelineModel for display.
    | { type: 'timelineEvents'; events: { type: string; [k: string]: unknown }[]; count?: number; empty?: boolean; reason?: string; errorMessage?: string }
    // P2.1 bundle 1: MCP server status snapshot.
    | { type: 'mcpStatus'; servers: { name: string; connected: boolean; toolCount: number; lastError?: string }[] }
    // V2.2 hotfix #4: emitted on retry attempt N+1 to clear stale
    // tool cards from attempt N.
    | { type: 'taskRetry'; taskId: string; attempt: number }
    // V2.1.2 spec-fix-12 — inline tool approval prompt.
    | { type: 'requestToolApproval'; callId: string; toolName: string; filepath: string; preview?: unknown }
    // V2.2 cross-task remediation banner.
    | { type: 'crossTaskRegression'; [k: string]: unknown }
    | { type: 'specError'; phase: 'requirements' | 'design' | 'tasks'; title: string; message: string }
    | { type: 'featureChanged'; currentFeature: string; requirements: string; design: string; tasks: any; phaseState: any; featureList: { slug: string; phaseState: any }[] }
    | { type: 'featureChangeFailed'; slug: string; reason: string }
    | { type: 'startChatStream'; intent?: 'build' | 'explore' | 'explain' | 'ask'; originalPrompt?: string; [k: string]: unknown }
    | { type: 'startRevision'; [k: string]: unknown }
    | { type: 'statusUpdate'; [k: string]: unknown }
    | { type: 'streamReasoning'; [k: string]: unknown }
    | { type: 'streamTerminal'; [k: string]: unknown }
    | { type: 'structureResponse'; [k: string]: unknown }
    | { type: 'taskCompleted'; [k: string]: unknown }
    | { type: 'taskExecutionStarted'; [k: string]: unknown }
    | { type: 'taskStatusUpdate'; [k: string]: unknown }
    | { type: 'tasksGenerated'; [k: string]: unknown }
    | { type: 'tokenUsage'; usage: { prompt_tokens?: number; completion_tokens?: number }; task?: string; phase?: 'planner' | 'coder' | 'verifier' | 'unknown' }
    | { type: 'toolCallEvent'; event: unknown }
    | { type: 'updateModelsList'; [k: string]: unknown }
    | { type: 'workspaceGraphData'; [k: string]: unknown }
    // M-8: distinct signal that the security monitor itself failed.
    // Webview renders an actionable banner (retry / disable for session)
    // separately from the generic toolCallEvent path.
    | { type: 'securityMonitorUnavailable'; command?: string; reason?: string }
    // PR 2.4b: audit log broadcast. Host fires this after every record
    // is durably written to the JSONL file. Webview's useAuditLog hook
    // appends to an in-memory ring buffer for the AuditLogPanel.
    // Record shape mirrors src/audit/types.ts AuditRecord.
    | { type: 'auditEntryAppended'; record: { [k: string]: unknown } }
    // PR 3.2: hooks panel broadcast.
    | { type: 'hookListUpdated'; hooks: Array<{ [k: string]: unknown }> }
    // PR 3.3: steering rules panel broadcast. Same shape pattern as
    // hookListUpdated — host fires whenever the steering directory
    // contents change (FS watcher) or when the user requests an
    // explicit refresh.
    | { type: 'steeringListUpdated'; items: Array<{ [k: string]: unknown }> }
    // PR 2.1: MCP server connection status. Host fires when an MCP
    // server connects, disconnects, or fails to connect. The MCP
    // panel uses this to show per-server status pills.
    | { type: 'mcpStatusUpdated'; servers: Array<{ [k: string]: unknown }> }
    // PR P3.1 panel: diagnostics. Three messages serve the panel:
    //   - sessionListUpdated   → response to requestSessionList
    //   - sessionBundleUpdated → response to requestSessionBundle
    //   - startupTimingUpdated → response to requestStartupTiming
    // Shapes mirror src/audit/sessionDiagnostics.ts; webview's
    // useDiagnostics hook validates incoming entries defensively.
    | { type: 'sessionListUpdated'; sessions: Array<{ [k: string]: unknown }> }
    | { type: 'sessionBundleUpdated'; sessionId: string; bundle?: { [k: string]: unknown } | null; error?: string }
    | { type: 'startupTimingUpdated'; marks: Array<{ [k: string]: unknown }>; relative: Array<{ [k: string]: unknown }> }
    // V2.0 follow-up: thinking-mode toggle echoes the post-update
    // state of all three per-agent flags after a setThinkingMode
    // request lands. Webview uses this to keep the inline pill in
    // sync with VS Code settings (which may be edited externally).
    | { type: 'thinkingModeChanged'; mode: { planner: boolean; coder: boolean; verifier: boolean } }
    // V2.1.1 — project scaffolder decision flow.
    //
    // scaffoldDecisionAvailable: host's response to webview's
    //   requestScaffoldDecision. Carries greenfield detection result
    //   + the list of available templates (workspace overrides +
    //   built-ins). Webview uses this to show the confirmation
    //   dialog with stack picker.
    //
    // scaffoldDecisionAcknowledged: host's echo after webview posts
    //   scaffoldDecisionMade. Lets the webview know the host has
    //   the decision and is proceeding (V2.1.2+ will run scaffolding
    //   here; V2.1.1 just acknowledges).
    | {
        type: 'scaffoldDecisionAvailable';
        detection: {
            isGreenfield: boolean;
            confidence: 'low' | 'medium' | 'high';
            stackHint?: string;
        };
        templates: Array<{
            id: string;
            displayName: string;
            description: string;
            stackTags: string[];
            source: 'workspace' | 'builtin';
        }>;
    }
    | {
        type: 'scaffoldDecisionAcknowledged';
        action: string;
        templateId: string | null;
        // V2.1.2b — populated when action='apply' completes (or fails).
        // applyError is null on success, a string message on failure.
        // applyResult is null on failure, otherwise carries the file
        // counts so the dialog can show "wrote N files, skipped M".
        applyError: string | null;
        applyResult: { written: number; skipped: number } | null;
    };

const KNOWN_HOST_TO_WEBVIEW_TYPES: ReadonlySet<HostToWebview['type']> = new Set([
    'addContext', 'addUserMessageAndSubmit', 'agentStep', 'allTasksCompleted',
    'chatToken', 'clearTerminalStream', 'designGenerated', 'errorBanner',
    'generationFailed', 'glassBrain', 'historyCompacted', 'initState',
    'injectTerminalTask', 'insertText', 'metaModeChanged', 'phaseStateUpdated',
    'reqStep', 'requestCommandApproval', 'requestBashApproval', 'requestReview', 'requirementsGenerated',
    'requirementsUpdated', 'reviewEdits', 'searchResults', 'specError',
    'featureChanged', 'featureChangeFailed', 'startChatStream',
    'startRevision', 'statusUpdate', 'streamReasoning', 'streamTerminal',
    'structureResponse', 'taskCompleted', 'taskExecutionStarted',
    'taskStatusUpdate', 'tasksGenerated', 'tokenUsage', 'toolCallEvent',
    'updateModelsList', 'workspaceGraphData', 'securityMonitorUnavailable',
    'auditEntryAppended', 'hookListUpdated',
    'steeringListUpdated',
    'mcpStatusUpdated',
    'sessionListUpdated', 'sessionBundleUpdated', 'startupTimingUpdated',
    'thinkingModeChanged',
    'scaffoldDecisionAvailable', 'scaffoldDecisionAcknowledged',
    // V2.2 hotfix #2 (2b) — session replay
    'replayBegin', 'replayEvent', 'replayEnd',
    // P3.1 timeline data
    'timelineEvents',
    // P2.1 bundle 1: MCP status snapshot
    'mcpStatus',
    // V2.2 hotfix #4 — retry hygiene
    'taskRetry',
    // V2.1.2 spec-fix-12 — inline approval
    'requestToolApproval',
    // V2.2 cross-task remediation
    'crossTaskRegression',
]);

// ─── runtime validator ───────────────────────────────────────────────

/**
 * Validate an inbound host→webview message.
 *
 * Behavior is **permissive**: returns the payload unchanged for any
 * object with a string `type`, even if `type` is not in the known set.
 * Unknown types log a one-time warning so a renamed message surfaces
 * in dev, but the message is still delivered — we don't want to break
 * working features when the protocol drifts.
 *
 * Returns `null` only for fundamentally malformed payloads (non-object,
 * missing/non-string `type`).
 *
 * Caller pattern:
 *
 *     const msg = parseHostMessage(event.data);
 *     if (!msg) return;
 *     if (msg.type === 'tokenUsage') { ... }
 */
const warnedUnknown = new Set<string>();
/**
 * Validate an inbound host→webview message.
 *
 * Behavior is **permissive**: returns the payload unchanged for any
 * object with a string `type`, even if `type` is not in the known set.
 * Unknown types log a one-time warning so a renamed message surfaces
 * in dev, but the message is still delivered — we don't want to break
 * working features when the protocol drifts.
 *
 * Returns `null` only for fundamentally malformed payloads (non-object,
 * missing/non-string `type`).
 *
 * Return type is intentionally `any`. Tightening it to a discriminated
 * union would force every consumer to migrate its property access from
 * `data.foo` to `data['foo']` under the project's strict
 * `noPropertyAccessFromIndexSignature` rule — that's a 36-branch
 * refactor outside the scope of this audit fix. A future task can do
 * a per-variant typed handler split (the App.tsx breakup recommended
 * elsewhere in the audit).
 *
 * Caller pattern unchanged from before the validator was added:
 *
 *     const data = parseHostMessage(event.data);
 *     if (!data) return;
 *     if (data.type === 'tokenUsage') { ... data.usage.prompt_tokens ... }
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseHostMessage(data: unknown): any {
    if (!data || typeof data !== 'object') {
        return null;
    }
    const t = (data as { type?: unknown }).type;
    if (typeof t !== 'string') {
        log.warn('Dropped host→webview message with non-string type:', data);
        return null;
    }
    if (!KNOWN_HOST_TO_WEBVIEW_TYPES.has(t as HostToWebview['type'])) {
        // Warn once per unknown type to avoid log spam.
        if (!warnedUnknown.has(t)) {
            warnedUnknown.add(t);
            log.warn(`Unknown host→webview message type "${t}". Add it to HostToWebview in messages/protocol.ts to silence this warning.`);
        }
    }
    return data;
}

/**
 * Type-safe wrapper around vscode.postMessage. Forces the caller to
 * pass a payload that matches the WebviewToHost union, so a typo in
 * `type` is a compile error, not a silent no-op.
 *
 * Usage:
 *
 *     postToHost(vscode, { type: 'cancelTask' });           // OK
 *     postToHost(vscode, { type: 'cnacelTask' });           // compile error
 *     postToHost(vscode, { type: 'executeTask', task: 'x',  // OK
 *                          taskTitle: 't', prompt: 'p' });
 */
export function postToHost(
    vscode: { postMessage: (msg: unknown) => void },
    msg: WebviewToHost
): void {
    if (!KNOWN_WEBVIEW_TO_HOST_TYPES.has(msg.type)) {
        // Belt-and-braces: the compile-time check should have caught
        // this, but if a `as any` slipped through somewhere, log and
        // still post — better than dropping.
        log.warn(`Posting webview→host message with unknown type "${msg.type}".`);
    }
    vscode.postMessage(msg);
}