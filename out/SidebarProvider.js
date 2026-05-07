"use strict";
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
exports.SidebarProvider = void 0;
// src/SidebarProvider.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const container_1 = require("./container");
const diffProvider_1 = require("./diffProvider");
const codeGraph_1 = require("./context/codeGraph");
const Coordinator_1 = require("./agents/Coordinator");
// V2.2 cross-task remediation: monitor watches for new tsc errors
// after each successful task and synthesizes remediation tasks when
// task B's edits broke task A's compile invariants.
const crossTaskMonitor_1 = require("./agents/crossTaskMonitor");
const PlannerAgent_1 = require("./agents/PlannerAgent");
const toolEventEmitter_1 = require("./agents/toolEventEmitter");
const hookEventEmitter_1 = require("./hooks/hookEventEmitter");
const toolAuditCorrelator_1 = require("./audit/toolAuditCorrelator");
const SpecManager_1 = require("./specs/SpecManager");
// PR 3.2: hooks panel messages route through HookManager.
const HookManager_1 = require("./hooks/HookManager");
// PR 3.3: steering rules panel messages route through SteeringManager.
const SteeringManager_1 = require("./specs/SteeringManager");
const mcpManager_1 = require("./mcp/mcpManager");
const VSCodeEnvironment_1 = require("./adapters/VSCodeEnvironment");
// V2.1.1 — project scaffolder. detectGreenfield is pure heuristic
// (workspace shape + prompt), discoverTemplates lists workspace
// .nexus/scaffolds/ and extension built-in scaffolds/. Used by the
// requestScaffoldDecision case to populate the webview confirmation
// dialog. V2.1.2 / V2.1.3 will add the apply path.
const greenfieldDetector_1 = require("./scaffold/greenfieldDetector");
const templateLoader_1 = require("./scaffold/templateLoader");
// V2.1.2b — scaffold application. applyTemplate writes the chosen
// template's files into the workspace; nodeFsAdapter wraps node:fs
// for the production filesystem path. Tests use an in-memory fake
// (see scaffoldApplier.test.ts) — production callers pass the
// adapter explicitly so the apply logic stays decoupled from fs.
const scaffoldApplier_1 = require("./scaffold/scaffoldApplier");
const nodeFsAdapter_1 = require("./scaffold/nodeFsAdapter");
const sessionDiagnostics_1 = require("./audit/sessionDiagnostics");
const startupTiming_1 = require("./diagnostics/startupTiming");
const testAgent_1 = require("./agents/testAgent");
const errors_1 = require("./utilities/errors");
const searchReplace_1 = require("./utilities/searchReplace");
const i18n_1 = require("./i18n");
const logger_1 = require("./logger");
// AI Services & Tools
const llmService_1 = require("./llmService");
// Context Managers
const projectContext_1 = require("./projectContext");
const lspContext_1 = require("./context/lspContext");
const styleContext_1 = require("./context/styleContext");
const ragIndexer_1 = require("./context/ragIndexer");
const hybridSearch_1 = require("./context/hybridSearch");
const installedPackages_1 = require("./context/installedPackages");
const typescriptSymbols_1 = require("./context/typescriptSymbols");
// Utilities
const commentStyles_1 = require("./utilities/commentStyles");
const pathUtils_1 = require("./utilities/pathUtils");
const workspaceManager_1 = require("./workspaceManager");
const SessionEventStore_1 = require("./sessions/SessionEventStore");
/**
 * Apply a SEARCH/REPLACE pair to a file's content.
 *
 * Delegates to the hardened `applyBlock` helper from `utilities/searchReplace`,
 * which provides Tier A (exact) / Tier B (trailing whitespace) / Tier C
 * (leading whitespace tolerance) matching. Falls back to "replace whole file
 * with extracted markdown" when the model emitted no SEARCH/REPLACE block at all.
 */
function applySearchReplace(originalContent, searchBlock, replaceBlock, fullBuffer) {
    const normalizeNL = (str) => str.replace(/\r\n/g, '\n');
    // Fallback: no parsed block → take whatever's inside the first ``` fence
    // as a full-file replacement. This handles the case where the model
    // skipped the SEARCH/REPLACE protocol entirely (rare, but observed).
    if (!searchBlock || !replaceBlock) {
        const markdownMatch = fullBuffer.match(/```[a-z]*\n([\s\S]*?)```/i);
        if (markdownMatch && markdownMatch[1] !== undefined) {
            return normalizeNL(markdownMatch[1].trim());
        }
        return normalizeNL(fullBuffer.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim());
    }
    // Strip stray markdown fences from the block contents (model sometimes
    // wraps SEARCH bodies in ```ts ... ```).
    const cleanSearch = normalizeNL(searchBlock.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim());
    const cleanReplace = normalizeNL(replaceBlock.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim());
    // Delegate to the hardened applier — its multi-tier matching tolerates
    // model whitespace fuzzing, and its diagnostics on failure are richer
    // than the legacy "AI hallucinated" error.
    return (0, searchReplace_1.applyBlock)(originalContent, {
        search: cleanSearch,
        replace: cleanReplace,
        blockOffset: 0
    });
}
class SidebarProvider {
    _extensionUri;
    _view;
    _tracker;
    _terminalManager;
    _activeTaskController;
    _activeRequirements = "";
    _activeDesign = "";
    _isMetaMode = false;
    /**
     * V2.1.2 spec-fix-4: currently-selected feature slug. Default is
     * 'main' which matches pre-V2.1.2 behavior (everything saved under
     * `.nexus/specs/main/`). Users can create or switch features via
     * the webview, and the choice persists across VS Code sessions
     * via workspaceState.
     *
     * The setter (setCurrentFeature) handles persistence + notifies the
     * webview via featureChanged so the UI rehydrates from the new
     * feature's spec files.
     */
    _currentFeature = SpecManager_1.DEFAULT_FEATURE;
    /**
     * PR 2.4b: disposer for the AuditLog subscription. Set in
     * resolveWebviewView when the webview attaches; called from the
     * webview's onDidDispose so we don't leak subscriptions across
     * webview reloads. AuditLog itself outlives the webview (it's
     * workspace-scoped); the subscription is per-webview-instance.
     *
     * Type note: explicit `| undefined` (not just `?`) because the
     * project's tsconfig has `exactOptionalPropertyTypes: true`, which
     * disallows assigning `undefined` to `?` fields. We need to assign
     * `undefined` to clear the disposer reference after teardown.
     */
    /**
     * V2.2 hotfix #2 (sub-bundle 2a): persistent event log writer.
     * Records replay-relevant webview messages (tool calls, agent
     * tokens, plan changes, approvals, etc.) to .nexus/sessions/
     * <feature>/events-<timestamp>.jsonl on disk, so when VS Code
     * reloads or the webview reconnects, 2b can replay them and
     * restore the chat state.
     *
     * Lazy-initialized in resolveWebviewView once we have a workspace
     * root. Lifecycle is per-extension-host (not per-webview), so it
     * survives webview reloads — that's the whole point.
     */
    _eventStore = undefined;
    /** P3.1 bundle 2: tracks which agent phase is currently active so
     *  usage callbacks can tag tokenUsage events with planner / coder
     *  / verifier. Updated when log() callbacks fire with stepType
     *  hints. Cleared between tasks. Defaults to 'unknown' which the
     *  reducer treats as un-attributed. */
    _activeAgentPhase = 'unknown';
    _auditUnsubscribe = undefined;
    /**
     * PR 3.2: disposer for the HookManager list-changes subscription.
     * Same lifecycle as _auditUnsubscribe — per-webview-instance,
     * cleaned up on onDidDispose. Same type-shape rules apply
     * (exactOptionalPropertyTypes).
     */
    _hooksUnsubscribe = undefined;
    /**
     * PR 3.3: disposer for the SteeringManager list-changes subscription.
     * Same lifecycle as the audit and hooks subscriptions above.
     */
    _steeringUnsubscribe = undefined;
    /**
     * P2.1: disposer for the McpManager status subscription. Same
     * lifecycle as the other manager subscriptions — per-webview-
     * instance, torn down by onDidDispose.
     */
    _mcpUnsubscribe = undefined;
    _undoStack = new Map();
    _pendingCommandResolver;
    // V2.1.2 spec-fix-12 — Bug #1: inline approval before code edits.
    //
    // _currentAutopilot: latched at the start of each chat/task. The
    // approval hook reads this to decide whether to gate write-tool
    // calls. Default false matches the regulated-industry positioning
    // ("ASK ME before you change anything").
    //
    // _pendingApprovalResolvers: keyed by the tool call's callId. The
    // LLM can emit multiple write_file / edit_file calls in one
    // assistant turn, so each pending approval needs its own resolver.
    // (Commands use a single resolver because they're serialized.)
    _currentAutopilot = false;
    _pendingApprovalResolvers = new Map();
    // V2.2 cross-task remediation: lazy-init session monitor. Created
    // on first task completion (we don't need it for explore/chat
    // sessions). Reset on workspace change or new chat session.
    // null when no workspace is open or when the session hasn't yet
    // completed a task.
    _crossTaskMonitor = null;
    /**
     * Component 2B-3b: per-session tool event emitter. Used by the
     * Coordinator to surface lifecycle events for tool calls (started
     * / output / completed) to the webview as `toolCallEvent` messages.
     *
     * Lazily constructed on first request — most sessions never trigger
     * a flow that uses tool calls (chat-only mode), so allocating a
     * Map upfront would be waste. Constructed once per SidebarProvider
     * instance, which matches a single VS Code window's lifetime.
     *
     * The sink callback is bound to `this._view?.webview.postMessage`,
     * so events are silently dropped if the webview hasn't been resolved
     * yet (e.g. extension activation before sidebar opens). This is the
     * correct behavior — there's no UI to render events to.
     */
    _toolEventEmitter;
    _toolAuditCorrelator;
    /**
     * P1.4: hook lifecycle emitter. Same pattern as the tool emitter.
     * The sink posts `{type: 'hookEvent', event}` to the webview so
     * the React side can render inline hook cards. When no webview
     * is attached the events drop silently — fine for the agent.
     */
    _hookEventEmitter;
    /**
     * Get (or lazily construct) the per-session tool event emitter.
     * Public so tests and future callers (Coordinator wire-up in 2B-3c)
     * can attach as event producers. See _toolEventEmitter docstring
     * for behavior on the no-view case.
     */
    getToolEventEmitter() {
        if (!this._toolEventEmitter) {
            // D11: audit log integration. The correlator buffers
            // started→completed events and emits one ToolCallPayload
            // per tool invocation via getDeps().audit.logToolCall.
            // Logic lives in src/audit/toolAuditCorrelator.ts so it's
            // testable without vscode mocking.
            this._toolAuditCorrelator = new toolAuditCorrelator_1.ToolAuditCorrelator((payload) => {
                // Fire-and-forget. AuditLog handles its own write
                // failures with console.warn — the .catch() here is
                // belt-and-braces in case the helper itself rejects
                // before reaching the queue.
                void (0, container_1.getDeps)().audit.logToolCall(payload).catch((e) => {
                    console.warn('[SidebarProvider] audit.logToolCall rejected:', e);
                });
            });
            this._toolEventEmitter = new toolEventEmitter_1.ToolEventEmitter((event) => {
                // Drop events to webview when no view is attached.
                // Audit logging still runs — headless / CLI runs need
                // audit even though no UI is listening.
                this._view?.webview.postMessage({
                    type: 'toolCallEvent',
                    event
                });
                // Audit correlation. Started events buffer; completed
                // events flush. Output events are ignored.
                this._toolAuditCorrelator.handleEvent(event);
            });
        }
        return this._toolEventEmitter;
    }
    /**
     * V2.1.2 spec-fix-12 — Bug #1: build an approval hook for the
     * tool dispatch pipeline. Returns a function shaped like
     * preDispatchHook that gates write_file / edit_file calls when
     * AutoPilot is OFF, by posting an approval request to the webview
     * and awaiting the user's click.
     *
     * Decision matrix:
     *   - AutoPilot ON                  → auto-approve (no UI prompt)
     *   - Tool not in {write_file, edit_file} → auto-approve (read-only
     *     tools never need approval; bash_exec is gated by the existing
     *     confirmAndRunCommand path which has its own UI)
     *   - AutoPilot OFF + write tool    → post requestToolApproval,
     *                                     wait for user response
     *   - User approves                 → returns true (dispatch proceeds)
     *   - User rejects                  → returns false (dispatch surfaces
     *                                     a "rejected by user" error to
     *                                     the LLM, which can adapt or stop)
     *
     * The hook is wired in via dispatchWithEvents.options.approvalHook
     * (added in the same patch). The Coordinator passes this hook through
     * its execution context.
     *
     * This is a method-returning-function rather than a plain method
     * because the dispatch pipeline expects a stable function reference
     * with closure over `this`. Calling it once at task start and reusing
     * is cheaper than rebuilding per dispatch.
     */
    buildApprovalHook() {
        return async (toolCall, parsedArgs) => {
            // AutoPilot ON: skip the prompt entirely.
            if (this._currentAutopilot || this._isMetaMode) {
                return true;
            }
            const toolName = toolCall.function.name;
            // Read-only tools and other non-mutating tools don't need
            // approval. Only the two file-mutation tools are gated.
            if (toolName !== 'write_file' && toolName !== 'edit_file') {
                return true;
            }
            const filepath = String(parsedArgs['filepath'] ?? '(unknown path)');
            const callId = toolCall.id;
            // Diagnostic log so future "stuck on Drafting" bug reports
            // can be triaged from the OutputChannel without a debugger.
            // The user reported a 5-minute hang in spec-fix-12-bug
            // where the approval card was rendered BELOW the visible
            // viewport and missed entirely.
            logger_1.log.info(`[Approval] requesting user approval for ${toolName} on ${filepath} (callId=${callId})`);
            // Post approval request to webview and wait for the click.
            const approved = await new Promise((resolve) => {
                this._pendingApprovalResolvers.set(callId, resolve);
                this._view?.webview.postMessage({
                    type: 'requestToolApproval',
                    callId,
                    toolName,
                    filepath,
                    // Send a short snippet of the change so the user has
                    // context. For write_file: the new content (truncated).
                    // For edit_file: the old/new text pair (truncated).
                    preview: toolName === 'write_file'
                        ? { kind: 'write', content: String(parsedArgs['content'] ?? '').slice(0, 800) }
                        : { kind: 'edit',
                            oldText: String(parsedArgs['old_text'] ?? '').slice(0, 400),
                            newText: String(parsedArgs['new_text'] ?? '').slice(0, 400) }
                });
            });
            logger_1.log.info(`[Approval] resolved ${callId}: ${approved ? 'approved' : 'rejected'}`);
            this._pendingApprovalResolvers.delete(callId);
            return approved;
        };
    }
    /**
     * V2.2 cross-task remediation: after a task completes, check
     * whether the project still compiles. If new tsc errors appeared
     * that weren't there before this task ran, attribute them to the
     * task and surface a remediation prompt the user can dispatch.
     *
     * Design intentionally observability-only:
     *   - Never blocks the originating task's success state
     *   - Never auto-dispatches remediation (V2.6 governance territory)
     *   - Never modifies workspace state directly
     *   - Surfaces crossTaskRegression message; webview decides UX
     *
     * Scope: TS/JS projects (require tsconfig.json). Python / Go / Rust
     * skipped silently; per-language equivalents are V2.4+ work.
     *
     * Errors during analysis are caught at the call site and logged;
     * cross-task check is bonus value, not a gate.
     */
    async runCrossTaskAnalysis(completed, workspaceRoot) {
        if (!this._crossTaskMonitor) {
            const env = new VSCodeEnvironment_1.VSCodeEnvironment();
            const monitor = new crossTaskMonitor_1.CrossTaskMonitor(workspaceRoot, env);
            if (!monitor.isApplicable()) {
                this._crossTaskMonitor = monitor;
                logger_1.log.info('[CrossTask] not applicable to this workspace (no tsconfig.json)');
                return;
            }
            this._crossTaskMonitor = monitor;
        }
        if (!this._crossTaskMonitor.isApplicable()) {
            return;
        }
        const analysis = await this._crossTaskMonitor.analyzeAfterTask(completed);
        if (analysis.healthy) {
            logger_1.log.info(`[CrossTask] ${completed.taskKey}: clean`);
            return;
        }
        if (!analysis.remediationTask) {
            logger_1.log.warn(`[CrossTask] ${completed.taskKey}: ${analysis.newErrors.length} new errors, no attribution`);
            this._view?.webview.postMessage({
                type: 'crossTaskRegression',
                sourceTaskKey: completed.taskKey,
                newErrorCount: analysis.newErrors.length,
                attributable: false,
                summary: `${analysis.newErrors.length} new tsc errors after ${completed.taskTitle}; couldn't attribute to a session task.`,
            });
            return;
        }
        logger_1.log.info(`[CrossTask] ${completed.taskKey}: ${analysis.newErrors.length} new errors, remediation synthesized for ${analysis.remediationTask.targetFile}`);
        this._view?.webview.postMessage({
            type: 'crossTaskRegression',
            sourceTaskKey: completed.taskKey,
            newErrorCount: analysis.newErrors.length,
            attributable: true,
            remediationTask: analysis.remediationTask,
            summary: `${analysis.newErrors.length} new tsc errors in ${analysis.remediationTask.targetFile} after ${completed.taskTitle}.`,
        });
    }
    /**
     * V2.1.3: shared greenfield detection + template discovery helper.
     *
     * Two call sites:
     *   1. The existing requestScaffoldDecision case (refactor next).
     *   2. The build-path generatePlan call — passes the hint to the
     *      planner so it can emit a scaffold task as task[0] when
     *      the workspace is empty.
     *
     * Returns null when no workspace is open (no greenfield possible)
     * or detection fails. Callers treat null as "not greenfield."
     */
    async detectGreenfieldForPrompt(userPrompt) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return null;
        }
        let topLevelFilenames = [];
        let totalFileCount = 0;
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(workspaceRoot));
            topLevelFilenames = entries
                .filter(([_, kind]) => kind === vscode.FileType.File)
                .map(([name]) => name);
            totalFileCount = topLevelFilenames.length;
            const COUNT_CAP = 100;
            const SKIP_DIRS = new Set([
                'node_modules', '.git', '.nexus', 'dist',
                'build', 'out', '__pycache__', '.venv',
                'venv', 'target', '.next', '.gradle',
            ]);
            for (const [name, kind] of entries) {
                if (totalFileCount >= COUNT_CAP) {
                    break;
                }
                if (kind !== vscode.FileType.Directory) {
                    continue;
                }
                if (SKIP_DIRS.has(name)) {
                    continue;
                }
                try {
                    const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(workspaceRoot, name)));
                    totalFileCount += sub.filter(([_, k]) => k === vscode.FileType.File).length;
                }
                catch {
                    // Subdir read failed — treat as 0 contribution.
                }
            }
        }
        catch (e) {
            logger_1.log.warn(`[Scaffold] detectGreenfieldForPrompt: list workspace failed: ${(0, errors_1.errorMessage)(e)}`);
            return null;
        }
        const detection = (0, greenfieldDetector_1.detectGreenfield)({
            prompt: userPrompt,
            topLevelFilenames,
            totalFileCount,
        });
        const allTemplates = (0, templateLoader_1.discoverTemplates)(workspaceRoot, this._extensionUri.fsPath);
        // Filter templates by stackHint when present so the planner
        // doesn't see (and pick) wildly off-stack templates.
        let templates = allTemplates;
        if (detection.stackHint) {
            const hint = detection.stackHint.toLowerCase();
            const filtered = allTemplates.filter(t => t.stackTags.some(tag => tag.toLowerCase().includes(hint)) ||
                t.id.toLowerCase().includes(hint));
            if (filtered.length > 0) {
                templates = filtered;
            }
        }
        return {
            detection,
            templates: templates.map(t => ({
                id: t.id,
                displayName: t.displayName,
                description: t.description,
                stackTags: t.stackTags,
            })),
        };
    }
    /**
     * P1.4: lazy-construct the hook event emitter and wire HookManager
     * to use it. Called during webview resolution so hooks that fire
     * after the webview opens land as cards in chat.
     *
     * Idempotent: subsequent calls return the same emitter and re-wire
     * HookManager harmlessly (HookManager.setEmitter just replaces the
     * reference).
     *
     * The audit log path for hooks is wired separately in extension.ts
     * (HookManager.setAuditLog), independent of this emitter — auditing
     * works headless, even with no webview attached.
     */
    getHookEventEmitter() {
        if (!this._hookEventEmitter) {
            this._hookEventEmitter = new hookEventEmitter_1.HookEventEmitter((event) => {
                // Drop events to webview when no view is attached. The
                // hook still ran and the audit record was written —
                // we just lose the inline card. Reasonable tradeoff:
                // hooks should be visible in real-time when the user
                // is watching, but they shouldn't queue up when nobody's
                // looking.
                this._view?.webview.postMessage({
                    type: 'hookEvent',
                    event
                });
            });
            // Wire HookManager NOW so any subsequent fire emits cards.
            // HookManager.setEmitter is idempotent.
            HookManager_1.HookManager.getInstance().setEmitter(this._hookEventEmitter);
        }
        return this._hookEventEmitter;
    }
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    setTerminalManager(manager) { this._terminalManager = manager; }
    setProvenanceTracker(tracker) { this._tracker = tracker; }
    sendMessageToWebview(message) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
        else {
            vscode.window.showInformationMessage((0, i18n_1.t)("commands.open_sidebar_first"));
        }
    }
    /**
     * V2.2 hotfix #2 (2b): replay the active session log to the
     * connected webview. Called from resolveWebviewView after the
     * webview attaches. Posts:
     *   - 'replayBegin'  (count: N)
     *   - 'replayEvent'  (one per recorded event, in original order,
     *                     payload is the original recorded message)
     *   - 'replayEnd'
     *
     * Replay events are wrapped in a 'replayEvent' envelope rather
     * than re-posted as their original type. Why: the postMessage
     * wrapper installed in resolveWebviewView records every recordable
     * message, and re-posting original-typed events would create a
     * recursive duplicate-recording loop. The wrapper checks for
     * 'replayEvent' / 'replayBegin' / 'replayEnd' in the recordable
     * whitelist (it's not there), so they bypass recording.
     *
     * The webview's reducer for 'replayEvent' unwraps the inner
     * event and applies it like a live event — taskCallEvent goes
     * through applyToolEvent, chatToken appends to the active task's
     * reasoning, etc.
     *
     * Failures (no log, parse errors) are silent — replay is
     * best-effort. The user still gets the live state via initState.
     */
    async replayActiveSessionToWebview() {
        if (!this._eventStore || !this._view) {
            return;
        }
        const events = await this._eventStore.readActiveLog();
        if (!events || events.length === 0) {
            return;
        }
        // Bookend so the webview can show a "restoring..." overlay if
        // it wants. count helps the UI render a progress indicator.
        this._view.webview.postMessage({ type: 'replayBegin', count: events.length });
        for (const e of events) {
            this._view.webview.postMessage({
                type: 'replayEvent',
                ts: e.ts,
                event: e.payload,
            });
        }
        this._view.webview.postMessage({ type: 'replayEnd' });
    }
    injectTerminalTask(prompt) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'injectTerminalTask', task: prompt });
        }
    }
    toggleMetaMode() {
        this._isMetaMode = !this._isMetaMode;
        const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
        vscode.window.showWarningMessage((0, i18n_1.t)("commands.switched_mode", { mode }));
        this._view?.webview.postMessage({ type: 'metaModeChanged', value: this._isMetaMode });
    }
    async getTargetContext() {
        if (this._isMetaMode) {
            return this._extensionUri.fsPath;
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    }
    /**
     * Returns a SpecManager bound to the active workspace root (or the extension
     * root in meta-mode). Returns null if no workspace is open.
     */
    specs() {
        const folders = vscode.workspace.workspaceFolders;
        if (this._isMetaMode) {
            return new SpecManager_1.SpecManager(this._extensionUri);
        }
        if (!folders || folders.length === 0) {
            return null;
        }
        return new SpecManager_1.SpecManager(folders[0].uri); // length > 0 guarded
    }
    isValidPhase(p) {
        return p === 'requirements' || p === 'design' || p === 'tasks';
    }
    async confirmAndRunCommand(command, workspacePath, progressMessage, isAutopilot = false, onStream) {
        this._view?.webview.postMessage({ type: 'statusUpdate', message: `🛡️ Security Monitor inspecting command...` });
        const isMalicious = await (0, llmService_1.askSecurityMonitor)(command);
        if (isMalicious) {
            vscode.window.showErrorMessage((0, i18n_1.t)("security.firewall_blocked", { command }));
            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🚨 Command Blocked by Security Monitor.` });
            return { success: false, output: "SECURITY_BLOCK" };
        }
        if (isAutopilot || this._isMetaMode) {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🤖 Autopilot Executing: ${command}` });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath, onStream);
        }
        // 🔥 THE PROMISE LOCK: Halt Node.js execution until the human clicks Allow or Block!
        const isApproved = await new Promise((resolve) => {
            this._pendingCommandResolver = resolve;
            this._view?.webview.postMessage({
                type: 'requestCommandApproval',
                command: command,
                message: progressMessage
            });
        });
        this._pendingCommandResolver = undefined; // Clear the lock
        if (isApproved) {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: progressMessage });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath, onStream);
        }
        else {
            vscode.window.showInformationMessage((0, i18n_1.t)("commands.command_blocked_by_user"));
            return { success: false, output: "USER_BLOCKED" };
        }
    }
    async handlePostApproval(uri) {
        if (!this._isMetaMode) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) {
            await document.save();
        }
        const filepath = uri.fsPath;
        if (filepath.includes('webview-ui')) {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🎨 Self-Evolution: Rebuilding UI..." });
            const webviewPath = path.join(this._extensionUri.fsPath, 'webview-ui');
            const buildResult = await this._terminalManager?.runCommandWithCapture("npm run build", webviewPath);
            if (buildResult?.success) {
                vscode.window.showInformationMessage((0, i18n_1.t)("ui_evolution.ui_rebuilt"));
                vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
            }
            else {
                vscode.window.showErrorMessage((0, i18n_1.t)("ui_evolution.ui_build_failed"));
            }
        }
        else {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🧬 Self-Evolution: Recompiling..." });
            const compileResult = await this._terminalManager?.runCommandWithCapture("npm run compile", this._extensionUri.fsPath);
            if (compileResult?.success) {
                vscode.window.showInformationMessage((0, i18n_1.t)("ui_evolution.evolution_applied"));
            }
            else {
                vscode.window.showErrorMessage((0, i18n_1.t)("ui_evolution.build_failed"));
            }
        }
        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        // V2.2 hotfix #2 (2a): wrap webview.postMessage so any host→
        // webview message that's in our recordable-event whitelist gets
        // appended to the session event log on disk. The wrapper is
        // installed once per webview instance (a reload re-runs
        // resolveWebviewView and re-installs). All 187+ existing
        // postMessage call sites in this file are recorded
        // transparently — no per-site changes needed.
        //
        // We attach to the webview object (not the bound method) so
        // both `this._view.webview.postMessage(...)` and
        // `webviewView.webview.postMessage(...)` paths are caught.
        // Recording is fire-and-forget; recording failures never block
        // the actual postMessage delivery (the original is awaited
        // first, the recording is dispatched after).
        const realPostMessage = webviewView.webview.postMessage.bind(webviewView.webview);
        webviewView.webview.postMessage =
            (message) => {
                const result = realPostMessage(message);
                if (this._eventStore && (0, SessionEventStore_1.isRecordable)(message)) {
                    this._eventStore.recordEvent(message);
                }
                return result;
            };
        // V2.1.2 spec-fix-12 — Bug #5: removed orphan registration
        // for scheme 'nexus-diff'. The provider is registered correctly
        // in extension.ts under 'nexus-original' (which is the scheme
        // showDiff actually constructs). This duplicate had no consumer.
        this._tracker?.setView(webviewView);
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build")
            ]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        // V2.2 hotfix #2 — sub-bundle 2a/2b: lazy-init the event store
        // and attempt to replay the active session log. The store
        // outlives webview reloads (it's instance-scoped on this
        // SidebarProvider, not webview-scoped), so a reload picks up
        // the same log file and the same activeFeature.
        //
        // Replay strategy: post a 'replayBegin' message, then stream
        // recorded events back as 'replayEvent' messages, then post
        // 'replayEnd'. The webview's reducer treats replay events
        // exactly like live events (toolCallEvent, chatToken, etc.)
        // — the only differences are (a) the begin/end bookends so
        // the webview can show a "restoring previous session..."
        // indicator, and (b) replay events are tagged with their
        // original timestamp so cards' startedAt fields stay accurate.
        //
        // Replay happens BEFORE the regular initState dispatch (which
        // sends the latest spec content from disk). This ordering is
        // intentional: the log replays cards/reasoning, then initState
        // syncs phaseState / activePlan / featureList from disk truth.
        // initState's payload always wins for state that disk-vs-log
        // can disagree about.
        if (!this._eventStore) {
            const wf = vscode.workspace.workspaceFolders?.[0];
            const root = this._isMetaMode ? this._extensionUri : wf?.uri;
            if (root) {
                this._eventStore = new SessionEventStore_1.SessionEventStore(root, this._currentFeature);
            }
        }
        else if (this._eventStore) {
            // Reload case: existing store, just refresh its feature
            // pointer in case the workspace changed.
            this._eventStore.setActiveFeature(this._currentFeature);
        }
        // Replay before any other webview messages. Because this is
        // async and resolveWebviewView is sync, we kick off the replay
        // and let it race with the rest of the resolve work — but we
        // post the bookend messages directly so the webview knows
        // what's happening.
        this.replayActiveSessionToWebview().catch((e) => logger_1.log.warn('[replay] failed:', String(e)));
        // P1.4: wire the hook event emitter to the webview. Lazy-construct
        // (no harm if no hook ever fires this session) and let the getter
        // call HookManager.setEmitter for us. Fires that happen between
        // extension activation and the first webview resolution drop
        // their events silently — that's a small window and the
        // OutputChannel still captures them.
        this.getHookEventEmitter();
        // PR 2.4b: subscribe to AuditLog so newly-emitted records stream
        // to the webview in real time. The AuditLogPanel renders them
        // via useAuditLog. If the webview reloads, onDidDispose tears
        // down the old subscription before resolveWebviewView re-runs
        // and registers a fresh one — no double-emission.
        if (this._auditUnsubscribe) {
            this._auditUnsubscribe();
            this._auditUnsubscribe = undefined;
        }
        try {
            const audit = (0, container_1.getDeps)().audit;
            this._auditUnsubscribe = audit.subscribe((record) => {
                // Best-effort post. If the webview is mid-teardown the
                // postMessage call may throw; we don't want that to
                // poison subsequent subscribers, so swallow with a warn.
                try {
                    this._view?.webview.postMessage({
                        type: 'auditEntryAppended',
                        record
                    });
                }
                catch (e) {
                    console.warn('[SidebarProvider] auditEntryAppended postMessage failed:', e);
                }
            });
        }
        catch (e) {
            // getDeps().audit may not be wired in some test contexts.
            // Don't block the webview from loading because audit isn't
            // available — the panel just won't see live records.
            console.warn('[SidebarProvider] audit subscription unavailable:', e);
        }
        webviewView.onDidDispose(() => {
            if (this._auditUnsubscribe) {
                this._auditUnsubscribe();
                this._auditUnsubscribe = undefined;
            }
            if (this._hooksUnsubscribe) {
                this._hooksUnsubscribe();
                this._hooksUnsubscribe = undefined;
            }
            if (this._steeringUnsubscribe) {
                this._steeringUnsubscribe();
                this._steeringUnsubscribe = undefined;
            }
            if (this._mcpUnsubscribe) {
                this._mcpUnsubscribe();
                this._mcpUnsubscribe = undefined;
            }
        });
        // PR 3.2: subscribe to HookManager list changes. Same lifecycle
        // as the audit subscription. Initial hook list is auto-delivered
        // by subscribeListChanges so we don't need to also call
        // requestHookList from the host side — the webview gets the
        // current state synchronously on subscribe.
        if (this._hooksUnsubscribe) {
            this._hooksUnsubscribe();
            this._hooksUnsubscribe = undefined;
        }
        try {
            const hm = HookManager_1.HookManager.getInstance();
            this._hooksUnsubscribe = hm.subscribeListChanges((summaries) => {
                try {
                    this._view?.webview.postMessage({
                        type: 'hookListUpdated',
                        hooks: summaries
                    });
                }
                catch (e) {
                    logger_1.log.warn('hookListUpdated postMessage failed:', e);
                }
            });
        }
        catch (e) {
            logger_1.log.warn('hooks subscription unavailable:', e);
        }
        // PR 3.3: subscribe to SteeringManager list changes. Same shape
        // as the hooks subscription above. We also kick off the manager's
        // start() here so its FS watcher is active for the webview's
        // lifetime. Idempotent — calling start() twice tears down the
        // old watcher cleanly.
        if (this._steeringUnsubscribe) {
            this._steeringUnsubscribe();
            this._steeringUnsubscribe = undefined;
        }
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders[0]) {
                const sm = SteeringManager_1.SteeringManager.getInstance();
                sm.start(workspaceFolders[0].uri);
                this._steeringUnsubscribe = sm.subscribeListChanges((summaries) => {
                    try {
                        this._view?.webview.postMessage({
                            type: 'steeringListUpdated',
                            items: summaries
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('steeringListUpdated postMessage failed:', e);
                    }
                });
            }
        }
        catch (e) {
            logger_1.log.warn('steering subscription unavailable:', e);
        }
        // P2.1: subscribe to McpManager status changes. The manager
        // is started during extension activation (extension.ts) so
        // we don't call start() here — just hook into status changes.
        // Initial state is delivered synchronously by subscribe().
        if (this._mcpUnsubscribe) {
            this._mcpUnsubscribe();
            this._mcpUnsubscribe = undefined;
        }
        try {
            this._mcpUnsubscribe = mcpManager_1.McpManager.getInstance().subscribe((views, error) => {
                try {
                    this._view?.webview.postMessage({
                        type: 'mcpStatusUpdated',
                        servers: views,
                        configError: error
                    });
                }
                catch (e) {
                    logger_1.log.warn('mcpStatusUpdated postMessage failed:', e);
                }
            });
        }
        catch (e) {
            logger_1.log.warn('mcp subscription unavailable:', e);
        }
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                //  THE FIX: The Webview Handshake. Loads chat history, PRD, design, tasks, steering rules.
                case "webviewReady": {
                    const chatHistory = (0, container_1.getDeps)().state.get('nexus_chat_history') || [];
                    const taskStatuses = (0, container_1.getDeps)().state.get('nexus_task_statuses') || {};
                    const taskSummaries = (0, container_1.getDeps)().state.get('nexus_task_summaries') || {};
                    const taskFiles = (0, container_1.getDeps)().state.get('nexus_task_files') || {};
                    const hasApiKey = !!(await (0, container_1.getDeps)().secrets.get('nexuscode_apikey'));
                    // V2.1.2 spec-fix-4: hydrate the current feature slug
                    // from workspaceState. Default 'main' preserves pre-fix
                    // behavior for users who never explicitly switched.
                    this._currentFeature = (0, container_1.getDeps)().state.get('nexus_current_feature') || SpecManager_1.DEFAULT_FEATURE;
                    let savedReqs = "";
                    let savedDesign = "";
                    let savedTasks = null;
                    let savedRules = "";
                    let savedPhaseState = null;
                    let featureList = [];
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const rootUri = workspaceFolders[0].uri;
                        (0, codeGraph_1.buildWorkspaceGraph)(rootUri).catch(e => logger_1.log.error("CodeGraph init failed:", e));
                        const specs = this.specs();
                        if (specs) {
                            savedReqs = await specs.readRequirements(this._currentFeature);
                            savedDesign = await specs.readDesign(this._currentFeature);
                            savedTasks = await specs.readTasksJson(this._currentFeature);
                            // Webview UI expects a single `nexusRules` string — feed it the
                            // combined steering content (product + structure + tech).
                            savedRules = (await specs.readSteering()).combined;
                            savedPhaseState = await specs.readPhaseState(this._currentFeature);
                            featureList = await specs.listFeatures();
                            this._activeRequirements = savedReqs;
                            this._activeDesign = savedDesign;
                        }
                    }
                    // Read the three per-agent thinking-mode flags so the
                    // webview can render the inline toggle. V2.0 created
                    // these settings; this is the first surface that
                    // exposes them via the chat UI. Per-agent control
                    // remains in VS Code settings (Cmd+,) — the inline
                    // pill is a single bulk toggle.
                    const cfg = vscode.workspace.getConfiguration('nexuscode');
                    const thinkingPlanner = cfg.get('thinkingPlanner') ?? true;
                    const thinkingCoder = cfg.get('thinkingCoder') ?? true;
                    const thinkingVerifier = cfg.get('thinkingVerifier') ?? true;
                    this._view?.webview.postMessage({
                        type: 'initState',
                        messages: chatHistory,
                        taskStatuses: taskStatuses,
                        taskSummaries: taskSummaries,
                        taskFiles: taskFiles,
                        requirements: savedReqs,
                        design: savedDesign,
                        tasks: savedTasks,
                        nexusRules: savedRules,
                        phaseState: savedPhaseState,
                        hasKey: hasApiKey,
                        thinkingMode: {
                            planner: thinkingPlanner,
                            coder: thinkingCoder,
                            verifier: thinkingVerifier,
                        },
                        // V2.1.2 spec-fix-4: multi-feature payload
                        currentFeature: this._currentFeature,
                        featureList,
                    });
                    break;
                }
                case "requestWorkspaceGraph": {
                    logger_1.log.debug("[DEBUG-MAP] 🟢 1. Webview requested workspace graph.");
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        logger_1.log.debug("[DEBUG-MAP] 🔴 Workspace folders not found.");
                        return;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const specs = new SpecManager_1.SpecManager(rootUri);
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Nexus: Indexing AST Code Map...' });
                    try {
                        logger_1.log.debug("[DEBUG-MAP] 🟡 2. Fetching raw CodeGraph...");
                        let rawCodeGraph = (0, codeGraph_1.getGraphJSON)();
                        // Force build if empty
                        if (!rawCodeGraph || rawCodeGraph === '{}') {
                            await (0, codeGraph_1.buildWorkspaceGraph)(rootUri);
                            rawCodeGraph = (0, codeGraph_1.getGraphJSON)();
                        }
                        let codeGraph = {};
                        if (rawCodeGraph) {
                            try {
                                codeGraph = typeof rawCodeGraph === 'string' ? JSON.parse(rawCodeGraph) : rawCodeGraph;
                            }
                            catch (e) {
                                logger_1.log.error("[DEBUG-MAP] 🔴 CodeGraph Parse Error:", e instanceof Error ? e.message : String(e));
                            }
                        }
                        logger_1.log.debug("[DEBUG-MAP] 🟡 3. Normalizing AST Dictionary...");
                        let normalizedCodeGraph = { nodes: [], edges: [] };
                        Object.entries(codeGraph).forEach(([filepath, data]) => {
                            if (filepath === 'nodes' || filepath === 'edges') {
                                return;
                            }
                            normalizedCodeGraph.nodes.push({ id: filepath, label: filepath.split('/').pop(), group: 'file' });
                            if (data.imports) {
                                data.imports.forEach((imp) => {
                                    const cleanImp = imp.replace(/['"]/g, '').replace('./', '').replace('../', '');
                                    const targetFile = Object.keys(codeGraph).find(k => k.includes(cleanImp));
                                    if (targetFile) {
                                        normalizedCodeGraph.edges.push({ source: filepath, target: targetFile });
                                    }
                                });
                            }
                        });
                        //  THE PROGRESSIVE LOADING INJECTION: Send CodeMap immediately!
                        logger_1.log.debug("[DEBUG-MAP] 🟢 4. Sending Initial CodeMap to Webview!");
                        this._view?.webview.postMessage({
                            type: 'workspaceGraphData',
                            data: {
                                codeMap: codeGraph, // Original dictionary for the pure AST view
                                reqMap: null,
                                combinedMap: null,
                                isGraphLoading: true // Locks the LLM buttons in the UI
                            }
                        });
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Nexus: Parsing Traceability Matrix (LLM)...' });
                        // --- BACKGROUND LLM PROCESSING ---
                        // V2.1.2 spec-fix-7: persistent traceability cache.
                        // The matrix can be reconstructed from disk in a few
                        // milliseconds when nothing has changed, vs ~80 seconds
                        // of LLM calls for 5 specs. Cache lives at
                        // .nexus/cache/traceability.json and is keyed per
                        // feature by content hash so single-spec edits only
                        // invalidate that one feature.
                        const { TraceabilityCache, hashContent } = await import('./context/traceabilityCache.js');
                        const cache = new TraceabilityCache(specs.cacheDir());
                        await cache.load();
                        // The webview can request a force-rebuild (the new
                        // ↻ Force Rebuild button) which clears the cache
                        // before processing. The default ↻ Refresh path
                        // honors the cache and only re-parses what changed.
                        const forceRebuild = data.force === true;
                        if (forceRebuild) {
                            logger_1.log.info('[DEBUG-MAP] Force rebuild requested; clearing cache.');
                            cache.clear();
                        }
                        let reqGraph = { nodes: [], edges: [] };
                        let designGraph = { nodes: [], edges: [] };
                        let aggregatedTasks = { implementationTasks: [] };
                        // Per-feature progress tracking. Sent to the webview
                        // so the user can see "got 3 of 5; 2 failed; 4 from cache".
                        const featureWarnings = [];
                        let featuresProcessed = 0;
                        let featuresWithReqs = 0;
                        let featuresWithDesign = 0;
                        let cacheHits = 0;
                        let cacheMisses = 0;
                        try {
                            const { parseRequirementGraph, parseDesignGraph } = await import('./context/traceabilityGraph.js');
                            const features = await specs.listFeatures();
                            // Update status. We don't yet know how many will
                            // hit cache vs miss, so the message stays generic
                            // until after the loop.
                            this._view?.webview.postMessage({
                                type: 'statusUpdate',
                                message: `Nexus: Aggregating ${features.length} spec${features.length === 1 ? '' : 's'}...`
                            });
                            for (const f of features) {
                                featuresProcessed++;
                                const cached = cache.get(f.slug);
                                // ─── Requirements per feature ─────────────────
                                try {
                                    const reqString = await specs.readRequirements(f.slug);
                                    if (reqString) {
                                        const reqHash = hashContent(reqString);
                                        let featureReq;
                                        if (cached && cached.reqHash === reqHash && cached.reqGraph) {
                                            // Cache hit — use the stored graph directly.
                                            featureReq = cached.reqGraph;
                                            cacheHits++;
                                        }
                                        else {
                                            // Cache miss — call the LLM, then store.
                                            featureReq = await parseRequirementGraph(reqString);
                                            cacheMisses++;
                                            // Update cache entry (or create if missing).
                                            cache.set(f.slug, {
                                                reqHash,
                                                reqGraph: featureReq,
                                                designHash: cached?.designHash ?? '',
                                                designGraph: cached?.designGraph ?? null,
                                                tasksHash: cached?.tasksHash ?? '',
                                                tasksJson: cached?.tasksJson ?? null,
                                            });
                                        }
                                        if (featureReq.nodes.length === 0) {
                                            featureWarnings.push({
                                                slug: f.slug,
                                                phase: 'requirements',
                                                reason: 'Parser returned no epics (LLM may have returned empty or malformed response)',
                                            });
                                        }
                                        else {
                                            featuresWithReqs++;
                                            for (const n of featureReq.nodes) {
                                                const prefixedId = `${f.slug}::${n.id}`;
                                                reqGraph.nodes.push({
                                                    ...n,
                                                    id: prefixedId,
                                                    label: features.length > 1 ? `[${f.slug}] ${n.label || n.id}` : (n.label || n.id),
                                                });
                                            }
                                            for (const e of featureReq.edges) {
                                                reqGraph.edges.push({
                                                    ...e,
                                                    source: `${f.slug}::${e.source}`,
                                                    target: `${f.slug}::${e.target}`,
                                                });
                                            }
                                        }
                                    }
                                    else {
                                        featureWarnings.push({
                                            slug: f.slug,
                                            phase: 'requirements',
                                            reason: 'No requirements.md found',
                                        });
                                    }
                                }
                                catch (e) {
                                    const reason = e instanceof Error ? e.message : String(e);
                                    logger_1.log.warn(`[DEBUG-MAP] reqs parse failed for ${f.slug}: ${reason}`);
                                    featureWarnings.push({ slug: f.slug, phase: 'requirements', reason });
                                }
                                // ─── Design per feature ───────────────────────
                                try {
                                    const designString = await specs.readDesign(f.slug);
                                    if (designString) {
                                        const designHash = hashContent(designString);
                                        // Re-read the cached entry — it may have been
                                        // updated by the requirements branch above.
                                        const cachedNow = cache.get(f.slug);
                                        let featureDesign;
                                        if (cachedNow && cachedNow.designHash === designHash && cachedNow.designGraph) {
                                            featureDesign = cachedNow.designGraph;
                                            cacheHits++;
                                        }
                                        else {
                                            featureDesign = await parseDesignGraph(designString);
                                            cacheMisses++;
                                            cache.set(f.slug, {
                                                reqHash: cachedNow?.reqHash ?? '',
                                                reqGraph: cachedNow?.reqGraph ?? null,
                                                designHash,
                                                designGraph: featureDesign,
                                                tasksHash: cachedNow?.tasksHash ?? '',
                                                tasksJson: cachedNow?.tasksJson ?? null,
                                            });
                                        }
                                        if (featureDesign.nodes.length > 0) {
                                            featuresWithDesign++;
                                            for (const n of featureDesign.nodes) {
                                                designGraph.nodes.push({
                                                    ...n,
                                                    id: `${f.slug}::${n.id}`,
                                                    label: features.length > 1 ? `[${f.slug}] ${n.label || n.id}` : (n.label || n.id),
                                                });
                                            }
                                            for (const e of featureDesign.edges) {
                                                designGraph.edges.push({
                                                    ...e,
                                                    source: `${f.slug}::${e.source}`,
                                                    target: `${f.slug}::${e.target}`,
                                                });
                                            }
                                        }
                                    }
                                }
                                catch (e) {
                                    const reason = e instanceof Error ? e.message : String(e);
                                    logger_1.log.warn(`[DEBUG-MAP] design parse failed for ${f.slug}: ${reason}`);
                                    featureWarnings.push({ slug: f.slug, phase: 'design', reason });
                                }
                                // ─── Tasks per feature ────────────────────────
                                // Tasks aren't LLM-parsed (they come straight from
                                // tasks.json), so caching them mainly avoids the
                                // file read. We still do it for consistency and
                                // because the prefixing/augmentation work IS
                                // CPU-visible at scale.
                                try {
                                    const featureTasks = await specs.readTasksJson(f.slug);
                                    if (featureTasks && Array.isArray(featureTasks.implementationTasks)) {
                                        for (const t of featureTasks.implementationTasks) {
                                            aggregatedTasks.implementationTasks.push({
                                                ...t,
                                                _featureSlug: f.slug,
                                                relatedRequirement: t.relatedRequirement
                                                    ? `${f.slug}::${t.relatedRequirement}`
                                                    : t.relatedRequirement,
                                            });
                                        }
                                        // Cache the augmented tasks payload — keyed on
                                        // a hash of the raw JSON for invalidation.
                                        const tasksHash = hashContent(JSON.stringify(featureTasks));
                                        const cachedNow = cache.get(f.slug);
                                        if (!cachedNow || cachedNow.tasksHash !== tasksHash) {
                                            cache.set(f.slug, {
                                                reqHash: cachedNow?.reqHash ?? '',
                                                reqGraph: cachedNow?.reqGraph ?? null,
                                                designHash: cachedNow?.designHash ?? '',
                                                designGraph: cachedNow?.designGraph ?? null,
                                                tasksHash,
                                                tasksJson: featureTasks,
                                            });
                                        }
                                    }
                                }
                                catch (e) {
                                    logger_1.log.warn(`[DEBUG-MAP] tasks parse failed for ${f.slug}:`, e instanceof Error ? e.message : String(e));
                                }
                            }
                            // Persist cache to disk after the full sweep — one
                            // write per refresh, batched.
                            await cache.save(specs.cacheDir());
                            logger_1.log.info(`[DEBUG-MAP] Aggregated traceability: ${featuresWithReqs}/${featuresProcessed} reqs, ${featuresWithDesign}/${featuresProcessed} designs, ${aggregatedTasks.implementationTasks.length} tasks · ${cacheHits} cached, ${cacheMisses} fresh`);
                        }
                        catch (e) {
                            logger_1.log.error("[DEBUG-MAP] traceability aggregation failed:", e instanceof Error ? e.message : String(e));
                        }
                        let tasksJson = aggregatedTasks;
                        // 2. Build the Ultimate Combined Matrix
                        let combinedGraph = { nodes: [...normalizedCodeGraph.nodes], edges: [...normalizedCodeGraph.edges] };
                        try {
                            const { buildCombinedGraph } = await import('./context/traceabilityGraph.js');
                            //  THE FIX: This now executes NO MATTER WHAT, successfully merging Code + PRD!
                            combinedGraph = buildCombinedGraph(normalizedCodeGraph, reqGraph, designGraph, tasksJson);
                        }
                        catch (e) {
                            logger_1.log.debug("[DEBUG-MAP] 🔴 Graph Combining failed:", e instanceof Error ? e.message : String(e));
                        }
                        logger_1.log.debug("[DEBUG-MAP] 🟢 5. Sending Final Traceability Payload to Webview!");
                        this._view?.webview.postMessage({
                            type: 'workspaceGraphData',
                            data: {
                                codeMap: codeGraph,
                                reqMap: reqGraph,
                                combinedMap: combinedGraph,
                                isGraphLoading: false, // Unlocks the UI buttons
                                // V2.1.2 spec-fix-5: per-feature diagnostics so the
                                // user can see "got 3 of 5 specs; the others failed"
                                // instead of staring at a sparse matrix wondering why.
                                featureCount: featuresProcessed,
                                featuresWithReqs,
                                featuresWithDesign,
                                featureWarnings,
                                // V2.1.2 spec-fix-8: cache stats. The cache hits +
                                // misses count individual graphs (req or design)
                                // not features, so a feature with both cached
                                // contributes 2 to cacheHits.
                                cacheHits,
                                cacheMisses,
                            }
                        });
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });
                    }
                    catch (error) {
                        const safeError = error instanceof Error ? error.message : String(error);
                        logger_1.log.error("[DEBUG-MAP] 🔴 FATAL GRAPH ERROR:", safeError);
                        // Fail gracefully
                        this._view?.webview.postMessage({
                            type: 'workspaceGraphData',
                            data: { codeMap: {}, reqMap: { nodes: [], edges: [] }, combinedMap: { nodes: [], edges: [] }, isGraphLoading: false }
                        });
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Failed to load maps.' });
                    }
                    break;
                }
                case "saveNexusRules": {
                    const specs = this.specs();
                    if (specs) {
                        try {
                            await specs.writeStructureRules(data.text);
                            vscode.window.showInformationMessage((0, i18n_1.t)("steering.rules_saved"));
                        }
                        catch (e) {
                            vscode.window.showErrorMessage((0, i18n_1.t)("steering.save_failed"));
                        }
                    }
                    break;
                }
                case "verifyTask": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'Gathering context to verify your code...' });
                    try {
                        const taskQuery = data.prompt || data.task;
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        // P1.3: load steering exclude patterns so the
                        // graph correlator skips paths the project
                        // says not to read (legacy/, generated/, etc.).
                        // Empty when no steering file declares any —
                        // behavior unchanged for projects without
                        // exclusions.
                        const excludePatterns = await SteeringManager_1.SteeringManager.getInstance().getExcludePatterns();
                        const [astContext, hybridContext] = await Promise.all([
                            (0, codeGraph_1.getSmartASTContext)(taskQuery, { excludePatterns }),
                            (0, hybridSearch_1.retrieveHybridContext)(taskQuery, 5, excludePatterns)
                        ]);
                        const fullContext = `${astContext}\n\n${hybridContext}`;
                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'AI QA is checking your work against PRD...' });
                        const verification = await (0, llmService_1.verifyAgainstSpec)(taskQuery, (0, styleContext_1.wrapUntrusted)(this._activeRequirements, '.nexus/specs/main/requirements.md'), fullContext);
                        if (verification.verified) {
                            const specs = new SpecManager_1.SpecManager(rootUri);
                            // Hotfix (post-2B): the webview now sends `task` as a UI-uniqueness
                            // key (e.g., "task-3") instead of the human-readable title.
                            // markTaskCompleted matches against the title in tasks.md, so we
                            // accept `data.taskTitle` if provided, falling back to `data.task`
                            // for back-compat with any caller that hasn't been updated yet.
                            await specs.markTaskCompleted(data.taskTitle ?? data.task, this._currentFeature);
                            try {
                                if (this._activeRequirements) {
                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus QA: Scanning your code to update Living PRD...` });
                                    let currentPRD = this._activeRequirements;
                                    // NOTE: updateLivingPRD has the LLM extract substrings from
                                    // the PRD that we then string-replace on the SAME PRD on disk.
                                    // We CANNOT wrap the PRD here — the wrapper prefix would either
                                    // a) appear in the returned "original" strings and break the
                                    //    subsequent currentPRD.replace() call, or
                                    // b) leak from the LLM's chain-of-thought back into the PRD.
                                    // The system prompt is already user-role-equivalent and the
                                    // operation is bounded (find substrings, return JSON), so the
                                    // injection blast radius is much smaller here than in the chat
                                    // path. Defence-in-depth: updateLivingPRD itself should
                                    // validate that returned `original` strings actually exist
                                    // in the PRD before applying replacements (already does).
                                    const prdUpdates = await (0, llmService_1.updateLivingPRD)(currentPRD, data.task, "Manual Code Edit", fullContext);
                                    if (prdUpdates.length > 0) {
                                        prdUpdates.forEach(update => {
                                            currentPRD = currentPRD.replace(update.original, update.updated);
                                        });
                                        await specs.writeRequirements(currentPRD, this._currentFeature);
                                        this._activeRequirements = currentPRD;
                                        this._view?.webview.postMessage({ type: 'requirementsUpdated', text: currentPRD });
                                    }
                                }
                            }
                            catch (e) {
                                logger_1.log.warn("[DEBUG] Living PRD QA check failed for manual verify", e);
                            }
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `✅ VERIFIED: ${verification.reasoning}` });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                        else {
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'rejected', summary: `❌ REJECTED: ${verification.reasoning}` });
                        }
                    }
                    catch (error) {
                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Verification Error: ${(0, errors_1.errorMessage)(error)}` });
                    }
                    break;
                }
                case "generateRequirements": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '━━━ Phase 1 of 3: Requirements ━━━' });
                    try {
                        this._view?.webview.postMessage({ type: 'reqStep', message: 'Drafting Agile User Stories & Acceptance Criteria...' });
                        const reqPlan = await (0, llmService_1.generateRequirements)(data.text, data.context, this._activeTaskController.signal);
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Project:      ${reqPlan.projectName}` });
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Domain:       ${reqPlan.domain}` });
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Stories:      ${reqPlan.userStories.length} generated` });
                        let enrichedPrompt = `---\n`;
                        enrichedPrompt += `version: 1.0.0\n`;
                        enrichedPrompt += `type: prd\n`;
                        enrichedPrompt += `project: "${reqPlan.projectName}"\n`;
                        enrichedPrompt += `domain: "${reqPlan.domain}"\n`;
                        enrichedPrompt += `---\n\n`;
                        enrichedPrompt += `# 📋 Product Requirements Document (PRD)\n\n`;
                        enrichedPrompt += `<metadata>\n  <target_audience>${reqPlan.targetAudience}</target_audience>\n</metadata>\n\n`;
                        enrichedPrompt += `## 🎯 Agile User Stories\n\n`;
                        // V2.1.2 spec-redesign hotfix: defensive coercion against
                        // missing fields in the model's response. Three failure modes
                        // we've actually observed:
                        //   1. nonFunctionalRequirements isn't in the schema at all,
                        //      so models that strictly follow the schema (Qwen 3.6
                        //      vs older models that volunteered the field) omit it.
                        //   2. Even fields marked `required` in the schema can come
                        //      back undefined when the endpoint runs strict:false
                        //      json_schema or json_object mode, because xgrammar
                        //      doesn't enforce all string-level constraints (see
                        //      llmService.ts ~line 795 for the wider context).
                        //   3. Models occasionally return a single string where the
                        //      schema asks for an array.
                        // Without these defaults, .forEach on undefined throws
                        // "Cannot read properties of undefined" mid-render and the
                        // whole generation reads as a failure even though the LLM
                        // succeeded. Coercion is cheap; bail-out is expensive.
                        const userStoriesList = Array.isArray(reqPlan.userStories) ? reqPlan.userStories : [];
                        const nfrList = Array.isArray(reqPlan.nonFunctionalRequirements) ? reqPlan.nonFunctionalRequirements : [];
                        const successMetricsList = Array.isArray(reqPlan.successMetrics) ? reqPlan.successMetrics : [];
                        const outOfScopeList = Array.isArray(reqPlan.outOfScope) ? reqPlan.outOfScope : [];
                        userStoriesList.forEach((us, eIdx) => {
                            const epicId = `EPIC-${(eIdx + 1).toString().padStart(2, '0')}`;
                            enrichedPrompt += `<epic id="${epicId}" name="${us.epic || 'General'}">\n`;
                            enrichedPrompt += `### ${epicId}: ${us.epic || 'General'}\n\n`;
                            const storyId = `STORY-${epicId}-1`;
                            enrichedPrompt += `<story id="${storyId}">\n`;
                            enrichedPrompt += `**Story:** ${us.story || 'N/A'}\n\n**Acceptance Criteria:**\n`;
                            const criteria = us.acceptanceCriteria || us.acceptenceCriteria || us.AcceptanceCriteria || [];
                            const criteriaArray = Array.isArray(criteria) ? criteria : [criteria];
                            criteriaArray.forEach((ac, cIdx) => {
                                enrichedPrompt += `- [ ] <criteria id="${storyId}-C${cIdx + 1}">${ac}</criteria>\n`;
                            });
                            enrichedPrompt += `</story>\n`;
                            enrichedPrompt += `</epic>\n\n`;
                        });
                        // NFR section — only render the block if we got NFRs.
                        // An empty <nfr_list></nfr_list> in the saved markdown is
                        // useless noise; better to omit it cleanly.
                        if (nfrList.length > 0) {
                            enrichedPrompt += `## 🛡️ Non-Functional Requirements (NFRs)\n`;
                            enrichedPrompt += `<nfr_list>\n`;
                            nfrList.forEach((nfr) => { enrichedPrompt += `- ${nfr}\n`; });
                            enrichedPrompt += `</nfr_list>\n`;
                        }
                        // Success metrics — same conditional rendering.
                        if (successMetricsList.length > 0) {
                            enrichedPrompt += `\n## 📊 Success Metrics\n`;
                            successMetricsList.forEach((m) => { enrichedPrompt += `- ${m}\n`; });
                        }
                        // Out of scope — same conditional rendering.
                        if (outOfScopeList.length > 0) {
                            enrichedPrompt += `\n## 🚫 Out of Scope\n`;
                            outOfScopeList.forEach((s) => { enrichedPrompt += `- ${s}\n`; });
                        }
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const specs = new SpecManager_1.SpecManager(rootUri);
                        await specs.writeRequirements(enrichedPrompt, this._currentFeature);
                        this._activeRequirements = enrichedPrompt;
                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved requirements.md` });
                        this._view?.webview.postMessage({ type: 'requirementsGenerated', text: enrichedPrompt });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await specs.readPhaseState(this._currentFeature) });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Cancelled by User.` });
                            this._view?.webview.postMessage({ type: 'generationFailed' });
                        }
                        else if (error instanceof llmService_1.EmptyCompletionError) {
                            // V2.1.2 fix: empty-completion is the most common cause of
                            // "click Auto-Generate, nothing happens, returns to edit page".
                            // Surface it via a dedicated specError event so the new
                            // stepper UI can render a prominent banner (the old reqStep
                            // path got blown away by generationFailed reverting the UI).
                            this._view?.webview.postMessage({
                                type: 'specError',
                                phase: 'requirements',
                                title: 'No response generated',
                                message: (0, errors_1.errorMessage)(error),
                            });
                        }
                        else {
                            this._view?.webview.postMessage({
                                type: 'specError',
                                phase: 'requirements',
                                title: 'Requirements generation failed',
                                message: (0, errors_1.errorMessage)(error),
                            });
                        }
                    }
                    finally {
                        this._activeTaskController = undefined;
                    }
                    break;
                }
                case "generateDesign": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    // PHASE GATE: requirements must be approved before design can be drafted.
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const gateSpecs = new SpecManager_1.SpecManager(rootUri);
                    try {
                        await gateSpecs.requirePhaseApproved('design', this._currentFeature);
                    }
                    catch (e) {
                        this._view?.webview.postMessage({ type: 'reqStep', message: `🔒 ${(0, errors_1.errorMessage)(e)}` });
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                        return;
                    }
                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Phase 2 of 3: System Design ━━━' });
                    this._view?.webview.postMessage({ type: 'reqStep', message: 'Analyzing approved PRD and drafting architecture...\n' });
                    try {
                        const designDoc = await (0, llmService_1.generateDesign)(data.requirements, this._activeTaskController.signal);
                        await new SpecManager_1.SpecManager(rootUri).writeDesign(designDoc, this._currentFeature);
                        this._activeDesign = designDoc;
                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved design.md` });
                        this._view?.webview.postMessage({ type: 'designGenerated', text: designDoc });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await new SpecManager_1.SpecManager(rootUri).readPhaseState(this._currentFeature) });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Architecting Cancelled by User.` });
                            this._view?.webview.postMessage({ type: 'generationFailed' });
                        }
                        else if (error instanceof llmService_1.EmptyCompletionError) {
                            this._view?.webview.postMessage({
                                type: 'specError',
                                phase: 'design',
                                title: 'No response generated',
                                message: (0, errors_1.errorMessage)(error),
                            });
                        }
                        else {
                            this._view?.webview.postMessage({
                                type: 'specError',
                                phase: 'design',
                                title: 'Design generation failed',
                                message: (0, errors_1.errorMessage)(error),
                            });
                        }
                    }
                    finally {
                        this._activeTaskController = undefined;
                    }
                    break;
                }
                case "generateProjectTasks": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    // PHASE GATE: design must be approved before tasks can be drafted.
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const gateSpecs = new SpecManager_1.SpecManager(rootUri);
                    try {
                        await gateSpecs.requirePhaseApproved('tasks', this._currentFeature);
                    }
                    catch (e) {
                        this._view?.webview.postMessage({ type: 'reqStep', message: `🔒 ${(0, errors_1.errorMessage)(e)}` });
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                        return;
                    }
                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Phase 3 of 3: Implementation Plan ━━━' });
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Drafting Master Implementation Plan..." });
                    this._view?.webview.postMessage({ type: 'startChatStream' });
                    try {
                        const projectContext = await (0, projectContext_1.getProjectContext)(rootUri.fsPath);
                        // P1.2: load active steering rules so the planner
                        // generates tasks consistent with project conventions
                        // ("always use Result<T,E>", "tests live next to
                        // their source"). buildSteeringPromptBlock returns
                        // empty string when no steering files have content,
                        // so this is a no-op for projects without steering.
                        const steeringBlock = await SteeringManager_1.SteeringManager.getInstance().buildSteeringPromptBlock();
                        const plan = await (0, llmService_1.generateTasks)(this._activeRequirements, this._activeDesign, projectContext, this._activeTaskController.signal, steeringBlock);
                        // ─── #3-DIAG (spec-fix-11) ─────────────────────────
                        // Spec-page task generation — same wrong-file edit
                        // investigation. Logs each generated task's file
                        // target so we can compare against the user's intent.
                        try {
                            const tasks = plan?.implementationTasks ?? [];
                            logger_1.log.info(`[#3-DIAG] generateTasks returned ${tasks.length} task(s) (spec-page path).`);
                            tasks.forEach((t, i) => {
                                const targetFile = typeof t === 'string' ? '(string-task; no .file)' : (t?.file ?? '(undefined)');
                                const step = typeof t === 'string' ? t : (t?.step ?? '(no step)');
                                logger_1.log.info(`[#3-DIAG] generateTasks task[${i}].file = "${targetFile}" — step: "${String(step).slice(0, 100)}"`);
                            });
                        }
                        catch (e) {
                            logger_1.log.warn('[#3-DIAG] Failed to log generateTasks output:', e instanceof Error ? e.message : String(e));
                        }
                        // ───────────────────────────────────────────────────
                        const specs = new SpecManager_1.SpecManager(rootUri);
                        await specs.writeTasksJson(plan, this._currentFeature);
                        let mdContent = `---\n`;
                        mdContent += `version: 1.0.0\n`;
                        mdContent += `type: implementation_plan\n`;
                        mdContent += `status: draft\n`;
                        mdContent += `---\n\n`;
                        mdContent += "# Master Implementation Plan\n\n## 📁 Folder Structure\n";
                        mdContent += `<folder_structure>\n`;
                        plan.folderStructure.forEach((f) => mdContent += `- \`${f}\`\n`);
                        mdContent += `</folder_structure>\n\n`;
                        mdContent += "## 🛠️ Execution Tasks\n";
                        mdContent += `<tasks>\n`;
                        plan.implementationTasks.forEach((t, i) => {
                            const taskId = `TASK-${(i + 1).toString().padStart(3, '0')}`;
                            const prevTaskId = i > 0 ? `TASK-${(i).toString().padStart(3, '0')}` : 'none';
                            if (typeof t === 'string') {
                                mdContent += `<task id="${taskId}" dependsOn="${prevTaskId}">\n`;
                                mdContent += `${i + 1}. [ ] ${t}\n`;
                                mdContent += `</task>\n\n`;
                            }
                            else {
                                mdContent += `<task id="${taskId}" dependsOn="${prevTaskId}" targetFile="${t.file}" relatesTo="${t.relatedRequirement || ''}">\n`;
                                mdContent += `${i + 1}. [ ] **${t.step}** (File: \`${t.file}\`)\n`;
                                mdContent += `   - *Instructions:* <instructions>${t.detailedInstructions}</instructions>\n`;
                                mdContent += `</task>\n\n`;
                            }
                        });
                        mdContent += `</tasks>\n`;
                        await specs.writeTasksMd(mdContent, this._currentFeature);
                        const { finalPaths, renamingMap } = await (0, pathUtils_1.resolveCanonicalPaths)(plan.folderStructure, rootUri.fsPath);
                        plan.folderStructure = finalPaths;
                        plan.implementationTasks = plan.implementationTasks.map((task) => {
                            if (typeof task === 'string') {
                                return task;
                            }
                            let updatedTask = { ...task };
                            renamingMap.forEach((realPath, plannedPath) => {
                                if (updatedTask.file === plannedPath) {
                                    updatedTask.file = realPath;
                                }
                                if (updatedTask.detailedInstructions.includes(plannedPath)) {
                                    updatedTask.detailedInstructions = updatedTask.detailedInstructions.replace(plannedPath, realPath);
                                }
                            });
                            return updatedTask;
                        });
                        if (plan.folderStructure.length > 0) {
                            await (0, workspaceManager_1.createWorkspaceStructure)(plan.folderStructure);
                        }
                        this._view?.webview.postMessage({ type: 'chatToken', token: "I have analyzed the PRD and System Architecture. Here is the master implementation plan. You can execute these tasks one by one using the buttons below, or run them all at once.\n\n" });
                        this._view?.webview.postMessage({ type: "structureResponse", value: plan });
                        this._view?.webview.postMessage({ type: 'tasksGenerated' });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await specs.readPhaseState(this._currentFeature) });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🛑 Planning Cancelled by User.` });
                            this._view?.webview.postMessage({ type: 'generationFailed' });
                        }
                        else if (error instanceof llmService_1.EmptyCompletionError) {
                            this._view?.webview.postMessage({
                                type: 'specError',
                                phase: 'tasks',
                                title: 'No response generated',
                                message: (0, errors_1.errorMessage)(error),
                            });
                        }
                        else {
                            this._view?.webview.postMessage({
                                type: 'specError',
                                phase: 'tasks',
                                title: 'Tasks generation failed',
                                message: (0, errors_1.errorMessage)(error),
                            });
                        }
                    }
                    finally {
                        this._activeTaskController = undefined;
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    break;
                }
                case "requestRevision": {
                    // Hotfix (post-2B): the webview's `data.task` is now a UI-uniqueness
                    // key (e.g., "task-3"); use `data.taskTitle` for the human-readable
                    // prompt so the user sees the actual task description, not the
                    // internal key.
                    const taskLabel = data.taskTitle ?? data.task;
                    const feedback = await vscode.window.showInputBox({
                        prompt: `Why was the code for "${taskLabel}" rejected?`,
                        placeHolder: "e.g., 'Use axios instead of fetch', or 'Fix the null pointer error'"
                    });
                    if (feedback === undefined) {
                        return;
                    }
                    this._view?.webview.postMessage({
                        type: 'startRevision',
                        task: data.task,
                        feedback: feedback || "The previous attempt was rejected. Try a different approach and ensure the code is completely bug-free."
                    });
                    break;
                }
                case "approvePhase": {
                    // Webview sends { phase: 'requirements' | 'design' | 'tasks' }
                    const specs = this.specs();
                    if (specs && this.isValidPhase(data.phase)) {
                        const next = await specs.setPhaseStatus(data.phase, 'approved', this._currentFeature);
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: next });
                        vscode.window.showInformationMessage(`✅ ${data.phase} approved.`);
                    }
                    break;
                }
                case "rejectPhase": {
                    // Webview sends { phase: 'requirements' | 'design' | 'tasks' }
                    // Resets the rejected phase + every downstream phase to 'not_started'
                    // so the user has to explicitly regenerate them.
                    const specs = this.specs();
                    if (specs && this.isValidPhase(data.phase)) {
                        const next = await specs.resetFromPhase(data.phase, this._currentFeature);
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: next });
                        vscode.window.showInformationMessage(`↩️ ${data.phase} rejected. Regenerate when ready.`);
                    }
                    break;
                }
                case "reopenPRD": {
                    // V2.2 hotfix #3: non-destructive navigation back to PRD.
                    //
                    // Differs from startOver:
                    //   - startOver: deletes requirements.md + design.md +
                    //     tasks.md + tasks.json on disk, AND cascades phase
                    //     reset (resetFromPhase('requirements') sets all
                    //     three to 'not_started')
                    //   - reopenPRD: ONLY flips phaseState.requirements
                    //     from 'approved' back to 'draft'. All files on
                    //     disk stay intact. Design + tasks remain available;
                    //     user decides whether to regenerate them after
                    //     re-approving PRD or keep as-is.
                    //
                    // The user's mental model: "I want to look at the PRD
                    // again, maybe tweak something, but I don't want to
                    // throw away the design and 18-task plan I already
                    // built." Start Over was the wrong tool for that;
                    // this is the right tool.
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        break;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const sm = new SpecManager_1.SpecManager(rootUri);
                    try {
                        await sm.setPhaseStatus('requirements', 'draft', this._currentFeature);
                        const phaseState = await sm.readPhaseState(this._currentFeature);
                        const reqs = await sm.readRequirements(this._currentFeature);
                        const dsg = await sm.readDesign(this._currentFeature);
                        const tasksJson = await sm.readTasksJson(this._currentFeature);
                        this._activeRequirements = reqs;
                        this._activeDesign = dsg;
                        // Send featureChanged with the unchanged content but
                        // updated phaseState so the webview re-renders with
                        // the requirements section back in editable mode.
                        this._view?.webview.postMessage({
                            type: 'featureChanged',
                            currentFeature: this._currentFeature,
                            requirements: reqs,
                            design: dsg,
                            tasks: tasksJson,
                            phaseState,
                            featureList: await sm.listFeatures(),
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('[reopenPRD] failed:', (0, errors_1.errorMessage)(e));
                    }
                    break;
                }
                case "startOver": {
                    // V2.1.2 spec-fix-3: full clean-slate reset for the active feature.
                    // Webview's "Start Over" buttons used to only clear local React
                    // state and fire updateRequirements:"" — that left phaseState.json
                    // on disk untouched, so all approved flags survived and the user
                    // couldn't actually re-generate from scratch (the page kept
                    // showing "Approve Tasks" and "Go to Coder" buttons even after
                    // clearing the textarea).
                    //
                    // Four steps, in this exact order to avoid races:
                    //   1. Reset phaseState.json — both requirements and design
                    //      reset paths actually walk the same code (resetFromPhase
                    //      with 'requirements' clears ALL three because it walks
                    //      from that phase forward).
                    //   2. Delete the saved spec files (requirements.md, design.md,
                    //      tasks.md, tasks.json) so a regeneration doesn't merge
                    //      with stale content.
                    //   3. Clear in-memory copies on the host so any in-flight
                    //      reads pick up the cleared state.
                    //   4. Notify the webview with a fresh phaseState so the UI
                    //      bounces back to the "describe your idea" empty state.
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        break;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const sm = new SpecManager_1.SpecManager(rootUri);
                    try {
                        // Step 1: reset phaseState
                        const next = await sm.resetFromPhase('requirements', this._currentFeature);
                        // Step 2: delete the saved spec files. We use a best-effort
                        // delete loop because some files may not exist (e.g. user
                        // never made it past requirements). VS Code's fs.delete
                        // throws on missing files, so we wrap each one.
                        const featureDir = vscode.Uri.joinPath(rootUri, '.nexus', 'specs', sm.slugifyName(this._currentFeature));
                        const filesToDelete = ['requirements.md', 'design.md', 'tasks.md', 'tasks.json'];
                        for (const f of filesToDelete) {
                            try {
                                await vscode.workspace.fs.delete(vscode.Uri.joinPath(featureDir, f));
                            }
                            catch {
                                // File didn't exist — fine, that's the goal anyway.
                            }
                        }
                        // Step 3: clear host-side in-memory copies.
                        this._activeRequirements = "";
                        this._activeDesign = "";
                        // V2.2 hotfix #2 (2a): roll the session log
                        // forward. After Start Over, the next replay
                        // should NOT show the wiped task's history —
                        // user explicitly asked for a fresh slate. Old
                        // log files stay on disk for forensic value
                        // but a new current.txt pointer means future
                        // reloads start blank.
                        if (this._eventStore) {
                            await this._eventStore.startNewSession();
                        }
                        // Step 4: notify the webview.
                        // V2.2 hotfix #4: also send fresh featureList so the
                        // webview's "View existing spec" picker can re-filter
                        // with the now-empty phaseState. Without this, the
                        // webview's filter applies to a stale list and the
                        // just-reset feature still appears.
                        this._view?.webview.postMessage({
                            type: 'phaseStateUpdated',
                            phaseState: next,
                            featureList: await sm.listFeatures(),
                        });
                        vscode.window.showInformationMessage('↩️ Spec reset. Start a new idea anytime.');
                    }
                    catch (e) {
                        // Don't surface as an error to the user via popup —
                        // partial cleanup is still better than nothing, and
                        // they can retry. Log for diagnosis though.
                        logger_1.log.warn('[startOver] partial cleanup:', (0, errors_1.errorMessage)(e));
                    }
                    break;
                }
                case "setCurrentFeature": {
                    // V2.1.2 spec-fix-4: switch the active feature. Triggered
                    // by the webview's switcher dropdown. We persist the
                    // choice to workspaceState (so it survives VS Code
                    // restart) and re-hydrate the spec page with the new
                    // feature's content via a featureChanged message.
                    //
                    // No-op if the requested slug isn't a real feature on
                    // disk (defensive — protects against typos in stored
                    // state if the user manually deleted a directory).
                    const requested = typeof data.slug === 'string' ? data.slug : SpecManager_1.DEFAULT_FEATURE;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        break;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const sm = new SpecManager_1.SpecManager(rootUri);
                    const exists = await sm.featureExists(requested);
                    if (!exists && requested !== SpecManager_1.DEFAULT_FEATURE) {
                        // Asked to switch to a feature that doesn't exist.
                        // Don't silently create it — that's createFeature's
                        // job. Tell the webview the switch failed.
                        this._view?.webview.postMessage({
                            type: 'featureChangeFailed',
                            slug: requested,
                            reason: `Feature "${requested}" not found.`,
                        });
                        break;
                    }
                    this._currentFeature = sm.slugifyName(requested);
                    // V2.2 hotfix #2 (2a): switch the event store's
                    // active feature so subsequent recordings go into
                    // the right per-feature directory.
                    if (this._eventStore) {
                        this._eventStore.setActiveFeature(this._currentFeature);
                    }
                    await (0, container_1.getDeps)().state.update('nexus_current_feature', this._currentFeature);
                    // Re-hydrate spec content for the new feature.
                    const reqs = await sm.readRequirements(this._currentFeature);
                    const dsg = await sm.readDesign(this._currentFeature);
                    const tasksJson = await sm.readTasksJson(this._currentFeature);
                    const phaseState = await sm.readPhaseState(this._currentFeature);
                    this._activeRequirements = reqs;
                    this._activeDesign = dsg;
                    this._view?.webview.postMessage({
                        type: 'featureChanged',
                        currentFeature: this._currentFeature,
                        requirements: reqs,
                        design: dsg,
                        tasks: tasksJson,
                        phaseState,
                        featureList: await sm.listFeatures(),
                    });
                    break;
                }
                case "createFeature": {
                    // V2.1.2 spec-fix-4: create a new feature and switch to it.
                    // Triggered by the empty-state name field OR by the "+ New"
                    // button in the switcher dropdown. We slugify aggressively
                    // (the user types "My Checkout Flow!" and gets
                    // "my-checkout-flow") and refuse if the slug already
                    // exists OR if it slugifies to empty/main and wasn't
                    // explicitly asked for.
                    const requested = typeof data.name === 'string' ? data.name : '';
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        break;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const sm = new SpecManager_1.SpecManager(rootUri);
                    const slug = sm.slugifyName(requested);
                    if (!slug || (slug === SpecManager_1.DEFAULT_FEATURE && requested.trim() !== SpecManager_1.DEFAULT_FEATURE)) {
                        this._view?.webview.postMessage({
                            type: 'featureChangeFailed',
                            slug,
                            reason: `Cannot create feature with that name. Use letters, numbers, and dashes.`,
                        });
                        break;
                    }
                    if (await sm.featureExists(slug)) {
                        this._view?.webview.postMessage({
                            type: 'featureChangeFailed',
                            slug,
                            reason: `A feature called "${slug}" already exists. Switch to it instead, or pick a different name.`,
                        });
                        break;
                    }
                    // Create the directory + initial phaseState.json by
                    // calling featureDir + readPhaseState — the latter
                    // returns the default { all not_started } shape and
                    // writes nothing. The directory will be populated on
                    // first writeRequirements call.
                    await sm.featureDir(slug);
                    this._currentFeature = slug;
                    await (0, container_1.getDeps)().state.update('nexus_current_feature', slug);
                    // Reset in-memory copies — fresh feature has no content.
                    this._activeRequirements = "";
                    this._activeDesign = "";
                    this._view?.webview.postMessage({
                        type: 'featureChanged',
                        currentFeature: slug,
                        requirements: '',
                        design: '',
                        tasks: null,
                        phaseState: await sm.readPhaseState(slug),
                        featureList: await sm.listFeatures(),
                    });
                    break;
                }
                case "updateRequirements": {
                    this._activeRequirements = data.text;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        try {
                            await new SpecManager_1.SpecManager(rootUri).writeRequirements(data.text, this._currentFeature);
                        }
                        catch (e) { }
                    }
                    else if (data.text === "") {
                        this._activeRequirements = "";
                        this._activeDesign = "";
                    }
                    break;
                }
                case "updateDesign": {
                    this._activeDesign = data.text;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        try {
                            await new SpecManager_1.SpecManager(rootUri).writeDesign(data.text, this._currentFeature);
                        }
                        catch (e) { }
                    }
                    break;
                }
                case "syncHistory": {
                    let historyToSave = data.messages;
                    //  THE COMPACTOR DAEMON THRESHOLD
                    if (historyToSave.length > 15) {
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "🗜️ Nexus is compacting context memory..." });
                        try {
                            // Keep the 5 most recent messages for immediate conversational context
                            const RECENT_KEEP_COUNT = 5;
                            const messagesToCompact = historyToSave.slice(0, historyToSave.length - RECENT_KEEP_COUNT);
                            const recentMessages = historyToSave.slice(historyToSave.length - RECENT_KEEP_COUNT);
                            const summary = await (0, llmService_1.compactConversationHistory)(messagesToCompact);
                            historyToSave = [
                                { role: 'assistant', isCompacted: true, content: summary },
                                ...recentMessages
                            ];
                            this._view?.webview.postMessage({ type: 'historyCompacted', messages: historyToSave });
                        }
                        catch (e) {
                            logger_1.log.error("Compaction failed", e);
                        }
                        finally {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                    }
                    // 🚀 FIX: Use workspaceState to save data safely without overwriting other projects
                    await (0, container_1.getDeps)().state.update('nexus_chat_history', historyToSave);
                    await (0, container_1.getDeps)().state.update('nexus_task_statuses', data.taskStatuses);
                    await (0, container_1.getDeps)().state.update('nexus_task_summaries', data.taskSummaries);
                    await (0, container_1.getDeps)().state.update('nexus_task_files', data.taskFiles);
                    break;
                }
                case "clearHistory":
                    await (0, container_1.getDeps)().state.update('nexus_chat_history', []);
                    // V2.2 hotfix: do NOT wipe task statuses / summaries / files
                    // here. They represent "what work has been done in this
                    // feature" — orthogonal to chat content. The user's
                    // intent on clearHistory is "fresh chat," not "wipe
                    // progress." Previously these were cleared too, which
                    // meant clearing chat lost all task-progression UI
                    // (the plan card showed bare task names with no
                    // status pills, even though the underlying tasks.md
                    // on disk still recorded which were complete).
                    //
                    // The Start Over flow handles "true reset" — it deletes
                    // the spec files on disk AND the persisted state.
                    // clearHistory is the lighter-touch sibling.
                    break;
                case "getTimelineEvents": {
                    // P3.1: Timeline tab requests all session events
                    // for the active feature. We fan out to the
                    // SessionEventStore which reads every events-*.jsonl
                    // in the feature directory (max 5 per V2.2 rotation)
                    // and concatenates them with sessionStamp tags.
                    //
                    // The webview owns the reducer (eventsToTimelineModel)
                    // — keeps the structuring logic in one place and
                    // makes the host a pure data-fetcher. Payload is
                    // bounded by rotation policy so postMessage size
                    // is reasonable.
                    if (!this._eventStore) {
                        this._view?.webview.postMessage({
                            type: 'timelineEvents',
                            events: [],
                            empty: true,
                            reason: 'no-session-store',
                        });
                        break;
                    }
                    try {
                        const allEvents = await this._eventStore.readAllLogsForFeature();
                        // RecordedEvent shape is { ts, payload }. The
                        // reducer in the webview consumes the payloads
                        // — extract them and forward.
                        const payloads = allEvents.map(e => e.payload);
                        this._view?.webview.postMessage({
                            type: 'timelineEvents',
                            events: payloads,
                            count: payloads.length,
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('[getTimelineEvents] failed:', String(e));
                        this._view?.webview.postMessage({
                            type: 'timelineEvents',
                            events: [],
                            empty: true,
                            reason: 'read-error',
                            errorMessage: String(e),
                        });
                    }
                    break;
                }
                case "exportSession": {
                    // V2.2 hotfix: bundle the current session into a
                    // single JSON file under .nexus/exports/<feature>-
                    // <timestamp>.json and open it in an editor tab so
                    // the user can save-as, copy, or share with a
                    // support engineer.
                    //
                    // Bundle contents:
                    //   - exportedAt, feature, nexusVersion
                    //   - phaseState + specs (requirements + design + tasksJson)
                    //     read FRESH from disk so the export reflects
                    //     ground truth, not a stale React copy
                    //   - chat: messages + task state from the webview
                    //     (passed in this message — host doesn't have a
                    //     React-equivalent copy)
                    //   - events: full session event log if 2a captured
                    //     anything during this session
                    //   - featureList: contextual list of all features
                    //     in the workspace
                    //
                    // Failures (write error, fs unavailable) are
                    // non-fatal — we toast the error and continue. The
                    // export button isn't in any critical path.
                    try {
                        const wf = vscode.workspace.workspaceFolders?.[0];
                        if (!wf) {
                            vscode.window.showWarningMessage('Cannot export — no workspace folder is open.');
                            break;
                        }
                        const root = this._isMetaMode ? this._extensionUri : wf.uri;
                        const sm = new SpecManager_1.SpecManager(root);
                        const phaseState = await sm.readPhaseState(this._currentFeature);
                        const requirements = await sm.readRequirements(this._currentFeature);
                        const design = await sm.readDesign(this._currentFeature);
                        let tasksJson = null;
                        try {
                            tasksJson = await sm.readTasksJson(this._currentFeature);
                        }
                        catch {
                            // tasks.json may not exist yet; not an error.
                        }
                        const featureList = await sm.listFeatures();
                        // Pull the event log if 2a captured one.
                        let events = [];
                        if (this._eventStore) {
                            const recorded = await this._eventStore.readActiveLog();
                            if (recorded) {
                                events = recorded;
                            }
                        }
                        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
                        const bundle = {
                            exportedAt: new Date().toISOString(),
                            feature: this._currentFeature,
                            phaseState,
                            specs: {
                                requirements,
                                design,
                                tasksJson,
                            },
                            chat: {
                                // These come from the webview's React
                                // state — host doesn't have its own copy
                                // of these (the host's chat history is
                                // workspaceState which is a different
                                // shape). Defensively coerce to JSON-
                                // safe values; if any field is undefined,
                                // export an empty/null placeholder.
                                messages: Array.isArray(data.messages) ? data.messages : [],
                                taskStatuses: data.taskStatuses ?? {},
                                taskSummaries: data.taskSummaries ?? {},
                                taskFiles: data.taskFiles ?? {},
                                taskSteps: data.taskSteps ?? {},
                                taskReasoning: data.taskReasoning ?? {},
                                activePlan: data.activePlan ?? null,
                            },
                            events,
                            featureList,
                        };
                        const json = JSON.stringify(bundle, null, 2);
                        const exportsDir = vscode.Uri.joinPath(root, '.nexus', 'exports');
                        await vscode.workspace.fs.createDirectory(exportsDir);
                        const exportUri = vscode.Uri.joinPath(exportsDir, `${this._currentFeature}-${stamp}.json`);
                        await vscode.workspace.fs.writeFile(exportUri, Buffer.from(json, 'utf8'));
                        // Open in an editor tab. preview:false keeps
                        // it open after the user clicks elsewhere.
                        const doc = await vscode.workspace.openTextDocument(exportUri);
                        await vscode.window.showTextDocument(doc, { preview: false });
                        vscode.window.showInformationMessage(`📦 Session exported to .nexus/exports/${this._currentFeature}-${stamp}.json (${(json.length / 1024).toFixed(1)} KB, ${events.length} events)`);
                    }
                    catch (e) {
                        logger_1.log.warn('[exportSession] failed:', (0, errors_1.errorMessage)(e));
                        vscode.window.showErrorMessage(`Export failed: ${(0, errors_1.errorMessage)(e)}`);
                    }
                    break;
                }
                case "saveApiKey":
                    await (0, container_1.getDeps)().secrets.store('nexuscode_apikey', data.value);
                    vscode.window.showInformationMessage((0, i18n_1.t)("api_key.saved_securely"));
                    this._view?.webview.postMessage({ type: 'initState', messages: [], hasKey: true });
                    break;
                case "processUserMessage": {
                    this._activeTaskController = new AbortController();
                    // V2.1.2 spec-fix-12 — Bug #1: latch the AutoPilot
                    // flag for this chat session so the approval hook can
                    // read it. Coerce defensively: older webview bundles
                    // may not include the field.
                    this._currentAutopilot = Boolean(data.autopilot);
                    try {
                        const workspacePath = await this.getTargetContext();
                        //  PHASE 5: INTERCEPT CUSTOM MARKDOWN SKILLS
                        const { SkillsManager } = await import('./skillsManager.js');
                        await SkillsManager.initializeSkillsDirectory(workspacePath);
                        const skillResult = await SkillsManager.processSkill(workspacePath, data.text);
                        if (skillResult.isSkill) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `✨ Executing Custom Skill...` });
                        }
                        else {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing intent..." });
                        }
                        // V2.1.2 spec-fix-10 P5.2: applyExploreFix re-uses
                        // this case via a synthesized prompt and explicitly
                        // forces intent='build'. Skip the LLM classifier
                        // when the caller already knows what it wants —
                        // a "fix the bug we just diagnosed" prompt could
                        // misclassify back to 'explore' otherwise.
                        const forcedIntent = data.forceIntent;
                        const intent = (forcedIntent === 'build' || forcedIntent === 'explore' || forcedIntent === 'explain' || forcedIntent === 'ask')
                            ? forcedIntent
                            : await (0, llmService_1.determineIntent)(data.text);
                        const fullPrompt = data.context
                            ? `--- ATTACHED CONTEXT ---\n${data.context}\n\n--- USER QUERY ---\n${data.text}`
                            : data.text;
                        if (intent === 'build') {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting plan..." });
                            this._view?.webview.postMessage({ type: 'startChatStream' });
                            await (0, ragIndexer_1.indexWorkspace)((msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));
                            // Hotfix (post-2B): include the directory tree
                            // alongside the LSP/AST/RAG context. The
                            // generatePlan system prompt instructs the model
                            // to "ADAPT to the existing folder structure" and
                            // its user template labels the second argument
                            // as "EXISTING DIRECTORY STRUCTURE" — but until
                            // this fix the SidebarProvider was passing only
                            // LSP symbols + AST nodes + RAG embeddings, none
                            // of which look like a folder structure to the
                            // model. With no concrete file-path anchors to
                            // populate task.file against, the model would
                            // return implementationTasks: [] (twice — both
                            // attempts of validateTasksPlan's retry loop),
                            // surfacing as "plan has zero tasks" to the user.
                            //
                            // Adding getProjectContext gives the model a real
                            // ASCII tree of the workspace files. The LSP /
                            // AST / RAG signals stay in the bundle as
                            // semantic enrichment around the structural
                            // anchor.
                            const projectStructure = await (0, projectContext_1.getProjectContext)(workspacePath);
                            // P1.3: load steering exclude patterns
                            // alongside the other context sources, then
                            // pass them into getSmartASTContext.
                            const excludePatterns = await SteeringManager_1.SteeringManager.getInstance().getExcludePatterns();
                            const [lspContext, styleGuideMsgs, astContext, hybridContext] = await Promise.all([
                                (0, lspContext_1.getLspContext)(data.text),
                                (0, styleContext_1.getProjectStyleGuides)(),
                                (0, codeGraph_1.getSmartASTContext)(data.text, { excludePatterns }),
                                (0, hybridSearch_1.retrieveHybridContext)(data.text, 5, excludePatterns)
                            ]);
                            const styleGuide = styleGuideMsgs.map(m => m.content).join('\n');
                            // PRD and design come from files in the user's workspace and so are
                            // a prompt-injection vector — wrap them with the same untrusted
                            // envelope used for steering rules. See audit §13.
                            const requirementInjection = (0, styleContext_1.wrapUntrusted)(this._activeRequirements, '.nexus/specs/main/requirements.md');
                            const designInjection = (0, styleContext_1.wrapUntrusted)(this._activeDesign, '.nexus/specs/main/design.md');
                            // Order matters: the directory tree goes FIRST
                            // because the user message template (in
                            // generatePlan) prepends a "EXISTING DIRECTORY
                            // STRUCTURE:" label. The downstream LSP/AST/RAG
                            // context follows as semantic enrichment.
                            const finalContext = `${projectStructure}\n\n--- SEMANTIC CONTEXT ---\n${lspContext}\n\n${astContext}\n\n${hybridContext}\n\n${styleGuide}\n\n${requirementInjection}\n\n${designInjection}`;
                            // V2.1.3: planner-driven scaffolding. When
                            // the workspace looks empty + the prompt
                            // sounds like a greenfield request, build
                            // a scaffoldHint so the planner emits a
                            // scaffold task as task[0]. For brownfield
                            // workspaces this runs but the hint stays
                            // undefined — generatePlan's prompt is
                            // identical to before in that case.
                            //
                            // Note: the existing dialog flow (handled
                            // by requestScaffoldDecision) STILL runs
                            // when the webview triggers it. Today, the
                            // dialog usually scaffolds first and the
                            // workspace is no longer empty by the time
                            // generatePlan runs here — so the hint
                            // ends up undefined and behavior is
                            // unchanged. The planner-driven path lights
                            // up only when the dialog is skipped or
                            // bypassed; a future bundle can retire the
                            // dialog in favor of this path if desired.
                            const scaffoldInfo = await this.detectGreenfieldForPrompt(data.text);
                            const scaffoldHint = (scaffoldInfo && scaffoldInfo.detection.isGreenfield)
                                ? {
                                    confidence: scaffoldInfo.detection.confidence,
                                    ...(scaffoldInfo.detection.stackHint
                                        ? { stackHint: scaffoldInfo.detection.stackHint }
                                        : {}),
                                    availableTemplates: scaffoldInfo.templates,
                                }
                                : undefined;
                            const result = await (0, llmService_1.generatePlan)(fullPrompt, finalContext, scaffoldHint);
                            // ─── #3-DIAG (spec-fix-11) ─────────────────────────
                            // Wrong-file edit investigation. Logs the planner's
                            // chosen file for each task so we can compare against
                            // the user's intent. Will be removed after the
                            // investigation concludes.
                            try {
                                const tasks = result.plan?.implementationTasks ?? [];
                                logger_1.log.info(`[#3-DIAG] Planner returned ${tasks.length} task(s) for build-mode prompt. User prompt was:`, fullPrompt.slice(0, 200));
                                tasks.forEach((t, i) => {
                                    const targetFile = typeof t === 'string' ? '(string-task; no .file)' : (t?.file ?? '(undefined)');
                                    const step = typeof t === 'string' ? t : (t?.step ?? '(no step)');
                                    logger_1.log.info(`[#3-DIAG] Planner task[${i}].file = "${targetFile}" — step: "${String(step).slice(0, 100)}"`);
                                });
                            }
                            catch (e) {
                                logger_1.log.warn('[#3-DIAG] Failed to log planner output:', e instanceof Error ? e.message : String(e));
                            }
                            // ───────────────────────────────────────────────────
                            this._view?.webview.postMessage({ type: 'chatToken', token: result.explanation + "\n\n" });
                            const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                            const { finalPaths, renamingMap } = await (0, pathUtils_1.resolveCanonicalPaths)(result.plan.folderStructure, rootSearchPath);
                            result.plan.folderStructure = finalPaths;
                            result.plan.implementationTasks = result.plan.implementationTasks.map(task => {
                                let updatedTask = task;
                                renamingMap.forEach((realPath, plannedPath) => {
                                    const plannedName = path.basename(plannedPath);
                                    if (typeof updatedTask === 'string') {
                                        if (updatedTask.includes(plannedPath)) {
                                            updatedTask = updatedTask.replace(plannedPath, realPath);
                                        }
                                        else if (updatedTask.includes(plannedName)) {
                                            updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`);
                                        }
                                    }
                                });
                                return updatedTask;
                            });
                            if (result.plan.folderStructure.length > 0) {
                                await (0, workspaceManager_1.createWorkspaceStructure)(result.plan.folderStructure);
                            }
                            this._view?.webview.postMessage({ type: "structureResponse", value: result.plan });
                        }
                        else if (intent === 'explore') {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🔍 Agentic Exploration: Investigating..." });
                            // 🔥 Create a dummy task ID so the UI renders the beautiful Swarm Logs
                            const exploreTaskId = "Exploration-" + Date.now();
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: exploreTaskId, status: 'reviewing', summary: 'Gathering forensic evidence...' });
                            const workspacePath = await this.getTargetContext();
                            // 🚀 FAST-TRACK: Pre-fetch the AST so the AI doesn't have to guess!
                            const projectContext = await (0, projectContext_1.getProjectContext)(workspacePath);
                            // Coordinator rewrite C-3: explore intent now goes
                            // through PlannerAgent.run({mode: 'explore'})
                            // instead of the legacy runAgenticExploration.
                            // This unifies the explore and build planner code
                            // paths under a single ReAct engine, eliminates
                            // the legacy `agentStep` log lines (which were
                            // dead UI for the explore intent — they only
                            // rendered inside plan task cards, and explore
                            // doesn't have a plan), and surfaces tool calls
                            // through the rich-card UI via toolEventEmitter
                            // — same as the build flow.
                            //
                            // The "Initializing Dynamic Search" status that
                            // used to fire from runAgenticExploration's
                            // statusCallback is gone. Users now see the
                            // "🔍 Agentic Exploration: Investigating..."
                            // header above + rich tool-call cards in the
                            // global cards region as the planner explores.
                            const exploreResult = await PlannerAgent_1.PlannerAgent.run({
                                mode: 'explore',
                                task: data.text,
                                workspaceRoot: workspacePath,
                                initialContext: projectContext,
                                log: (msg, stepType, details) => {
                                    // Bridge planner log lines (e.g., when no
                                    // emitter is wired and the legacy log
                                    // surface is the only feedback) into the
                                    // legacy agentStep stream so any future
                                    // explore-task UI continues to receive them.
                                    this._view?.webview.postMessage({
                                        type: 'agentStep',
                                        task: exploreTaskId,
                                        stepType: stepType ?? 'analyze',
                                        description: msg,
                                        details: details ?? ''
                                    });
                                },
                                toolEventEmitter: this.getToolEventEmitter(),
                                abortSignal: this._activeTaskController.signal
                            });
                            // The explore-mode result exposes the accumulated
                            // tool results as `gatheredContext`. The legacy
                            // function returned them directly; the new field
                            // makes the contract explicit.
                            const explorationContext = exploreResult.gatheredContext ?? "";
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing evidence..." });
                            // V2.1.2 spec-fix-10 P5.2: tag the stream as
                            // 'explore' and include the original prompt so
                            // the webview can render an "Apply this fix"
                            // button under the assistant's response and
                            // route the click back with full context.
                            this._view?.webview.postMessage({
                                type: 'startChatStream',
                                intent: 'explore',
                                originalPrompt: data.text,
                            });
                            const fullContext = `--- FORENSIC EVIDENCE GATHERED BY TOOLS ---\n${explorationContext}\n\nBased on this evidence, explain exactly what went wrong and how we should fix it.`;
                            // Stream the final analysis back to the chat window
                            await (0, llmService_1.streamChat)(data.text, fullContext, data.history || [], (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); }, this._activeTaskController.signal);
                            this._view?.webview.postMessage({ type: 'taskCompleted', task: exploreTaskId, status: 'approved', summary: 'Exploration Complete' });
                        }
                        else {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Gathering context..." });
                            const workspacePath = await this.getTargetContext();
                            const ragContext = await (0, hybridSearch_1.retrieveHybridContext)(data.text, 5);
                            if (ragContext) {
                                this._view?.webview.postMessage({
                                    type: 'glassBrain',
                                    text: ragContext
                                });
                            }
                            let openFilesContext = "";
                            vscode.workspace.textDocuments.forEach(doc => {
                                if (doc.uri.scheme === 'file' && !doc.fileName.includes('node_modules') && !doc.fileName.includes('.git')) {
                                    openFilesContext += `\n📍 OPEN FILE: ${vscode.workspace.asRelativePath(doc.uri)}\n\`\`\`\n${doc.getText().substring(0, 3000)}\n\`\`\`\n`;
                                }
                            });
                            let fullContext = "";
                            if (intent === 'explain') {
                                const projectStructure = await (0, projectContext_1.getProjectContext)(workspacePath);
                                const truncatedStructure = projectStructure.length > 15000 ? projectStructure.substring(0, 15000) + "\n...[TRUNCATED TO SAVE TOKENS]" : projectStructure;
                                fullContext = `Directory Tree:\n${truncatedStructure}\n\nCurrently Open Files:\n${openFilesContext}\n\nVector Search Context:\n${ragContext}`;
                            }
                            else {
                                fullContext = `Currently Open Files:\n${openFilesContext}\n\nVector Search Context:\n${ragContext}`;
                            }
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Thinking..." });
                            this._view?.webview.postMessage({ type: 'startChatStream' });
                            await (0, llmService_1.streamChat)(fullPrompt, fullContext, data.history || [], (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); }, this._activeTaskController.signal);
                        }
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "⚠️ Generation stopped." });
                            setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);
                        }
                        else if (error instanceof llmService_1.EmptyCompletionError) {
                            // Empty-completion is most often a context-overflow
                            // case on Qwen 3.6 27B (32K cap). Surface it INLINE
                            // in the chat rather than as a modal popup — users
                            // are looking at the chat thread when the silence
                            // happens, so the explanation should land there.
                            //
                            // Without this branch, streamChat throws and we
                            // hit the generic showErrorMessage path below,
                            // which puts a modal at the bottom-right corner
                            // of VS Code that users frequently miss.
                            this._view?.webview.postMessage({
                                type: 'chatToken',
                                token: `\n\n⚠️ **No response generated.** ${(0, errors_1.errorMessage)(error)}`,
                            });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                        else {
                            vscode.window.showErrorMessage(`NexusCode Error: ${(0, errors_1.errorMessage)(error)}`);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                            this._view?.webview.postMessage({ type: 'taskCompleted', status: 'error' });
                        }
                    }
                    finally {
                        this._activeTaskController = undefined;
                    }
                    break;
                }
                case "cancelTask": {
                    if (this._activeTaskController) {
                        this._activeTaskController.abort();
                        this._activeTaskController = undefined;
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "⚠️ Task cancelled by user." });
                        setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);
                    }
                    break;
                }
                // V2.1.2 spec-fix-10 P5.2: explore-mode "Apply this fix"
                // dispatcher. The webview emits this when the user clicks
                // the button (or when auto-apply opt-in fires) below an
                // explore-mode response.
                //
                // Payload:
                //   - originalPrompt — what the user typed (e.g.
                //     "where is the dashboard?")
                //   - exploreResponse — the assistant's diagnosis,
                //     verbatim
                //   - source — 'button' | 'auto'; threaded through to
                //     the audit log so reviewers can distinguish click
                //     authorization vs setting authorization
                //
                // The synthesized build prompt gives the planner full
                // context: original intent + diagnosis. We route through
                // processUserMessage with forceIntent='build' so the
                // existing planner→coder pipeline does the heavy lifting
                // and we don't duplicate 80+ lines of build-mode prep.
                case "applyExploreFix": {
                    const originalPrompt = typeof data.originalPrompt === 'string' ? data.originalPrompt : '';
                    const exploreResponse = typeof data.exploreResponse === 'string' ? data.exploreResponse : '';
                    const source = data.source === 'auto' ? 'auto' : 'button';
                    if (!originalPrompt || !exploreResponse) {
                        logger_1.log.warn('[applyExploreFix] Missing originalPrompt or exploreResponse; ignoring.');
                        break;
                    }
                    // Audit hook — record the apply event with its source
                    // so the audit trail explicitly captures whether
                    // authorization came from a click or the auto setting.
                    // Wrapped in try/catch because audit logging is
                    // best-effort; never block the user-facing flow on it.
                    try {
                        logger_1.log.info(`[applyExploreFix] source=${source}, original prompt length=${originalPrompt.length}, explore response length=${exploreResponse.length}`);
                    }
                    catch { /* ignore */ }
                    // Synthesize the build-mode prompt. The structure here
                    // is intentional:
                    //   1. Lead with explicit "apply the fix" instruction
                    //      to anchor the planner's intent.
                    //   2. Surface the original user request for grounding
                    //      (so the planner doesn't drift to a different
                    //      problem the diagnosis happens to mention).
                    //   3. Append the full diagnosis as forensic context.
                    const synthesizedPrompt = `Apply the fix described in the prior analysis below. Do not re-investigate; the diagnosis has already been done.

--- ORIGINAL USER REQUEST ---
${originalPrompt}

--- DIAGNOSIS FROM EXPLORE MODE ---
${exploreResponse}

Now make the file edits required to resolve this. Generate a concrete plan with implementation tasks.`;
                    // Re-emit to the webview so the user sees the fix
                    // being attempted in their chat thread (good UX —
                    // the apply isn't silent), then route to the build
                    // pipeline with intent forced.
                    //
                    // V2.1.2 spec-fix-13: also send originalPrompt and
                    // exploreResponse as separate fields so the webview
                    // can render a compact fix-application card instead
                    // of dumping the whole synthesized prompt as a giant
                    // user-message bubble. The full `text` field is
                    // unchanged (still feeds the planner verbatim); only
                    // what the user sees in chat changes.
                    this._view?.webview.postMessage({
                        type: 'addUserMessageAndSubmit',
                        text: synthesizedPrompt,
                        // Pass forceIntent through so processUserMessage
                        // skips determineIntent. The webview adapter
                        // doesn't strip this field — it forwards data
                        // verbatim into the next processUserMessage call.
                        forceIntent: 'build',
                        // Mark the source for downstream audit/telemetry.
                        applySource: source,
                        // V2.1.2 spec-fix-13: parts for compact rendering.
                        applyOriginalPrompt: originalPrompt,
                        applyDiagnosisLength: exploreResponse.length,
                    });
                    break;
                }
                case "executeTask": {
                    const originalTaskQuery = data.prompt || data.task;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    this._activeTaskController = new AbortController();
                    // V2.1.2 spec-fix-12 — Bug #1: latch the AutoPilot
                    // flag for this task so the approval hook gates
                    // write_file / edit_file calls correctly.
                    this._currentAutopilot = Boolean(data.autopilot);
                    // V2.1.3: scaffold-template tasks short-circuit the
                    // standard MCTS+Coder pipeline. Apply the template
                    // directly and report completion. The standard
                    // pipeline would still work but waste cycles
                    // generating "approaches" for what's a deterministic
                    // file-copy operation.
                    const taskKind = typeof data.taskKind === 'string' ? data.taskKind : undefined;
                    if (taskKind === 'scaffold-template') {
                        const templateId = typeof data.templateId === 'string' ? data.templateId : '';
                        if (!templateId) {
                            logger_1.log.error('[Scaffold] scaffold-template task missing templateId');
                            this._view?.webview.postMessage({
                                type: 'taskCompleted',
                                task: data.task,
                                success: false,
                                error: 'Scaffold task missing templateId'
                            });
                            return;
                        }
                        try {
                            const templates = (0, templateLoader_1.discoverTemplates)(rootUri.fsPath, this._extensionUri.fsPath);
                            const tpl = templates.find(t => t.id === templateId);
                            if (!tpl) {
                                throw new Error(`Template "${templateId}" not found.`);
                            }
                            const result = (0, scaffoldApplier_1.applyTemplate)(tpl, rootUri.fsPath, nodeFsAdapter_1.nodeFsAdapter);
                            logger_1.log.info(`[Scaffold] V2.1.3 planner-driven apply ${tpl.id}: ${result.written.length} written, ${result.skipped.length} skipped`);
                            this._view?.webview.postMessage({
                                type: 'agentStep',
                                task: data.task,
                                step: { type: 'analyze',
                                    description: `Scaffolded ${tpl.displayName}`,
                                    details: `Wrote ${result.written.length} files: ${result.written.slice(0, 6).join(', ')}${result.written.length > 6 ? '…' : ''}` }
                            });
                            this._view?.webview.postMessage({
                                type: 'taskCompleted',
                                task: data.task,
                                success: true,
                                summary: `Applied ${tpl.displayName} scaffold (${result.written.length} files).`
                            });
                            // Note: scaffold actions are recorded in the
                            // extension log via the log.info call above.
                            // A dedicated AuditLog.logScaffoldApply
                            // method belongs with the v2 governance
                            // work — adding it here would touch the
                            // audit interface for one call site.
                        }
                        catch (e) {
                            const msg = (0, errors_1.errorMessage)(e);
                            logger_1.log.error(`[Scaffold] V2.1.3 planner-driven apply failed: ${msg}`);
                            this._view?.webview.postMessage({
                                type: 'taskCompleted',
                                task: data.task,
                                success: false,
                                error: `Scaffold failed: ${msg}`
                            });
                        }
                        return;
                    }
                    // scaffold-llm falls through to the standard pipeline.
                    // The prompt already contains scaffolding instructions
                    // from the planner; the Coder will create files via
                    // write_file tool calls. No special routing needed —
                    // the Coder is already capable of multi-file creation.
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode Swarm Execution Engine...",
                        cancellable: true
                    }, async (_progress, token) => {
                        token.onCancellationRequested(() => this._activeTaskController?.abort());
                        const taskStartTime = Date.now();
                        // 🚀 MASTER TRY-CATCH: Protects the UI from freezing on catastrophic Node.js crashes
                        try {
                            const gitCheck = await this._terminalManager?.runCommandWithCapture("git status", rootUri.fsPath);
                            const isGitRepo = gitCheck && gitCheck.success;
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Generating MCTS Execution Branches...` });
                            let approaches = [originalTaskQuery];
                            if (isGitRepo) {
                                approaches = await (0, llmService_1.generateMCTSApproaches)(originalTaskQuery, "Generating alternative architectures...");
                            }
                            let success = false;
                            let finalMergedFilepath = "";
                            // V2.2 cross-task remediation: accumulate
                            // workspace-relative filepaths the agent
                            // wrote during this task. Used to attribute
                            // any new tsc errors to the most-recent
                            // task that touched the failing file.
                            const filesTouchedThisTask = [];
                            for (let i = 0; i < approaches.length; i++) {
                                if (success || token.isCancellationRequested) {
                                    break;
                                }
                                const approachNum = i + 1;
                                const isMCTSActive = approaches.length > 1;
                                const currentApproachPrompt = isMCTSActive ? `Original Task: ${originalTaskQuery}\n\nImplementation Directive (Approach ${approachNum}):\n${approaches[i]}` : originalTaskQuery;
                                const sandboxBranch = `nexus-mcts-sandbox-${Date.now()}`;
                                try {
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git stash`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -b ${sandboxBranch}`, rootUri.fsPath);
                                    }
                                    const swarmSpecs = new SpecManager_1.SpecManager(rootUri);
                                    const previousFailures = await swarmSpecs.readFailures();
                                    const env = new VSCodeEnvironment_1.VSCodeEnvironment();
                                    const globalRules = (await swarmSpecs.readSteering()).combined;
                                    // Coordinator rewrite C-5: SwarmCoordinator
                                    // class wrapper deleted. The orchestrator
                                    // is now a free function `runTask` taking
                                    // a named-params options object. Eliminates
                                    // the 13-positional-arg call site that
                                    // had been a recurring regression vector.
                                    //
                                    // Also: the previous call passed
                                    // `lspBlastRadiusContext = "LSP Context
                                    // dynamic fetch handled by Swarm."` as a
                                    // dead positional argument (the
                                    // Coordinator's `_lspContext` parameter
                                    // was never read). Both ends of that dead
                                    // pipe are gone.
                                    //
                                    // Per-task tool-card affinity (Phase 1):
                                    // the backend uses the raw approach prompt
                                    // (`currentApproachPrompt`) as the taskId
                                    // it stamps onto every lifecycle event.
                                    // The webview tracks state by `data.task`
                                    // (a positional key like "task-3"). They
                                    // don't naturally match. Send an explicit
                                    // mapping so the webview can group
                                    // incoming `toolCallEvent` messages under
                                    // the right task expansion. Sent BEFORE
                                    // runTask so the map is populated before
                                    // any events arrive.
                                    this._view?.webview.postMessage({
                                        type: 'taskExecutionStarted',
                                        taskKey: data.task,
                                        backendTaskId: currentApproachPrompt,
                                    });
                                    // V2.3 bundle 3: detect installed
                                    // packages so the Coder's system
                                    // prompt can include the actual
                                    // available libraries. Without this,
                                    // the Coder uses training-data
                                    // assumptions about what's available
                                    // — causing "phantom imports"
                                    // (importing rrule when it isn't
                                    // installed) and type drift bugs
                                    // (Prisma.BookingWhereInput phantom
                                    // because the installed Prisma
                                    // version doesn't export it).
                                    const installedPackagesResult = await (0, installedPackages_1.detectInstalledPackages)(rootUri);
                                    const installedPackagesSection = (0, installedPackages_1.renderPackagesPromptSection)(installedPackagesResult);
                                    // V2.3 bundle 4: detect high-value
                                    // type symbols (Prisma exports,
                                    // Express interfaces, Zod schemas).
                                    // Targets phantom-type-reference
                                    // bugs by giving the Coder the
                                    // ACTUAL exported names from the
                                    // installed package version, not
                                    // training-data assumptions.
                                    const typeSymbolsResult = await (0, typescriptSymbols_1.detectHighValueSymbols)(rootUri);
                                    const typeSymbolsSection = (0, typescriptSymbols_1.renderSymbolsPromptSection)(typeSymbolsResult);
                                    const finalDiffs = await (0, Coordinator_1.runTask)({
                                        env,
                                        task: currentApproachPrompt,
                                        workspaceRoot: rootUri.fsPath,
                                        activeRequirements: this._activeRequirements,
                                        activeDesign: this._activeDesign,
                                        previousFailures,
                                        globalRules,
                                        ...(installedPackagesSection ? { installedPackagesSection } : {}),
                                        ...(typeSymbolsSection ? { typeSymbolsSection } : {}),
                                        // P2.2: route per-Coder steering through
                                        // SteeringManager so the Coder gets:
                                        //   - Template-stripped content
                                        //   - Custom steering files (not just
                                        //     product/structure/tech)
                                        //   - Scope filtering ("## Applies to")
                                        //
                                        // The Coordinator caches the result per
                                        // file across retries, so this closure
                                        // is invoked at most once per filepath
                                        // per task.
                                        perFileSteering: async (filepath) => SteeringManager_1.SteeringManager.getInstance().buildSteeringPromptBlock({
                                            targetFilepath: filepath
                                        }),
                                        log: (msg, stepType, details) => {
                                            this._view?.webview.postMessage({ type: 'statusUpdate', message: msg });
                                            if (stepType && details) {
                                                // P3.1 bundle 2: phase tracking. Map stepType
                                                // to our coarse phase enum so subsequent
                                                // tokenUsage events get attributed correctly.
                                                // Mirror the same mapping as the Timeline
                                                // reducer (agentStep handler) so attribution
                                                // is consistent end-to-end.
                                                const lower = stepType.toLowerCase();
                                                if (lower.includes('plan')) {
                                                    this._activeAgentPhase = 'planner';
                                                }
                                                else if (lower.includes('verif')) {
                                                    this._activeAgentPhase = 'verifier';
                                                }
                                                else if (lower.includes('cod')) {
                                                    this._activeAgentPhase = 'coder';
                                                }
                                                this._view?.webview.postMessage({
                                                    type: 'agentStep',
                                                    task: data.task,
                                                    stepType: stepType,
                                                    description: msg.replace('Coordinator: ', ''),
                                                    details: details
                                                });
                                            }
                                        },
                                        streamCallback: (streamToken) => {
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: streamToken });
                                        },
                                        ...(this._activeTaskController?.signal ? { abortSignal: this._activeTaskController.signal } : {}),
                                        usageCallback: (usage) => {
                                            // P3.1 bundle 2: tag with current agent phase
                                            // so the Timeline reducer can attribute tokens
                                            // to planner / coder / verifier.
                                            this._view?.webview.postMessage({
                                                type: 'tokenUsage',
                                                task: data.task,
                                                phase: this._activeAgentPhase,
                                                usage,
                                            });
                                        },
                                        // Lifecycle event emitter for tool calls.
                                        // Lazily-constructed; sink is webview
                                        // postMessage. The 'toolCallEvent'
                                        // messages are consumed by the rich
                                        // tool-call cards in the webview.
                                        toolEventEmitter: this.getToolEventEmitter(),
                                        // V2.1.2 spec-fix-12 — Bug #1:
                                        // approval gate. The hook
                                        // auto-approves when AutoPilot
                                        // is ON or the tool is
                                        // non-mutating; otherwise it
                                        // posts requestToolApproval to
                                        // the webview and awaits a
                                        // click. Coordinator forwards
                                        // it down to CoderAgent →
                                        // ReActEngine → dispatchWithEvents.
                                        approvalHook: this.buildApprovalHook(),
                                        // V2.2 hotfix #4: clear stale
                                        // tool cards on retry. Without
                                        // this, retried tasks accumulated
                                        // read_file / list_directory cards
                                        // from each attempt visually
                                        // stacking, making the current
                                        // attempt's work hard to read.
                                        taskRetryCallback: (taskId, attempt) => {
                                            // Reset host-side seq counters
                                            // for both Coder and Verifier
                                            // sub-scopes. The taskId comes
                                            // in as "task-N::filepath" —
                                            // also reset the matching
                                            // verifier sub-scope so the
                                            // next attempt's cards start
                                            // from seq=0 cleanly.
                                            const emitter = this.getToolEventEmitter();
                                            emitter.resetTask(taskId);
                                            // Verifier sub-scope: split
                                            // and reinsert the ::verifier::
                                            // marker.
                                            const parts = taskId.split('::');
                                            if (parts.length === 2) {
                                                emitter.resetTask(`${parts[0]}::verifier::${parts[1]}`);
                                            }
                                            this._view?.webview.postMessage({
                                                type: 'taskRetry',
                                                taskId,
                                                attempt,
                                            });
                                        },
                                    });
                                    if (!finalDiffs || finalDiffs.length === 0) {
                                        throw new Error("Swarm failed to generate verified code.");
                                    }
                                    // 🚀 UPGRADED: Loop through every diff generated by the Swarm and apply them!
                                    for (const finalDiff of finalDiffs) {
                                        const realFilepath = finalDiff.filepath;
                                        const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);
                                        let fileContent = "";
                                        try {
                                            const fileData = await vscode.workspace.fs.readFile(fileUri);
                                            fileContent = new TextDecoder().decode(fileData);
                                        }
                                        catch {
                                            await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                        }
                                        // V2.1.2 spec-fix-12 — Bugs #4 + #5:
                                        // Populate undo stack and the diff
                                        // provider's content map BEFORE we
                                        // apply the new edit. fileContent
                                        // holds the pre-edit original — both
                                        // consumers need that exact baseline.
                                        //
                                        // Bug #5 (Undo always says "no history"):
                                        //   Adds an entry keyed by the task
                                        //   ID so the undoTaskEdit handler
                                        //   can find it.
                                        //
                                        // Bug #4 + #5 (Diff shows "everything
                                        // was added"):
                                        //   showDiff opens the file as
                                        //   `nexus-original:<path>`, which
                                        //   the originalContentProvider
                                        //   serves. It was returning empty
                                        //   string because nothing called
                                        //   setContent. Now it has the real
                                        //   pre-edit content — vscode.diff
                                        //   renders proper line-level hunks
                                        //   because both sides are non-empty.
                                        this._undoStack.set(data.task, {
                                            filepath: realFilepath,
                                            originalContent: fileContent
                                        });
                                        const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);
                                        diffProvider_1.originalContentProvider.setContent(originalUri, fileContent);
                                        // Component 2B-3c: when CoderAgent used the
                                        // tool-call path, the file is already modified
                                        // on disk and finalDiff.finalContent holds the
                                        // verifier-approved post-mod content. Use that
                                        // directly. Legacy SEARCH/REPLACE callers (planner
                                        // narrative output, verifier-synthesized diffs)
                                        // leave finalContent undefined and fall through to
                                        // the applySearchReplace path.
                                        const finalPerfectCode = finalDiff.finalContent !== undefined
                                            ? finalDiff.finalContent
                                            : applySearchReplace(fileContent, finalDiff.searchBlock, finalDiff.replaceBlock, finalDiff.fullOutputBuffer);
                                        const document = await vscode.workspace.openTextDocument(fileUri);
                                        const editor = await vscode.window.showTextDocument(document, { preview: false });
                                        // V2.2 hotfix #3: don't append separator newline when header is
                                        // empty (no-comment formats like JSON). Otherwise JSON files
                                        // would get a stray leading "\n" — valid but ugly.
                                        const rawHeader = (0, commentStyles_1.getAIHeader)(realFilepath, currentApproachPrompt, fileContent);
                                        const mergedHeader = rawHeader.length > 0 ? rawHeader + "\n" : "";
                                        const finalCodePayload = mergedHeader + finalPerfectCode;
                                        await editor.edit(b => {
                                            b.delete(new vscode.Range(0, 0, document.lineCount, 0));
                                            b.insert(new vscode.Position(0, 0), finalCodePayload);
                                        });
                                        await document.save();
                                        // Track provenance for EACH file edited in the Sub-Task graph
                                        if (this._tracker) {
                                            this._tracker.trackStreamedReview(editor, fileContent, data.task, 0, document.lineCount);
                                        }
                                        finalMergedFilepath = realFilepath; // Keep the last one for the UI success message
                                        // V2.2 cross-task remediation: record this file in the
                                        // task's touched-list. Skip duplicates from MCTS
                                        // approach retries hitting the same file.
                                        if (!filesTouchedThisTask.includes(realFilepath)) {
                                            filesTouchedThisTask.push(realFilepath);
                                        }
                                    }
                                    // MCTS Success Merge
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git add . && git commit -m "chore: nexus mcts approach ${approachNum}"`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git merge ${sandboxBranch} --squash`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git branch -D ${sandboxBranch}`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git stash pop`, rootUri.fsPath);
                                    }
                                    success = true;
                                }
                                catch (error) {
                                    if ((0, errors_1.isAbortError)(error)) {
                                        throw error; // 🚀 FIX: Bubble the abort up immediately!
                                    }
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git reset --hard`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git branch -D ${sandboxBranch}`, rootUri.fsPath);
                                    }
                                    else {
                                        vscode.window.showErrorMessage(`Execution failed: ${(0, errors_1.errorMessage)(error)}`);
                                    }
                                }
                            } // End of MCTS approaches loop
                            // 🚀 THE FIX: Aggressively update the task status so the UI spinner stops!
                            if (success) {
                                const totalTime = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                                // 🚀 FIX: Explicitly check off the task in tasks.md on the hard drive
                                try {
                                    // Hotfix (post-2B): see verifyTask for rationale. data.task is now
                                    // a UI-uniqueness key (e.g., "task-3"); the title for tasks.md
                                    // sync comes from data.taskTitle when available.
                                    await new SpecManager_1.SpecManager(rootUri).markTaskCompleted(data.taskTitle ?? data.task, this._currentFeature);
                                }
                                catch (e) {
                                    logger_1.log.warn("Could not auto-update tasks.md", e);
                                }
                                // Trigger the green checkmark
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: "approved", filepath: finalMergedFilepath, summary: `Updated ${finalMergedFilepath} (Total: ${totalTime}s)` });
                                // Guarantee state sync
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `Updated ${finalMergedFilepath}` });
                                // V2.2 cross-task remediation: analyze
                                // whether this task's edits broke any
                                // EARLIER task's compile invariants.
                                // Async background work — never blocks
                                // the success path UI; failures are
                                // logged and silently absorbed.
                                this.runCrossTaskAnalysis({
                                    taskKey: data.task,
                                    taskTitle: data.taskTitle ?? data.task,
                                    filesTouched: filesTouchedThisTask,
                                    completedAt: Date.now(),
                                }, rootUri.fsPath).catch((e) => {
                                    logger_1.log.warn(`[CrossTask] analysis failed for ${data.task}: ${(0, errors_1.errorMessage)(e)}`);
                                });
                            }
                            else {
                                const errorSummary = approaches.length > 1 ? `⚠️ All ${approaches.length} MCTS Approaches Failed.` : `⚠️ Execution Failed.`;
                                // 🔥 The UI expects taskStatusUpdate to kill the spinner on failure
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: errorSummary });
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: errorSummary });
                            }
                        }
                        catch (fatalError) {
                            // 🚀 FIX: Catch the explicit abort and gracefully update the UI to "error" (which triggers the Retry button)
                            if ((0, errors_1.isAbortError)(fatalError) || token.isCancellationRequested) {
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: '🛑 Task Cancelled by User.' });
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: '🛑 Task Cancelled by User.' });
                            }
                            else {
                                // Catch catastrophic Node.js crashes so the UI doesn't hang forever
                                const safeErrorMessage = (0, errors_1.errorMessage)(fatalError);
                                vscode.window.showErrorMessage(`Nexus Catastrophic Failure: ${safeErrorMessage}`);
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Fatal Crash: ${safeErrorMessage}` });
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error' });
                            }
                        }
                        finally {
                            // Always clean up the execution state
                            this._activeTaskController = undefined;
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                    });
                    break;
                }
                case "refreshCodeLens": {
                    vscode.commands.executeCommand('nexuscode.refreshLens');
                    break;
                }
                case "undoTaskEdit": {
                    const undoData = this._undoStack.get(data.task);
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (undoData && workspaceFolders) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const fileUri = vscode.Uri.joinPath(rootUri, undoData.filepath);
                        try {
                            const edit = new vscode.WorkspaceEdit();
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            // Replace the entire file with the original content
                            edit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), undoData.originalContent);
                            await vscode.workspace.applyEdit(edit);
                            await document.save();
                            vscode.window.showInformationMessage(`⏪ Undid AI edits to ${undoData.filepath}`);
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'undone', summary: `⏪ Reverted to original state.` });
                        }
                        catch (e) {
                            vscode.window.showErrorMessage((0, i18n_1.t)("undo.failed_to_undo"));
                        }
                    }
                    else {
                        vscode.window.showWarningMessage((0, i18n_1.t)("undo.no_history"));
                    }
                    break;
                }
                case "runGlobalCompiler": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    const workspacePath = workspaceFolders[0].uri.fsPath;
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Running Global Workspace Compiler..." });
                    // 🚀 POLYGLOT GLOBAL COMPILER: Sniff the workspace to find the right command
                    let buildCommand = "";
                    try {
                        const files = await vscode.workspace.fs.readDirectory(workspaceFolders[0].uri);
                        const fileNames = files.map(f => f[0]);
                        if (fileNames.includes('pom.xml')) {
                            buildCommand = "mvn clean compile";
                        }
                        else if (fileNames.includes('build.gradle')) {
                            buildCommand = "gradle build -x test";
                        }
                        else if (fileNames.includes('go.mod')) {
                            buildCommand = "go build ./...";
                        }
                        else if (fileNames.includes('requirements.txt')) {
                            buildCommand = "python -m compileall .";
                        }
                        else if (fileNames.includes('tsconfig.json')) {
                            buildCommand = "npx -p typescript tsc --noEmit";
                        }
                        else if (fileNames.includes('package.json')) {
                            buildCommand = "npm run build";
                        }
                        else {
                            buildCommand = "echo 'No standard build file found (e.g., tsconfig.json, pom.xml). Skipping build.'";
                        }
                    }
                    catch (e) {
                        // 🚀 FIX: Do not assume TypeScript if the environment is completely unknown!
                        buildCommand = "echo 'No standard build system detected (e.g., tsconfig.json, pom.xml). Skipping global compilation.'";
                    }
                    const result = await this._terminalManager?.runCommandWithCapture(buildCommand, workspacePath);
                    if (result && result.success) {
                        vscode.window.showInformationMessage((0, i18n_1.t)("build_healer.compiler_passed"));
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    else if (result && !result.success) {
                        vscode.window.showErrorMessage((0, i18n_1.t)("build_healer.compiler_failed"));
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing global build failures..." });
                        try {
                            // 1. Extract broken file paths from the TypeScript error log
                            // e.g. "src/models/user.ts(5,10): error TS2304..." -> "src/models/user.ts"
                            const fileRegex = /([a-zA-Z0-9_\-\/\\]+\.(?:ts|tsx|js|jsx|py|go|rs|cpp|c|h|hpp|java|rb|php|cs))/g;
                            const matches = [...new Set(result.output.match(fileRegex))]; // Get unique files
                            if (matches.length === 0) {
                                throw new Error("Could not parse file paths from error log.");
                            }
                            // 2. Read the contents of the broken files
                            let brokenFilesContext = "";
                            for (const file of matches) {
                                try {
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, file);
                                    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
                                    brokenFilesContext += `\n--- FILE: ${file} ---\n\`\`\`\n${content}\n\`\`\`\n`;
                                }
                                catch (e) {
                                    // File might be a phantom import that doesn't exist yet
                                }
                            }
                            // 3. Call the Build-Healer Agent
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Healing ${matches.length} cross-file errors...` });
                            const fixes = await (0, llmService_1.healGlobalBuild)(result.output, brokenFilesContext, data.codingStyle || 'precise');
                            // 4. Apply the Autonomous Edits
                            if (fixes && fixes.length > 0) {
                                const workspaceEdit = new vscode.WorkspaceEdit();
                                for (const edit of fixes) {
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filepath);
                                    // Ensure file exists
                                    try {
                                        await vscode.workspace.fs.stat(fileUri);
                                    }
                                    catch {
                                        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                    }
                                    const document = await vscode.workspace.openTextDocument(fileUri);
                                    const aiHeader = (0, commentStyles_1.getAIHeader)(edit.filepath, "Build-Healer Patch");
                                    const finalCode = aiHeader + edit.code;
                                    workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), finalCode);
                                }
                                if (await vscode.workspace.applyEdit(workspaceEdit)) {
                                    // Save all dirty documents so TS can see the updates
                                    const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                                    for (const doc of dirtyDocs) {
                                        await doc.save();
                                    }
                                    vscode.window.showInformationMessage(`✅ Build-Healer autonomously patched ${fixes.length} files!`);
                                }
                            }
                            else {
                                vscode.window.showWarningMessage((0, i18n_1.t)("build_healer.no_safe_patch"));
                            }
                        }
                        catch (error) {
                            logger_1.log.error("[DEBUG-HEALER]", error);
                            //  THE FIX: Expose the actual error and the raw terminal output so the developer can see why it failed!
                            const safeError = (0, errors_1.errorMessage)(error);
                            vscode.window.showErrorMessage(`Build-Healer Aborted: ${safeError}`);
                            this._view?.webview.postMessage({
                                type: 'statusUpdate',
                                message: `⚠️ Healer failed to parse terminal. Check VS Code notifications.`
                            });
                            // Stream the raw terminal output to the chat so you can physically read what tsc complained about!
                            this._view?.webview.postMessage({
                                type: 'streamTerminal',
                                task: "Global Compiler",
                                text: result.output || "No terminal output captured."
                            });
                        }
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    break;
                }
                case "searchFiles": {
                    // Split off the line numbers so the file search doesn't break const cleanQuery = data.query.split(':')[0];
                    const cleanQuery = data.query.split(':')[0];
                    const files = await vscode.workspace.findFiles(`**/*${cleanQuery}*`, '{**/node_modules/**,**/.git/**,**/dist/**}', 10);
                    const results = files.map(f => vscode.workspace.asRelativePath(f));
                    // Send results back, but preserve the original query so the UI remembers the line numbers!
                    this._view?.webview.postMessage({ type: 'searchResults', results, originalQuery: data.query });
                    break;
                }
                case "showDiff": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const fileUri = vscode.Uri.joinPath(rootUri, data.filepath);
                    const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);
                    await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, `NexusCode Diff: ${path.basename(data.filepath)}`);
                    break;
                }
                case "openFile": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    //  THE FIX: Safely handle Windows absolute paths vs relative paths!
                    const fullPath = path.isAbsolute(data.filepath)
                        ? data.filepath
                        : path.join(rootUri.fsPath, data.filepath);
                    const fileUri = vscode.Uri.file(fullPath);
                    try {
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        const editor = await vscode.window.showTextDocument(document, { preview: false });
                        // Jump to the exact function if clicked!
                        if (data.symbol) {
                            const text = document.getText();
                            const symbolIdx = text.indexOf(data.symbol);
                            if (symbolIdx !== -1) {
                                const pos = document.positionAt(symbolIdx);
                                editor.selection = new vscode.Selection(pos, pos);
                                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                            }
                        }
                    }
                    catch (e) {
                        vscode.window.showErrorMessage(`NexusCode: Could not open ${fileUri.fsPath}`);
                    }
                    break;
                }
                case "readFileContext": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    // Parse the target file and optional line ranges (e.g., "src/App.tsx:10-50")
                    let targetFile = data.file;
                    let startLine = 0;
                    let endLine = Infinity;
                    const match = targetFile.match(/(.*?):(\d+)(?:-(\d+))?$/);
                    if (match) {
                        targetFile = match[1];
                        startLine = Math.max(0, parseInt(match[2], 10) - 1); // 0-indexed
                        if (match[3]) {
                            endLine = parseInt(match[3], 10);
                        }
                        else {
                            endLine = startLine + 100;
                        }
                    }
                    const fileUri = vscode.Uri.joinPath(this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri, targetFile);
                    try {
                        const content = await vscode.workspace.fs.readFile(fileUri);
                        let code = new TextDecoder().decode(content);
                        // ✂️ Slice the file if line numbers were provided!
                        if (startLine > 0 || endLine !== Infinity) {
                            const lines = code.split('\n');
                            code = lines.slice(startLine, endLine).join('\n');
                            code = `// [PARTIAL FILE READ: Lines ${startLine + 1} to ${Math.min(endLine, lines.length)}]\n` + code;
                        }
                        const ext = path.extname(targetFile).substring(1);
                        this._view?.webview.postMessage({
                            type: 'addContext',
                            file: data.file, // Keep the syntax (e.g., App.tsx:10-50) for the UI chip
                            code: code,
                            language: ext || 'text'
                        });
                    }
                    catch (e) {
                        logger_1.log.error("Failed to read file for context:", e);
                    }
                    break;
                }
                case "executeAllTasks": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode: Drafting Atomic Plan...",
                        cancellable: true
                    }, async (progress, token) => {
                        try {
                            const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                            const projectContext = await (0, projectContext_1.getProjectContext)(contextRoot);
                            const allEdits = [];
                            const BATCH_SIZE = 5;
                            for (let i = 0; i < data.tasks.length; i += BATCH_SIZE) {
                                if (token.isCancellationRequested) {
                                    break;
                                }
                                const batch = data.tasks.slice(i, i + BATCH_SIZE);
                                const batchNum = Math.ceil((i + 1) / BATCH_SIZE);
                                const totalBatches = Math.ceil(data.tasks.length / BATCH_SIZE);
                                progress.report({ message: `Drafting batch ${batchNum}/${totalBatches}...` });
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: `Drafting batch ${batchNum}/${totalBatches}: ${batch[0]}...` });
                                try {
                                    const batchEdits = await (0, llmService_1.generateAtomicEdits)(batch, projectContext, data.codingStyle);
                                    allEdits.push(...batchEdits);
                                }
                                catch (e) { }
                            }
                            if (token.isCancellationRequested) {
                                return;
                            }
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Compiling Final Review..." });
                            this._view?.webview.postMessage({ type: 'reviewEdits', edits: allEdits, tasks: data.tasks });
                            vscode.window.showInformationMessage(`Draft complete. Generated code for ${allEdits.length} files.`);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                        catch (error) {
                            vscode.window.showErrorMessage(`Drafting Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                    });
                    break;
                }
                case "commitAtomicEdits": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders || !data.edits) {
                        return;
                    }
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode: Committing Changes...",
                        cancellable: false
                    }, async () => {
                        const workspaceEdit = new vscode.WorkspaceEdit();
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        for (const edit of data.edits) {
                            const fileUri = vscode.Uri.joinPath(rootUri, edit.filepath);
                            const aiHeader = (0, commentStyles_1.getAIHeader)(edit.filepath, "Atomic Implementation");
                            const finalCode = aiHeader + edit.code;
                            try {
                                await vscode.workspace.fs.stat(fileUri);
                            }
                            catch {
                                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                            }
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), finalCode);
                        }
                        if (await vscode.workspace.applyEdit(workspaceEdit)) {
                            const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                            for (const doc of dirtyDocs) {
                                await doc.save();
                            }
                            this._view?.webview.postMessage({ type: 'allTasksCompleted', status: 'approved' });
                            vscode.window.showInformationMessage((0, i18n_1.t)("transactions.atomic_committed"));
                        }
                    });
                    break;
                }
                case "generateAndRunTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const activeEditor = vscode.window.activeTextEditor;
                    if (!workspaceFolders || !activeEditor) {
                        return;
                    }
                    const workspacePath = workspaceFolders[0].uri.fsPath;
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode is writing and executing tests...",
                        cancellable: false
                    }, async () => {
                        try {
                            this._view?.webview.postMessage({ type: 'clearTerminalStream', task: "Auto-Test Setup" });
                            this._view?.webview.postMessage({ type: 'clearTerminalStream', task: "Auto-Test Execution" });
                            const relativeFileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                            const customRules = (await new SpecManager_1.SpecManager(workspaceFolders[0].uri).readSteering()).combined;
                            const testPlan = await (0, llmService_1.generateTests)(relativeFileName, activeEditor.document.getText(), customRules);
                            if (activeEditor.document.isDirty) {
                                await activeEditor.document.save();
                            }
                            if (testPlan.installCommand) {
                                const installResult = await this.confirmAndRunCommand(testPlan.installCommand, workspacePath, 'Installing dependencies...', data.autopilot, 
                                //  THE UI STREAMER: Send the live npm install text to the chat window!
                                (chunk) => {
                                    this._view?.webview.postMessage({ type: 'streamTerminal', task: "Auto-Test Setup", text: chunk });
                                });
                                if (!installResult || !installResult.success) {
                                    vscode.window.showErrorMessage((0, i18n_1.t)("tests.dependency_install_failed"));
                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: '⚠️ Tests aborted due to install failure.' });
                                    return;
                                }
                            }
                            const parsedPath = path.parse(relativeFileName);
                            // Strip "src/" from the folder path if it exists so we don't end up with "tests/src/..."
                            let cleanDir = parsedPath.dir;
                            if (cleanDir.startsWith('src/') || cleanDir === 'src') {
                                cleanDir = cleanDir.replace(/^src\/?/, '');
                            }
                            // 🚀 POLYGLOT TEST NAMING: Adapt to exact language conventions
                            let testFileName = `${parsedPath.name}.test${parsedPath.ext}`; // Default JS/TS/General
                            if (parsedPath.ext === '.go') {
                                testFileName = `${parsedPath.name}_test.go`;
                            }
                            else if (parsedPath.ext === '.py') {
                                testFileName = `test_${parsedPath.name}.py`;
                            }
                            else if (parsedPath.ext === '.rs') {
                                testFileName = `${parsedPath.name}_test.rs`;
                            }
                            else if (parsedPath.ext === '.java') {
                                testFileName = `${parsedPath.name.charAt(0).toUpperCase() + parsedPath.name.slice(1)}Test.java`;
                            }
                            else if (parsedPath.ext === '.rb') {
                                testFileName = `test_${parsedPath.name}.rb`;
                            }
                            // Hardcode the route to the root 'tests/' directory
                            const deterministicPath = path.join('tests', cleanDir, testFileName);
                            const testFileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, deterministicPath);
                            const createEdit = new vscode.WorkspaceEdit();
                            createEdit.createFile(testFileUri, { ignoreIfExists: true });
                            await vscode.workspace.applyEdit(createEdit);
                            const doc = await vscode.workspace.openTextDocument(testFileUri);
                            const replaceEdit = new vscode.WorkspaceEdit();
                            // Overwrite from line 0 to the very end of the file
                            replaceEdit.replace(testFileUri, new vscode.Range(0, 0, doc.lineCount, 0), testPlan.code);
                            await vscode.workspace.applyEdit(replaceEdit);
                            await vscode.window.showTextDocument(doc);
                            await doc.save();
                            const result = await this.confirmAndRunCommand(testPlan.testCommand, workspacePath, 'Running tests...', data.autopilot, 
                            //  THE UI STREAMER: Send the live test results to the chat window!
                            (chunk) => {
                                this._view?.webview.postMessage({ type: 'streamTerminal', task: "Auto-Test Execution", text: chunk });
                            });
                            if (!result) {
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });
                                return;
                            }
                            if (!result.success) {
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Tests failed. Auto-healing...' });
                                try {
                                    const fixResult = await (0, llmService_1.healError)(result.output, relativeFileName, activeEditor.document.getText(), deterministicPath, testPlan.code);
                                    const fileToFixUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fixResult.filepath);
                                    const fixEdit = new vscode.WorkspaceEdit();
                                    const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                                    fixEdit.replace(fileToFixUri, new vscode.Range(0, 0, docToFix.lineCount, 0), fixResult.code);
                                    await vscode.workspace.applyEdit(fixEdit);
                                    await docToFix.save();
                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Re-running tests after heal...' });
                                    const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);
                                    if (retryResult?.success) {
                                        vscode.window.showInformationMessage(`Auto-Heal successful! Fixed ${fixResult.filepath}`);
                                    }
                                    else {
                                        vscode.window.showErrorMessage((0, i18n_1.t)("tests.auto_heal_still_failing"));
                                    }
                                }
                                catch (e) {
                                    vscode.window.showErrorMessage((0, i18n_1.t)("tests.auto_heal_parse_failed"));
                                }
                            }
                            else {
                                vscode.window.showInformationMessage((0, i18n_1.t)("tests.all_passed"));
                            }
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });
                        }
                        catch (error) {
                            vscode.window.showErrorMessage((0, i18n_1.t)("tests.generation_failed"));
                        }
                    });
                    break;
                }
                case "executeCommand": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    const workspacePath = workspaceFolders[0].uri.fsPath;
                    const maxRetries = 3;
                    let currentAttempt = 1;
                    let success = false;
                    this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing' });
                    while (currentAttempt <= maxRetries && !success) {
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Running \`${data.command}\` (Attempt ${currentAttempt}/${maxRetries})...` });
                        // 1. Run the headless terminal and stream to the UI
                        const result = await this._terminalManager?.runCommandWithCapture(data.command, workspacePath, (chunk) => {
                            // Stream the live terminal output to the React UI!
                            this._view?.webview.postMessage({ type: 'streamTerminal', task: data.task, text: chunk });
                        });
                        if (!result) {
                            break;
                        }
                        if (result.success) {
                            success = true;
                            this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'approved', summary: `✅ Command executed flawlessly.` });
                            break;
                        }
                        // 2. INTERCEPTOR TRIGGERED: Command Failed!
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: `🚨 Command Failed. Intercepting Error for Auto-Heal...` });
                        this._view?.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'error', description: `Execution Failed (Code ${result.code})`, details: result.output.substring(0, 1000) });
                        if (currentAttempt === maxRetries) {
                            this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: `❌ Failed after ${maxRetries} attempts.` });
                            break;
                        }
                        // 3. The Auto-Heal LLM Call
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Architecting fix for terminal error...` });
                        try {
                            const { healGlobalBuild } = await import('./llmService.js');
                            // We pass the exact terminal error back to the AI
                            const fixes = await healGlobalBuild(result.output, "Fix the terminal crash.", data.codingStyle);
                            if (fixes && fixes.length > 0) {
                                const workspaceEdit = new vscode.WorkspaceEdit();
                                for (const edit of fixes) {
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filepath);
                                    const document = await vscode.workspace.openTextDocument(fileUri);
                                    workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), edit.code);
                                }
                                await vscode.workspace.applyEdit(workspaceEdit);
                                // Save files so the next terminal run sees the changes!
                                const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                                for (const doc of dirtyDocs) {
                                    await doc.save();
                                }
                                this._view?.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'heal', description: `Auto-Heal Applied to ${fixes.length} files.` });
                            }
                            else {
                                throw new Error("AI could not determine a safe patch.");
                            }
                        }
                        catch (e) {
                            this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: `❌ Auto-heal failed: ${e instanceof Error ? e.message : 'Unknown'}` });
                            break;
                        }
                        currentAttempt++;
                    }
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    break;
                }
                case "requestModels": {
                    const models = await (0, llmService_1.getAvailableModels)();
                    const currentModel = vscode.workspace.getConfiguration('nexuscode').get('model');
                    this._view?.webview.postMessage({
                        type: 'updateModelsList',
                        models: models,
                        currentModel: currentModel
                    });
                    break;
                }
                case "setModel": {
                    await vscode.workspace.getConfiguration('nexuscode').update('model', data.value, vscode.ConfigurationTarget.Global);
                    vscode.window.setStatusBarMessage(`NexusCode: Model set to ${data.value}`, 3000);
                    break;
                }
                case "setThinkingMode": {
                    // Inline thinking-mode toggle. Payload is
                    // { planner?: boolean, coder?: boolean, verifier?: boolean }.
                    // Each present key is written to the matching VS Code
                    // config; absent keys are unchanged. The inline UI
                    // currently sends all three as a bulk toggle, but
                    // the API supports per-agent updates so a future
                    // power-user UI (or an admin portal) can drive
                    // single-agent changes through the same path.
                    const cfg = vscode.workspace.getConfiguration('nexuscode');
                    const target = vscode.ConfigurationTarget.Global;
                    if (typeof data.planner === 'boolean') {
                        await cfg.update('thinkingPlanner', data.planner, target);
                    }
                    if (typeof data.coder === 'boolean') {
                        await cfg.update('thinkingCoder', data.coder, target);
                    }
                    if (typeof data.verifier === 'boolean') {
                        await cfg.update('thinkingVerifier', data.verifier, target);
                    }
                    // Echo the new state back so the webview can confirm
                    // (and any concurrently-open second webview can sync).
                    const newCfg = vscode.workspace.getConfiguration('nexuscode');
                    this._view?.webview.postMessage({
                        type: 'thinkingModeChanged',
                        mode: {
                            planner: newCfg.get('thinkingPlanner') ?? true,
                            coder: newCfg.get('thinkingCoder') ?? true,
                            verifier: newCfg.get('thinkingVerifier') ?? true,
                        },
                    });
                    break;
                }
                case "openThinkingSettings": {
                    // Inline "Advanced" link → opens VS Code settings
                    // filtered to the per-agent thinking keys. Lets
                    // power users customize per-agent without us
                    // building inline UI for it.
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'nexuscode.thinking');
                    break;
                }
                case "requestScaffoldDecision": {
                    // V2.1.1 — entry point for the greenfield-scaffolding
                    // confirmation flow. Webview calls this when the
                    // user submits a chat prompt; we:
                    //   1. List top-level workspace files (cheap)
                    //   2. Run pure greenfield detection
                    //   3. Discover available templates (workspace
                    //      .nexus/scaffolds/ + extension built-ins)
                    //   4. Send results back as scaffoldDecisionAvailable
                    //
                    // The webview's dialog uses the result to either
                    // (a) skip — proceed straight to generateRequirements,
                    // or (b) show the stack picker — let user choose
                    // template, then proceed with scaffolding-aware
                    // request flow (V2.1.3 adds the planner integration).
                    //
                    // V2.1.1 ships ONLY the decision plumbing; the
                    // actual scaffold-apply (file copy) and planner
                    // adjustment ship in V2.1.2 / V2.1.3.
                    try {
                        const userPrompt = typeof data.prompt === 'string' ? data.prompt : '';
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
                        // Inventory: top-level filenames + total count.
                        // We bound the recursion + count to avoid stalling
                        // on huge workspaces — the detector only needs
                        // to know "are there many files" at the top.
                        let topLevelFilenames = [];
                        let totalFileCount = 0;
                        if (workspaceRoot) {
                            try {
                                const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(workspaceRoot));
                                topLevelFilenames = entries
                                    .filter(([_, kind]) => kind === vscode.FileType.File)
                                    .map(([name]) => name);
                                // Count files up to a cap of 100; past
                                // that we know it's a real project. We
                                // recurse 1 level deep into top-level
                                // dirs (excluding common ignored ones)
                                // to catch projects where the marker
                                // is in a subdir (rare but possible).
                                totalFileCount = topLevelFilenames.length;
                                const COUNT_CAP = 100;
                                const SKIP_DIRS = new Set([
                                    'node_modules', '.git', '.nexus', 'dist',
                                    'build', 'out', '__pycache__', '.venv',
                                    'venv', 'target', '.next', '.gradle',
                                ]);
                                for (const [name, kind] of entries) {
                                    if (totalFileCount >= COUNT_CAP) {
                                        break;
                                    }
                                    if (kind !== vscode.FileType.Directory) {
                                        continue;
                                    }
                                    if (SKIP_DIRS.has(name)) {
                                        continue;
                                    }
                                    try {
                                        const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(workspaceRoot, name)));
                                        totalFileCount += sub.filter(([_, k]) => k === vscode.FileType.File).length;
                                    }
                                    catch {
                                        // Subdir read failed (permission,
                                        // race) — treat as 0 contribution.
                                    }
                                }
                            }
                            catch (e) {
                                logger_1.log.warn(`[Scaffold] Could not list workspace: ${(0, errors_1.errorMessage)(e)}`);
                            }
                        }
                        const detection = (0, greenfieldDetector_1.detectGreenfield)({
                            prompt: userPrompt,
                            topLevelFilenames,
                            totalFileCount,
                        });
                        const templates = (0, templateLoader_1.discoverTemplates)(workspaceRoot, this._extensionUri.fsPath);
                        this._view?.webview.postMessage({
                            type: 'scaffoldDecisionAvailable',
                            detection: {
                                isGreenfield: detection.isGreenfield,
                                confidence: detection.confidence,
                                stackHint: detection.stackHint,
                            },
                            templates: templates.map(t => ({
                                id: t.id,
                                displayName: t.displayName,
                                description: t.description,
                                stackTags: t.stackTags,
                                source: t.source,
                            })),
                        });
                    }
                    catch (e) {
                        logger_1.log.error(`[Scaffold] requestScaffoldDecision failed: ${(0, errors_1.errorMessage)(e)}`);
                        // Don't leave the webview waiting — send an
                        // empty decision so the dialog can fail open
                        // (i.e., proceed without scaffolding).
                        this._view?.webview.postMessage({
                            type: 'scaffoldDecisionAvailable',
                            detection: { isGreenfield: false, confidence: 'low' },
                            templates: [],
                        });
                    }
                    break;
                }
                case "scaffoldDecisionMade": {
                    // V2.1.2b — webview reports the user's choice.
                    // Three possible actions:
                    //   'skip'    user picked "skip scaffolding" — no fs effect
                    //   'cancel'  user dismissed the dialog (treated as skip)
                    //   'apply'   user picked a template; we apply it now
                    //
                    // For 'apply', we re-discover templates (the cached
                    // list from requestScaffoldDecision could be stale if
                    // the user added a workspace template between dialog
                    // open and confirm), then call applyTemplate. Errors
                    // surface in the acknowledgment so the dialog can
                    // show a meaningful message rather than silently
                    // failing.
                    const action = typeof data.action === 'string' ? data.action : 'skip';
                    const templateId = typeof data.templateId === 'string' ? data.templateId : null;
                    let applyError = null;
                    let applyResult = null;
                    if (action === 'apply' && templateId) {
                        try {
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
                            if (!workspaceRoot) {
                                applyError = 'No workspace folder open — cannot scaffold.';
                            }
                            else {
                                const templates = (0, templateLoader_1.discoverTemplates)(workspaceRoot, this._extensionUri.fsPath);
                                const tpl = templates.find(t => t.id === templateId);
                                if (!tpl) {
                                    applyError = `Template "${templateId}" not found.`;
                                }
                                else {
                                    const result = (0, scaffoldApplier_1.applyTemplate)(tpl, workspaceRoot, nodeFsAdapter_1.nodeFsAdapter);
                                    applyResult = {
                                        written: result.written.length,
                                        skipped: result.skipped.length,
                                    };
                                    logger_1.log.info(`[Scaffold] Applied ${tpl.id}: ` +
                                        `${result.written.length} written, ` +
                                        `${result.skipped.length} skipped`);
                                }
                            }
                        }
                        catch (e) {
                            applyError = (0, errors_1.errorMessage)(e);
                            logger_1.log.error(`[Scaffold] Apply failed for ${templateId}: ${applyError}`);
                        }
                    }
                    else {
                        logger_1.log.info(`[Scaffold] User decision: action=${action}`);
                    }
                    // Echo back so the webview can release its waiting
                    // state and either surface the error or proceed
                    // with the original chat prompt.
                    const ackPayload = {
                        type: 'scaffoldDecisionAcknowledged',
                        action,
                        templateId,
                        applyError,
                        applyResult,
                    };
                    this._view?.webview.postMessage(ackPayload);
                    break;
                }
                case "approveCommand": {
                    if (this._pendingCommandResolver) {
                        this._pendingCommandResolver(true);
                    }
                    break;
                }
                case "rejectCommand": {
                    if (this._pendingCommandResolver) {
                        this._pendingCommandResolver(false);
                    }
                    break;
                }
                // V2.1.2 spec-fix-12 — Bug #1: per-call approval responses
                // for write_file / edit_file. Distinct from approveCommand
                // (which is for bash) because multiple file-write
                // approvals can be pending concurrently — keyed by callId.
                case "approveToolCall": {
                    const callId = String(data.callId ?? '');
                    const resolver = this._pendingApprovalResolvers.get(callId);
                    if (resolver) {
                        resolver(true);
                    }
                    break;
                }
                case "rejectToolCall": {
                    const callId = String(data.callId ?? '');
                    const resolver = this._pendingApprovalResolvers.get(callId);
                    if (resolver) {
                        resolver(false);
                    }
                    break;
                }
                case "generateProjectTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        return;
                    }
                    const rootUri = workspaceFolders[0].uri;
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Nexus: Architecting Master Project TDD Suite...`,
                        cancellable: false
                    }, async (progress) => {
                        try {
                            const env = new VSCodeEnvironment_1.VSCodeEnvironment();
                            // 🚀 Gather the ENTIRE codebase context using our existing Explorer tooling
                            const projectContext = await (0, projectContext_1.getProjectContext)(rootUri.fsPath);
                            // Run the Global Two-Phase Test Agent
                            const testResult = await (0, testAgent_1.runProjectTestAgent)(env, this._activeRequirements, projectContext, rootUri.fsPath, (msg) => progress.report({ message: msg }));
                            if (testResult) {
                                // Pop open the Master Markdown Plan on the left
                                const planUri = vscode.Uri.joinPath(rootUri, testResult.testPlanFilepath);
                                const planDoc = await vscode.workspace.openTextDocument(planUri);
                                await vscode.window.showTextDocument(planDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
                                // Pop open the Master Jest Code on the right
                                const testUri = vscode.Uri.joinPath(rootUri, testResult.filepath);
                                const testDoc = await vscode.workspace.openTextDocument(testUri);
                                await vscode.window.showTextDocument(testDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });
                                vscode.window.showInformationMessage(`✅ Master TDD Suite generated in .nexus/specs/main/`);
                            }
                            else {
                                vscode.window.showErrorMessage(`Failed to generate master TDD suite.`);
                            }
                        }
                        catch (error) {
                            vscode.window.showErrorMessage(`TDD Generation Error: ${(0, errors_1.errorMessage)(error)}`);
                        }
                    });
                    break;
                }
                // PR 3.2: hooks panel messages. The HookManager owns
                // hook state on the host; we just delegate. Updates flow
                // back through the subscription wired in resolveWebviewView.
                case "requestHookList": {
                    try {
                        const hm = HookManager_1.HookManager.getInstance();
                        const summaries = hm.getHookSummaries();
                        this._view?.webview.postMessage({
                            type: 'hookListUpdated',
                            hooks: summaries
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('requestHookList failed:', e);
                    }
                    break;
                }
                case "toggleHook": {
                    const id = data.id;
                    const enabled = data.enabled;
                    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
                        break;
                    }
                    try {
                        await HookManager_1.HookManager.getInstance().toggleHook(id, enabled);
                    }
                    catch (e) {
                        logger_1.log.warn('toggleHook failed:', e);
                    }
                    break;
                }
                case "runHook": {
                    const id = data.id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await HookManager_1.HookManager.getInstance().runHookManually(id);
                    }
                    catch (e) {
                        logger_1.log.warn('runHook failed:', e);
                    }
                    break;
                }
                case "openHookFile": {
                    const id = data.id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await HookManager_1.HookManager.getInstance().openHookFile(id);
                    }
                    catch (e) {
                        logger_1.log.warn('openHookFile failed:', e);
                    }
                    break;
                }
                // PR 3.3: steering rules panel messages. Delegate to
                // SteeringManager. Updates round-trip via the
                // subscription wired in resolveWebviewView.
                case "requestSteeringList": {
                    try {
                        const sm = SteeringManager_1.SteeringManager.getInstance();
                        const summaries = await sm.getSteeringSummaries();
                        this._view?.webview.postMessage({
                            type: 'steeringListUpdated',
                            items: summaries
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('requestSteeringList failed:', e);
                    }
                    break;
                }
                case "createSteeringFile": {
                    const id = data.id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await SteeringManager_1.SteeringManager.getInstance().ensureSteeringFile(id);
                    }
                    catch (e) {
                        logger_1.log.warn('createSteeringFile failed:', e);
                    }
                    break;
                }
                case "openSteeringFile": {
                    const id = data.id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await SteeringManager_1.SteeringManager.getInstance().openSteeringFile(id);
                    }
                    catch (e) {
                        logger_1.log.warn('openSteeringFile failed:', e);
                    }
                    break;
                }
                case "requestMcpStatus": {
                    // P2.1: webview asks for the current snapshot — used
                    // when the panel is opened/remounted. The subscription
                    // also delivers initial state synchronously, but a
                    // remount can happen without re-subscribing (e.g. tab
                    // switch in the webview), so this message gives the
                    // panel a way to refetch on demand.
                    try {
                        const mgr = mcpManager_1.McpManager.getInstance();
                        this._view?.webview.postMessage({
                            type: 'mcpStatusUpdated',
                            servers: mgr.getServerViews(),
                            configError: mgr.getConfigError()
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('requestMcpStatus failed:', e);
                    }
                    break;
                }
                case "mcpReload": {
                    // P2.1: user clicked "Reload config" in the MCP
                    // panel. Forces a re-read of .nexus/mcp-servers.json
                    // and a diff against current state. Subscribers are
                    // notified by the manager itself, so we don't need
                    // to post here.
                    try {
                        await mcpManager_1.McpManager.getInstance().reloadConfig();
                    }
                    catch (e) {
                        logger_1.log.warn('mcpReload failed:', e);
                    }
                    break;
                }
                case "requestSessionList": {
                    // P3.1 panel: webview asks for the list of known
                    // audit sessions. This drives the session-picker
                    // dropdown in the diagnostics panel. We read all
                    // historical records via audit.readRecords() —
                    // bounded by date range if the panel asks for it.
                    try {
                        const audit = (0, container_1.getDeps)().audit;
                        const records = await audit.readRecords();
                        const sessions = (0, sessionDiagnostics_1.listSessions)(records);
                        this._view?.webview.postMessage({
                            type: 'sessionListUpdated',
                            sessions
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('requestSessionList failed:', e);
                        // Send an empty list on error so the UI can
                        // distinguish "loading" from "no sessions"
                        this._view?.webview.postMessage({
                            type: 'sessionListUpdated',
                            sessions: []
                        });
                    }
                    break;
                }
                case "requestSessionBundle": {
                    // P3.1 panel: webview asks for the full diagnostic
                    // bundle for a specific session. The bundle is the
                    // data side of the support-ticket export — same
                    // shape returned, panel renders + offers download.
                    const sessionId = data.sessionId;
                    if (typeof sessionId !== 'string') {
                        break;
                    }
                    try {
                        const audit = (0, container_1.getDeps)().audit;
                        const records = await audit.readRecords();
                        const summary = (0, sessionDiagnostics_1.summarizeSession)(records, sessionId);
                        const timeline = (0, sessionDiagnostics_1.buildTimeline)(records, { sessionId });
                        const breakdown = (0, sessionDiagnostics_1.computeTokenBreakdown)(records, sessionId);
                        const bundle = (0, sessionDiagnostics_1.buildSessionBundle)(records, sessionId);
                        this._view?.webview.postMessage({
                            type: 'sessionBundleUpdated',
                            sessionId,
                            summary,
                            timeline,
                            breakdown,
                            bundle
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('requestSessionBundle failed:', e);
                        this._view?.webview.postMessage({
                            type: 'sessionBundleUpdated',
                            sessionId,
                            summary: null,
                            timeline: [],
                            breakdown: null,
                            bundle: null,
                            error: e instanceof Error ? e.message : String(e)
                        });
                    }
                    break;
                }
                case "requestStartupTiming": {
                    // P3.2 panel: webview asks for the host-side
                    // activation phase marks. Cheap operation — just
                    // copies the in-process buffer.
                    try {
                        this._view?.webview.postMessage({
                            type: 'startupTimingUpdated',
                            marks: (0, startupTiming_1.getMarks)(),
                            relative: (0, startupTiming_1.getMarksRelative)()
                        });
                    }
                    catch (e) {
                        logger_1.log.warn('requestStartupTiming failed:', e);
                    }
                    break;
                }
            }
        });
    }
    _getHtmlForWebview(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "static", "js", "main.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "static", "css", "style.css"));
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; connect-src ${webview.cspSource} http: https:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>NexusCode</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=SidebarProvider.js.map