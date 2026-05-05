// src/SidebarProvider.ts
import * as vscode from "vscode";
import * as path from 'path';
import { getDeps } from './container';
import { originalContentProvider } from './diffProvider';
import { getSmartASTContext, getGraphJSON, buildWorkspaceGraph } from './context/codeGraph';
import { runTask } from './agents/Coordinator';
import { PlannerAgent } from './agents/PlannerAgent';
import { ToolEventEmitter } from './agents/toolEventEmitter';
import { HookEventEmitter } from './hooks/hookEventEmitter';
import { ToolAuditCorrelator } from './audit/toolAuditCorrelator';
import { SpecManager, type Phase } from './specs/SpecManager';
// PR 3.2: hooks panel messages route through HookManager.
import { HookManager } from './hooks/HookManager';
// PR 3.3: steering rules panel messages route through SteeringManager.
import { SteeringManager } from './specs/SteeringManager';
import { McpManager } from './mcp/mcpManager';
import { VSCodeEnvironment } from './adapters/VSCodeEnvironment';
// V2.1.1 — project scaffolder. detectGreenfield is pure heuristic
// (workspace shape + prompt), discoverTemplates lists workspace
// .nexus/scaffolds/ and extension built-in scaffolds/. Used by the
// requestScaffoldDecision case to populate the webview confirmation
// dialog. V2.1.2 / V2.1.3 will add the apply path.
import { detectGreenfield } from './scaffold/greenfieldDetector';
import { discoverTemplates } from './scaffold/templateLoader';
import {
    listSessions,
    buildSessionBundle,
    summarizeSession,
    buildTimeline,
    computeTokenBreakdown,
} from './audit/sessionDiagnostics';
import { getMarks, getMarksRelative } from './diagnostics/startupTiming';
import { runProjectTestAgent } from './agents/testAgent';
import { errorMessage, isAbortError } from './utilities/errors';
import { applyBlock } from './utilities/searchReplace';
import { t } from './i18n';
import { log } from './logger';

// AI Services & Tools
import {
    generatePlan,
    healError,
    generateTests,
    generateAtomicEdits,
    AtomicEdit,
    getAvailableModels,
    determineIntent,
    streamChat,
    generateRequirements,
    generateDesign,
    generateTasks,
    verifyAgainstSpec,
    updateLivingPRD,
    healGlobalBuild,
    askSecurityMonitor,
    compactConversationHistory,
    generateMCTSApproaches
} from "./llmService";

// Context Managers
import { getProjectContext } from "./projectContext";
import { getLspContext } from './context/lspContext';
import { getProjectStyleGuides, wrapUntrusted } from './context/styleContext';
import { indexWorkspace } from './context/ragIndexer';
import { retrieveHybridContext } from './context/hybridSearch';

// Utilities
import { getAIHeader } from './utilities/commentStyles';
import { resolveCanonicalPaths } from './utilities/pathUtils';

// Core Managers
import { ProvenanceTracker } from "./provenanceTracker";
import { createWorkspaceStructure } from "./workspaceManager";
import { TerminalManager } from './terminalManager';

/**
 * Apply a SEARCH/REPLACE pair to a file's content.
 *
 * Delegates to the hardened `applyBlock` helper from `utilities/searchReplace`,
 * which provides Tier A (exact) / Tier B (trailing whitespace) / Tier C
 * (leading whitespace tolerance) matching. Falls back to "replace whole file
 * with extracted markdown" when the model emitted no SEARCH/REPLACE block at all.
 */
function applySearchReplace(originalContent: string, searchBlock: string, replaceBlock: string, fullBuffer: string): string {
    const normalizeNL = (str: string) => str.replace(/\r\n/g, '\n');

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
    return applyBlock(originalContent, {
        search: cleanSearch,
        replace: cleanReplace,
        blockOffset: 0
    });
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    public _view?: vscode.WebviewView;
    private _tracker?: ProvenanceTracker;
    private _terminalManager?: TerminalManager;
    private _activeTaskController: AbortController | undefined;
    private _activeRequirements: string = "";
    private _activeDesign: string = "";
    private _isMetaMode: boolean = false;

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
    private _auditUnsubscribe: (() => void) | undefined = undefined;

    /**
     * PR 3.2: disposer for the HookManager list-changes subscription.
     * Same lifecycle as _auditUnsubscribe — per-webview-instance,
     * cleaned up on onDidDispose. Same type-shape rules apply
     * (exactOptionalPropertyTypes).
     */
    private _hooksUnsubscribe: (() => void) | undefined = undefined;

    /**
     * PR 3.3: disposer for the SteeringManager list-changes subscription.
     * Same lifecycle as the audit and hooks subscriptions above.
     */
    private _steeringUnsubscribe: (() => void) | undefined = undefined;

    /**
     * P2.1: disposer for the McpManager status subscription. Same
     * lifecycle as the other manager subscriptions — per-webview-
     * instance, torn down by onDidDispose.
     */
    private _mcpUnsubscribe: (() => void) | undefined = undefined;

    private _undoStack = new Map<string, { filepath: string, originalContent: string }>();
    private _pendingCommandResolver: ((approved: boolean) => void) | undefined;

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
    private _toolEventEmitter?: ToolEventEmitter;
    private _toolAuditCorrelator?: ToolAuditCorrelator;

    /**
     * P1.4: hook lifecycle emitter. Same pattern as the tool emitter.
     * The sink posts `{type: 'hookEvent', event}` to the webview so
     * the React side can render inline hook cards. When no webview
     * is attached the events drop silently — fine for the agent.
     */
    private _hookEventEmitter?: HookEventEmitter;

    /**
     * Get (or lazily construct) the per-session tool event emitter.
     * Public so tests and future callers (Coordinator wire-up in 2B-3c)
     * can attach as event producers. See _toolEventEmitter docstring
     * for behavior on the no-view case.
     */
    public getToolEventEmitter(): ToolEventEmitter {
        if (!this._toolEventEmitter) {
            // D11: audit log integration. The correlator buffers
            // started→completed events and emits one ToolCallPayload
            // per tool invocation via getDeps().audit.logToolCall.
            // Logic lives in src/audit/toolAuditCorrelator.ts so it's
            // testable without vscode mocking.
            this._toolAuditCorrelator = new ToolAuditCorrelator((payload) => {
                // Fire-and-forget. AuditLog handles its own write
                // failures with console.warn — the .catch() here is
                // belt-and-braces in case the helper itself rejects
                // before reaching the queue.
                void getDeps().audit.logToolCall(payload).catch((e: unknown) => {
                    console.warn('[SidebarProvider] audit.logToolCall rejected:', e);
                });
            });

            this._toolEventEmitter = new ToolEventEmitter((event) => {
                // Drop events to webview when no view is attached.
                // Audit logging still runs — headless / CLI runs need
                // audit even though no UI is listening.
                this._view?.webview.postMessage({
                    type: 'toolCallEvent',
                    event
                });

                // Audit correlation. Started events buffer; completed
                // events flush. Output events are ignored.
                this._toolAuditCorrelator!.handleEvent(event);
            });
        }
        return this._toolEventEmitter;
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
    public getHookEventEmitter(): HookEventEmitter {
        if (!this._hookEventEmitter) {
            this._hookEventEmitter = new HookEventEmitter((event) => {
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
            HookManager.getInstance().setEmitter(this._hookEventEmitter);
        }
        return this._hookEventEmitter;
    }

    constructor(private readonly _extensionUri: vscode.Uri) {
    }

    public setTerminalManager(manager: TerminalManager) { this._terminalManager = manager; }
    public setProvenanceTracker(tracker: ProvenanceTracker) { this._tracker = tracker; }

    public sendMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        } else {
            vscode.window.showInformationMessage(t("commands.open_sidebar_first"));
        }
    }

    public injectTerminalTask(prompt: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'injectTerminalTask', task: prompt });
        }
    }

    public toggleMetaMode() {
        this._isMetaMode = !this._isMetaMode;
        const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
        vscode.window.showWarningMessage(t("commands.switched_mode", { mode }));
        this._view?.webview.postMessage({ type: 'metaModeChanged', value: this._isMetaMode });
    }

    private async getTargetContext(): Promise<string> {
        if (this._isMetaMode) { return this._extensionUri.fsPath; }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    }

    /**
     * Returns a SpecManager bound to the active workspace root (or the extension
     * root in meta-mode). Returns null if no workspace is open.
     */
    private specs(): SpecManager | null {
        const folders = vscode.workspace.workspaceFolders;
        if (this._isMetaMode) { return new SpecManager(this._extensionUri); }
        if (!folders || folders.length === 0) { return null; }
        return new SpecManager(folders[0]!.uri); // length > 0 guarded
    }

    private isValidPhase(p: any): p is Phase {
        return p === 'requirements' || p === 'design' || p === 'tasks';
    }

    private async confirmAndRunCommand(
        command: string,
        workspacePath: string,
        progressMessage: string,
        isAutopilot: boolean = false,
        onStream?: (chunk: string) => void
    ): Promise<{ success: boolean, output: string } | undefined> {

        this._view?.webview.postMessage({ type: 'statusUpdate', message: `🛡️ Security Monitor inspecting command...` });
        const isMalicious = await askSecurityMonitor(command);

        if (isMalicious) {
            vscode.window.showErrorMessage(t("security.firewall_blocked", { command }));
            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🚨 Command Blocked by Security Monitor.` });
            return { success: false, output: "SECURITY_BLOCK" };
        }

        if (isAutopilot || this._isMetaMode) {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🤖 Autopilot Executing: ${command}` });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath, onStream);
        }

        // 🔥 THE PROMISE LOCK: Halt Node.js execution until the human clicks Allow or Block!
        const isApproved = await new Promise<boolean>((resolve) => {
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
        } else {
            vscode.window.showInformationMessage(t("commands.command_blocked_by_user"));
            return { success: false, output: "USER_BLOCKED" };
        }
    }

    public async handlePostApproval(uri: vscode.Uri) {
        if (!this._isMetaMode) { return; }

        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) { await document.save(); }

        const filepath = uri.fsPath;

        if (filepath.includes('webview-ui')) {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🎨 Self-Evolution: Rebuilding UI..." });
            const webviewPath = path.join(this._extensionUri.fsPath, 'webview-ui');
            const buildResult = await this._terminalManager?.runCommandWithCapture("npm run build", webviewPath);

            if (buildResult?.success) {
                vscode.window.showInformationMessage(t("ui_evolution.ui_rebuilt"));
                vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
            } else {
                vscode.window.showErrorMessage(t("ui_evolution.ui_build_failed"));
            }
        } else {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🧬 Self-Evolution: Recompiling..." });
            const compileResult = await this._terminalManager?.runCommandWithCapture("npm run compile", this._extensionUri.fsPath);

            if (compileResult?.success) {
                vscode.window.showInformationMessage(t("ui_evolution.evolution_applied"));
            } else {
                vscode.window.showErrorMessage(t("ui_evolution.build_failed"));
            }
        }
        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        vscode.workspace.registerTextDocumentContentProvider('nexus-diff', originalContentProvider);
        this._tracker?.setView(webviewView);
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build")
            ]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

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
            const audit = getDeps().audit;
            this._auditUnsubscribe = audit.subscribe((record) => {
                // Best-effort post. If the webview is mid-teardown the
                // postMessage call may throw; we don't want that to
                // poison subsequent subscribers, so swallow with a warn.
                try {
                    this._view?.webview.postMessage({
                        type: 'auditEntryAppended',
                        record
                    });
                } catch (e: unknown) {
                    console.warn('[SidebarProvider] auditEntryAppended postMessage failed:', e);
                }
            });
        } catch (e: unknown) {
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
            const hm = HookManager.getInstance();
            this._hooksUnsubscribe = hm.subscribeListChanges((summaries) => {
                try {
                    this._view?.webview.postMessage({
                        type: 'hookListUpdated',
                        hooks: summaries
                    });
                } catch (e: unknown) {
                    log.warn('hookListUpdated postMessage failed:', e);
                }
            });
        } catch (e: unknown) {
            log.warn('hooks subscription unavailable:', e);
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
                const sm = SteeringManager.getInstance();
                sm.start(workspaceFolders[0].uri);
                this._steeringUnsubscribe = sm.subscribeListChanges((summaries) => {
                    try {
                        this._view?.webview.postMessage({
                            type: 'steeringListUpdated',
                            items: summaries
                        });
                    } catch (e: unknown) {
                        log.warn('steeringListUpdated postMessage failed:', e);
                    }
                });
            }
        } catch (e: unknown) {
            log.warn('steering subscription unavailable:', e);
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
            this._mcpUnsubscribe = McpManager.getInstance().subscribe((views, error) => {
                try {
                    this._view?.webview.postMessage({
                        type: 'mcpStatusUpdated',
                        servers: views,
                        configError: error
                    });
                } catch (e: unknown) {
                    log.warn('mcpStatusUpdated postMessage failed:', e);
                }
            });
        } catch (e: unknown) {
            log.warn('mcp subscription unavailable:', e);
        }

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {

                //  THE FIX: The Webview Handshake. Loads chat history, PRD, design, tasks, steering rules.
                case "webviewReady": {
                    const chatHistory = getDeps().state.get<any[]>('nexus_chat_history') || [];
                    const taskStatuses = getDeps().state.get<any>('nexus_task_statuses') || {};
                    const taskSummaries = getDeps().state.get<any>('nexus_task_summaries') || {};
                    const taskFiles = getDeps().state.get<any>('nexus_task_files') || {};
                    const hasApiKey = !!(await getDeps().secrets.get('nexuscode_apikey'));

                    let savedReqs = "";
                    let savedDesign = "";
                    let savedTasks: any = null;
                    let savedRules = "";
                    let savedPhaseState: any = null;

                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const rootUri = workspaceFolders[0]!.uri;
                        buildWorkspaceGraph(rootUri).catch(e => log.error("CodeGraph init failed:", e));

                        const specs = this.specs();
                        if (specs) {
                            savedReqs = await specs.readRequirements();
                            savedDesign = await specs.readDesign();
                            savedTasks = await specs.readTasksJson();
                            // Webview UI expects a single `nexusRules` string — feed it the
                            // combined steering content (product + structure + tech).
                            savedRules = (await specs.readSteering()).combined;
                            savedPhaseState = await specs.readPhaseState();

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
                    const thinkingPlanner  = cfg.get<boolean>('thinkingPlanner')  ?? true;
                    const thinkingCoder    = cfg.get<boolean>('thinkingCoder')    ?? true;
                    const thinkingVerifier = cfg.get<boolean>('thinkingVerifier') ?? true;

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
                            planner:  thinkingPlanner,
                            coder:    thinkingCoder,
                            verifier: thinkingVerifier,
                        },
                    });
                    break;
                }

                case "requestWorkspaceGraph": {
                    log.debug("[DEBUG-MAP] 🟢 1. Webview requested workspace graph.");
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        log.debug("[DEBUG-MAP] 🔴 Workspace folders not found.");
                        return;
                    }

                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                    const specs = new SpecManager(rootUri);

                    this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Nexus: Indexing AST Code Map...' });

                    try {
                        log.debug("[DEBUG-MAP] 🟡 2. Fetching raw CodeGraph...");
                        let rawCodeGraph = getGraphJSON();

                        // Force build if empty
                        if (!rawCodeGraph || rawCodeGraph === '{}') {
                            await buildWorkspaceGraph(rootUri);
                            rawCodeGraph = getGraphJSON();
                        }

                        let codeGraph: any = {};
                        if (rawCodeGraph) {
                            try { codeGraph = typeof rawCodeGraph === 'string' ? JSON.parse(rawCodeGraph) : rawCodeGraph; }
                            catch (e) { log.error("[DEBUG-MAP] 🔴 CodeGraph Parse Error:", e instanceof Error ? e.message : String(e)); }
                        }

                        log.debug("[DEBUG-MAP] 🟡 3. Normalizing AST Dictionary...");
                        let normalizedCodeGraph: { nodes: any[], edges: any[] } = { nodes: [], edges: [] };
                        Object.entries(codeGraph).forEach(([filepath, data]: [string, any]) => {
                            if (filepath === 'nodes' || filepath === 'edges') { return; }

                            normalizedCodeGraph.nodes.push({ id: filepath, label: filepath.split('/').pop(), group: 'file' });

                            if (data.imports) {
                                data.imports.forEach((imp: string) => {
                                    const cleanImp = imp.replace(/['"]/g, '').replace('./', '').replace('../', '');
                                    const targetFile = Object.keys(codeGraph).find(k => k.includes(cleanImp));
                                    if (targetFile) {
                                        normalizedCodeGraph.edges.push({ source: filepath, target: targetFile });
                                    }
                                });
                            }
                        });

                        //  THE PROGRESSIVE LOADING INJECTION: Send CodeMap immediately!
                        log.debug("[DEBUG-MAP] 🟢 4. Sending Initial CodeMap to Webview!");
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

                        // Fetch & Parse Requirements (PRD)
                        let reqGraph: any = { nodes: [], edges: [] };
                        try {
                            const { parseRequirementGraph } = await import('./context/traceabilityGraph.js');
                            const reqString = await specs.readRequirements();
                            if (reqString) {
                                reqGraph = await parseRequirementGraph(reqString);
                            }
                        } catch (e) {
                            log.debug("[DEBUG-MAP] 🟡 No requirements.md found or parsing failed:", e instanceof Error ? e.message : String(e));
                        }

                        // Fetch & Parse Architecture (Design)
                        let designGraph: any = { nodes: [], edges: [] };
                        try {
                            const { parseDesignGraph } = await import('./context/traceabilityGraph.js');
                            const designString = await specs.readDesign();
                            if (designString) {
                                designGraph = await parseDesignGraph(designString);
                            }
                        } catch (e) {
                            log.debug("[DEBUG-MAP] 🟡 No design.md found or parsing failed:", e instanceof Error ? e.message : String(e));
                        }

                        let tasksJson = await specs.readTasksJson();

                        // 2. Build the Ultimate Combined Matrix
                        let combinedGraph: any = { nodes: [...normalizedCodeGraph.nodes], edges: [...normalizedCodeGraph.edges] };
                        try {
                            const { buildCombinedGraph } = await import('./context/traceabilityGraph.js');
                            //  THE FIX: This now executes NO MATTER WHAT, successfully merging Code + PRD!
                            combinedGraph = buildCombinedGraph(normalizedCodeGraph, reqGraph, designGraph, tasksJson);
                        } catch (e) {
                            log.debug("[DEBUG-MAP] 🔴 Graph Combining failed:", e instanceof Error ? e.message : String(e));
                        }

                        log.debug("[DEBUG-MAP] 🟢 5. Sending Final Traceability Payload to Webview!");
                        this._view?.webview.postMessage({
                            type: 'workspaceGraphData',
                            data: {
                                codeMap: codeGraph,
                                reqMap: reqGraph,
                                combinedMap: combinedGraph,
                                isGraphLoading: false // Unlocks the UI buttons
                            }
                        });
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });

                    } catch (error) {
                        const safeError = error instanceof Error ? error.message : String(error);
                        log.error("[DEBUG-MAP] 🔴 FATAL GRAPH ERROR:", safeError);

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
                            vscode.window.showInformationMessage(t("steering.rules_saved"));
                        } catch (e) {
                            vscode.window.showErrorMessage(t("steering.save_failed"));
                        }
                    }
                    break;
                }

                case "verifyTask": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }
                    this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'Gathering context to verify your code...' });

                    try {
                        const taskQuery = data.prompt || data.task;
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;

                        // P1.3: load steering exclude patterns so the
                        // graph correlator skips paths the project
                        // says not to read (legacy/, generated/, etc.).
                        // Empty when no steering file declares any —
                        // behavior unchanged for projects without
                        // exclusions.
                        const excludePatterns = await SteeringManager.getInstance().getExcludePatterns();

                        const [astContext, hybridContext] = await Promise.all([
                            getSmartASTContext(taskQuery, { excludePatterns }),
                            retrieveHybridContext(taskQuery, 5, excludePatterns)
                        ]);
                        const fullContext = `${astContext}\n\n${hybridContext}`;

                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'AI QA is checking your work against PRD...' });

                        const verification = await verifyAgainstSpec(
                            taskQuery,
                            wrapUntrusted(this._activeRequirements, '.nexus/specs/main/requirements.md'),
                            fullContext
                        );

                        if (verification.verified) {
                            const specs = new SpecManager(rootUri);
                            // Hotfix (post-2B): the webview now sends `task` as a UI-uniqueness
                            // key (e.g., "task-3") instead of the human-readable title.
                            // markTaskCompleted matches against the title in tasks.md, so we
                            // accept `data.taskTitle` if provided, falling back to `data.task`
                            // for back-compat with any caller that hasn't been updated yet.
                            await specs.markTaskCompleted(data.taskTitle ?? data.task);

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
                                    const prdUpdates = await updateLivingPRD(currentPRD, data.task, "Manual Code Edit", fullContext);

                                    if (prdUpdates.length > 0) {
                                        prdUpdates.forEach(update => {
                                            currentPRD = currentPRD.replace(update.original, update.updated);
                                        });

                                        await specs.writeRequirements(currentPRD);
                                        this._activeRequirements = currentPRD;
                                        this._view?.webview.postMessage({ type: 'requirementsUpdated', text: currentPRD });
                                    }
                                }
                            } catch (e) {
                                log.warn("[DEBUG] Living PRD QA check failed for manual verify", e);
                            }

                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `✅ VERIFIED: ${verification.reasoning}` });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        } else {

                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'rejected', summary: `❌ REJECTED: ${verification.reasoning}` });
                        }

                    } catch (error: unknown) {
                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Verification Error: ${errorMessage(error)}` });
                    }
                    break;
                }

                case "generateRequirements": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }
                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '━━━ Phase 1 of 3: Requirements ━━━' });

                    try {
                        this._view?.webview.postMessage({ type: 'reqStep', message: 'Drafting Agile User Stories & Acceptance Criteria...' });

                        const reqPlan = await generateRequirements(data.text, data.context, this._activeTaskController.signal);

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

                        reqPlan.userStories.forEach((us: any, eIdx: number) => {
                            const epicId = `EPIC-${(eIdx + 1).toString().padStart(2, '0')}`;
                            enrichedPrompt += `<epic id="${epicId}" name="${us.epic || 'General'}">\n`;
                            enrichedPrompt += `### ${epicId}: ${us.epic || 'General'}\n\n`;

                            const storyId = `STORY-${epicId}-1`;
                            enrichedPrompt += `<story id="${storyId}">\n`;
                            enrichedPrompt += `**Story:** ${us.story || 'N/A'}\n\n**Acceptance Criteria:**\n`;

                            const criteria = us.acceptanceCriteria || us.acceptenceCriteria || us.AcceptanceCriteria || [];
                            const criteriaArray = Array.isArray(criteria) ? criteria : [criteria];

                            criteriaArray.forEach((ac: string, cIdx: number) => {
                                enrichedPrompt += `- [ ] <criteria id="${storyId}-C${cIdx + 1}">${ac}</criteria>\n`;
                            });

                            enrichedPrompt += `</story>\n`;
                            enrichedPrompt += `</epic>\n\n`;
                        });

                        enrichedPrompt += `## 🛡️ Non-Functional Requirements (NFRs)\n`;
                        enrichedPrompt += `<nfr_list>\n`;
                        reqPlan.nonFunctionalRequirements.forEach((nfr: string) => { enrichedPrompt += `- ${nfr}\n`; });
                        enrichedPrompt += `</nfr_list>\n`;

                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                        const specs = new SpecManager(rootUri);
                        await specs.writeRequirements(enrichedPrompt);
                        this._activeRequirements = enrichedPrompt;

                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved requirements.md` });
                        this._view?.webview.postMessage({ type: 'requirementsGenerated', text: enrichedPrompt });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await specs.readPhaseState() });
                    } catch (error: unknown) {
                        if (isAbortError(error)) {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Cancelled by User.` });
                        } else {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${errorMessage(error)}` });
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' }); // Reset UI
                    } finally {
                        this._activeTaskController = undefined;
                    }
                    break;
                }

                case "generateDesign": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    // PHASE GATE: requirements must be approved before design can be drafted.
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                    const gateSpecs = new SpecManager(rootUri);
                    try {
                        await gateSpecs.requirePhaseApproved('design');
                    } catch (e: unknown) {
                        this._view?.webview.postMessage({ type: 'reqStep', message: `🔒 ${errorMessage(e)}` });
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                        return;
                    }

                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Phase 2 of 3: System Design ━━━' });
                    this._view?.webview.postMessage({ type: 'reqStep', message: 'Analyzing approved PRD and drafting architecture...\n' });

                    try {
                        const designDoc = await generateDesign(data.requirements, this._activeTaskController.signal);

                        await new SpecManager(rootUri).writeDesign(designDoc);

                        this._activeDesign = designDoc;

                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved design.md` });
                        this._view?.webview.postMessage({ type: 'designGenerated', text: designDoc });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await new SpecManager(rootUri).readPhaseState() });
                    } catch (error: unknown) {
                        if (isAbortError(error)) {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Architecting Cancelled by User.` });
                        } else {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${errorMessage(error)}` });
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                    } finally {
                        this._activeTaskController = undefined;
                    }
                    break;
                }

                case "generateProjectTasks": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    // PHASE GATE: design must be approved before tasks can be drafted.
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                    const gateSpecs = new SpecManager(rootUri);
                    try {
                        await gateSpecs.requirePhaseApproved('tasks');
                    } catch (e: unknown) {
                        this._view?.webview.postMessage({ type: 'reqStep', message: `🔒 ${errorMessage(e)}` });
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                        return;
                    }

                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Phase 3 of 3: Implementation Plan ━━━' });
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Drafting Master Implementation Plan..." });
                    this._view?.webview.postMessage({ type: 'startChatStream' });

                    try {
                        const projectContext = await getProjectContext(rootUri.fsPath);
                        // P1.2: load active steering rules so the planner
                        // generates tasks consistent with project conventions
                        // ("always use Result<T,E>", "tests live next to
                        // their source"). buildSteeringPromptBlock returns
                        // empty string when no steering files have content,
                        // so this is a no-op for projects without steering.
                        const steeringBlock = await SteeringManager.getInstance().buildSteeringPromptBlock();

                        const plan = await generateTasks(
                            this._activeRequirements,
                            this._activeDesign,
                            projectContext,
                            this._activeTaskController.signal,
                            steeringBlock
                        );

                        const specs = new SpecManager(rootUri);
                        await specs.writeTasksJson(plan);

                        let mdContent = `---\n`;
                        mdContent += `version: 1.0.0\n`;
                        mdContent += `type: implementation_plan\n`;
                        mdContent += `status: draft\n`;
                        mdContent += `---\n\n`;
                        mdContent += "# Master Implementation Plan\n\n## 📁 Folder Structure\n";

                        mdContent += `<folder_structure>\n`;
                        plan.folderStructure.forEach((f: string) => mdContent += `- \`${f}\`\n`);
                        mdContent += `</folder_structure>\n\n`;

                        mdContent += "## 🛠️ Execution Tasks\n";
                        mdContent += `<tasks>\n`;
                        plan.implementationTasks.forEach((t: any, i: number) => {
                            const taskId = `TASK-${(i + 1).toString().padStart(3, '0')}`;
                            const prevTaskId = i > 0 ? `TASK-${(i).toString().padStart(3, '0')}` : 'none';

                            if (typeof t === 'string') {
                                mdContent += `<task id="${taskId}" dependsOn="${prevTaskId}">\n`;
                                mdContent += `${i + 1}. [ ] ${t}\n`;
                                mdContent += `</task>\n\n`;
                            } else {
                                mdContent += `<task id="${taskId}" dependsOn="${prevTaskId}" targetFile="${t.file}" relatesTo="${t.relatedRequirement || ''}">\n`;
                                mdContent += `${i + 1}. [ ] **${t.step}** (File: \`${t.file}\`)\n`;
                                mdContent += `   - *Instructions:* <instructions>${t.detailedInstructions}</instructions>\n`;
                                mdContent += `</task>\n\n`;
                            }
                        });
                        mdContent += `</tasks>\n`;

                        await specs.writeTasksMd(mdContent);

                        const { finalPaths, renamingMap } = await resolveCanonicalPaths(plan.folderStructure, rootUri.fsPath);
                        plan.folderStructure = finalPaths;
                        plan.implementationTasks = plan.implementationTasks.map((task: any) => {
                            if (typeof task === 'string') { return task; }
                            let updatedTask = { ...task };
                            renamingMap.forEach((realPath, plannedPath) => {
                                if (updatedTask.file === plannedPath) { updatedTask.file = realPath; }
                                if (updatedTask.detailedInstructions.includes(plannedPath)) {
                                    updatedTask.detailedInstructions = updatedTask.detailedInstructions.replace(plannedPath, realPath);
                                }
                            });
                            return updatedTask;
                        });

                        if (plan.folderStructure.length > 0) { await createWorkspaceStructure(plan.folderStructure); }

                        this._view?.webview.postMessage({ type: 'chatToken', token: "I have analyzed the PRD and System Architecture. Here is the master implementation plan. You can execute these tasks one by one using the buttons below, or run them all at once.\n\n" });
                        this._view?.webview.postMessage({ type: "structureResponse", value: plan });
                        this._view?.webview.postMessage({ type: 'tasksGenerated' });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await specs.readPhaseState() });

                    } catch (error: unknown) {
                        if (isAbortError(error)) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🛑 Planning Cancelled by User.` });
                        } else {
                            vscode.window.showErrorMessage(`Failed to generate tasks: ${errorMessage(error)}`);
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                    } finally {
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

                    if (feedback === undefined) { return; }

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
                        const next = await specs.setPhaseStatus(data.phase as Phase, 'approved');
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
                        const next = await specs.resetFromPhase(data.phase as Phase);
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: next });
                        vscode.window.showInformationMessage(`↩️ ${data.phase} rejected. Regenerate when ready.`);
                    }
                    break;
                }

                case "updateRequirements": {
                    this._activeRequirements = data.text;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                        try { await new SpecManager(rootUri).writeRequirements(data.text); } catch (e) { }
                    } else if (data.text === "") {
                        this._activeRequirements = "";
                        this._activeDesign = "";
                    }
                    break;
                }

                case "updateDesign": {
                    this._activeDesign = data.text;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                        try { await new SpecManager(rootUri).writeDesign(data.text); } catch (e) { }
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

                            const summary = await compactConversationHistory(messagesToCompact);

                            historyToSave = [
                                { role: 'assistant', isCompacted: true, content: summary },
                                ...recentMessages
                            ];

                            this._view?.webview.postMessage({ type: 'historyCompacted', messages: historyToSave });
                        } catch (e) {
                            log.error("Compaction failed", e);
                        } finally {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                    }

                    // 🚀 FIX: Use workspaceState to save data safely without overwriting other projects
                    await getDeps().state.update('nexus_chat_history', historyToSave);
                    await getDeps().state.update('nexus_task_statuses', data.taskStatuses);
                    await getDeps().state.update('nexus_task_summaries', data.taskSummaries);
                    await getDeps().state.update('nexus_task_files', data.taskFiles);
                    break;
                }

                case "clearHistory":
                    await getDeps().state.update('nexus_chat_history', []);
                    await getDeps().state.update('nexus_task_statuses', {});
                    await getDeps().state.update('nexus_task_summaries', {});
                    await getDeps().state.update('nexus_task_files', {});
                    break;

                case "saveApiKey":
                    await getDeps().secrets.store('nexuscode_apikey', data.value);
                    vscode.window.showInformationMessage(t("api_key.saved_securely"));
                    this._view?.webview.postMessage({ type: 'initState', messages: [], hasKey: true });
                    break;

                case "processUserMessage": {
                    this._activeTaskController = new AbortController();
                    try {
                        const workspacePath = await this.getTargetContext();

                        //  PHASE 5: INTERCEPT CUSTOM MARKDOWN SKILLS
                        const { SkillsManager } = await import('./skillsManager.js');
                        await SkillsManager.initializeSkillsDirectory(workspacePath);
                        const skillResult = await SkillsManager.processSkill(workspacePath, data.text);

                        if (skillResult.isSkill) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `✨ Executing Custom Skill...` });
                        } else {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing intent..." });
                        }

                        const intent = await determineIntent(data.text);

                        const fullPrompt = data.context
                            ? `--- ATTACHED CONTEXT ---\n${data.context}\n\n--- USER QUERY ---\n${data.text}`
                            : data.text;

                        if (intent === 'build') {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting plan..." });
                            this._view?.webview.postMessage({ type: 'startChatStream' });

                            await indexWorkspace((msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));

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
                            const projectStructure = await getProjectContext(workspacePath);

                            // P1.3: load steering exclude patterns
                            // alongside the other context sources, then
                            // pass them into getSmartASTContext.
                            const excludePatterns = await SteeringManager.getInstance().getExcludePatterns();

                            const [lspContext, styleGuideMsgs, astContext, hybridContext] = await Promise.all([
                                getLspContext(data.text),
                                getProjectStyleGuides(),
                                getSmartASTContext(data.text, { excludePatterns }),
                                retrieveHybridContext(data.text, 5, excludePatterns)
                            ]);
                            const styleGuide = styleGuideMsgs.map(m => m.content).join('\n');

                            // PRD and design come from files in the user's workspace and so are
                            // a prompt-injection vector — wrap them with the same untrusted
                            // envelope used for steering rules. See audit §13.
                            const requirementInjection = wrapUntrusted(
                                this._activeRequirements,
                                '.nexus/specs/main/requirements.md'
                            );
                            const designInjection = wrapUntrusted(
                                this._activeDesign,
                                '.nexus/specs/main/design.md'
                            );

                            // Order matters: the directory tree goes FIRST
                            // because the user message template (in
                            // generatePlan) prepends a "EXISTING DIRECTORY
                            // STRUCTURE:" label. The downstream LSP/AST/RAG
                            // context follows as semantic enrichment.
                            const finalContext = `${projectStructure}\n\n--- SEMANTIC CONTEXT ---\n${lspContext}\n\n${astContext}\n\n${hybridContext}\n\n${styleGuide}\n\n${requirementInjection}\n\n${designInjection}`;

                            const result = await generatePlan(fullPrompt, finalContext);

                            this._view?.webview.postMessage({ type: 'chatToken', token: result.explanation + "\n\n" });

                            const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                            const { finalPaths, renamingMap } = await resolveCanonicalPaths(result.plan.folderStructure, rootSearchPath);
                            result.plan.folderStructure = finalPaths;

                            result.plan.implementationTasks = result.plan.implementationTasks.map(task => {
                                let updatedTask = task;
                                renamingMap.forEach((realPath, plannedPath) => {
                                    const plannedName = path.basename(plannedPath);
                                    if (typeof updatedTask === 'string') {
                                        if (updatedTask.includes(plannedPath)) { updatedTask = updatedTask.replace(plannedPath, realPath); }
                                        else if (updatedTask.includes(plannedName)) { updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`); }
                                    }
                                });
                                return updatedTask;
                            });

                            if (result.plan.folderStructure.length > 0) { await createWorkspaceStructure(result.plan.folderStructure); }

                            this._view?.webview.postMessage({ type: "structureResponse", value: result.plan });

                        } else if (intent === 'explore') {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🔍 Agentic Exploration: Investigating..." });

                            // 🔥 Create a dummy task ID so the UI renders the beautiful Swarm Logs
                            const exploreTaskId = "Exploration-" + Date.now();
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: exploreTaskId, status: 'reviewing', summary: 'Gathering forensic evidence...' });

                            const workspacePath = await this.getTargetContext();

                            // 🚀 FAST-TRACK: Pre-fetch the AST so the AI doesn't have to guess!
                            const projectContext = await getProjectContext(workspacePath);

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
                            const exploreResult = await PlannerAgent.run({
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
                            this._view?.webview.postMessage({ type: 'startChatStream' });

                            const fullContext = `--- FORENSIC EVIDENCE GATHERED BY TOOLS ---\n${explorationContext}\n\nBased on this evidence, explain exactly what went wrong and how we should fix it.`;

                            // Stream the final analysis back to the chat window
                            await streamChat(
                                data.text,
                                fullContext,
                                data.history || [],
                                (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); },
                                this._activeTaskController.signal
                            );

                            this._view?.webview.postMessage({ type: 'taskCompleted', task: exploreTaskId, status: 'approved', summary: 'Exploration Complete' });
                        } else {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Gathering context..." });

                            const workspacePath = await this.getTargetContext();
                            const ragContext = await retrieveHybridContext(data.text, 5);

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
                                const projectStructure = await getProjectContext(workspacePath);
                                const truncatedStructure = projectStructure.length > 15000 ? projectStructure.substring(0, 15000) + "\n...[TRUNCATED TO SAVE TOKENS]" : projectStructure;
                                fullContext = `Directory Tree:\n${truncatedStructure}\n\nCurrently Open Files:\n${openFilesContext}\n\nVector Search Context:\n${ragContext}`;
                            } else {
                                fullContext = `Currently Open Files:\n${openFilesContext}\n\nVector Search Context:\n${ragContext}`;
                            }

                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Thinking..." });
                            this._view?.webview.postMessage({ type: 'startChatStream' });

                            await streamChat(
                                fullPrompt, fullContext,
                                data.history || [],
                                (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); },
                                this._activeTaskController.signal
                            );
                        }

                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    } catch (error: unknown) {
                        if (isAbortError(error)) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "⚠️ Generation stopped." });
                            setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);
                        } else {
                            vscode.window.showErrorMessage(`NexusCode Error: ${errorMessage(error)}`);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                            this._view?.webview.postMessage({ type: 'taskCompleted', status: 'error' });
                        }
                    } finally {
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

                case "executeTask": {
                    const originalTaskQuery = data.prompt || data.task;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
                    this._activeTaskController = new AbortController();

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
                                approaches = await generateMCTSApproaches(originalTaskQuery, "Generating alternative architectures...");
                            }

                            let success = false;
                            let finalMergedFilepath = "";

                            for (let i = 0; i < approaches.length; i++) {
                                if (success || token.isCancellationRequested) { break; }

                                const approachNum = i + 1;
                                const isMCTSActive = approaches.length > 1;
                                const currentApproachPrompt = isMCTSActive ? `Original Task: ${originalTaskQuery}\n\nImplementation Directive (Approach ${approachNum}):\n${approaches[i]}` : originalTaskQuery;

                                const sandboxBranch = `nexus-mcts-sandbox-${Date.now()}`;

                                try {
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git stash`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -b ${sandboxBranch}`, rootUri.fsPath);
                                    }

                                    const swarmSpecs = new SpecManager(rootUri);
                                    const previousFailures = await swarmSpecs.readFailures();

                                    const env = new VSCodeEnvironment();

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

                                    const finalDiffs = await runTask({
                                        env,
                                        task: currentApproachPrompt,
                                        workspaceRoot: rootUri.fsPath,
                                        activeRequirements: this._activeRequirements,
                                        activeDesign: this._activeDesign,
                                        previousFailures,
                                        globalRules,
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
                                        perFileSteering: async (filepath: string) =>
                                            SteeringManager.getInstance().buildSteeringPromptBlock({
                                                targetFilepath: filepath
                                            }),
                                        log: (msg: string, stepType?: string, details?: string) => {
                                            this._view?.webview.postMessage({ type: 'statusUpdate', message: msg });
                                            if (stepType && details) {
                                                this._view?.webview.postMessage({
                                                    type: 'agentStep',
                                                    task: data.task,
                                                    stepType: stepType,
                                                    description: msg.replace('Coordinator: ', ''),
                                                    details: details
                                                });
                                            }
                                        },
                                        streamCallback: (streamToken: string) => {
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: streamToken });
                                        },
                                        ...(this._activeTaskController?.signal ? { abortSignal: this._activeTaskController.signal } : {}),
                                        usageCallback: (usage: unknown) => {
                                            this._view?.webview.postMessage({ type: 'tokenUsage', task: data.task, usage });
                                        },
                                        // Lifecycle event emitter for tool calls.
                                        // Lazily-constructed; sink is webview
                                        // postMessage. The 'toolCallEvent'
                                        // messages are consumed by the rich
                                        // tool-call cards in the webview.
                                        toolEventEmitter: this.getToolEventEmitter(),
                                    });

                                    if (!finalDiffs || finalDiffs.length === 0) { throw new Error("Swarm failed to generate verified code."); }

                                    // 🚀 UPGRADED: Loop through every diff generated by the Swarm and apply them!
                                    for (const finalDiff of finalDiffs) {
                                        const realFilepath = finalDiff.filepath;
                                        const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);

                                        let fileContent = "";
                                        try {
                                            const fileData = await vscode.workspace.fs.readFile(fileUri);
                                            fileContent = new TextDecoder().decode(fileData);
                                        } catch { await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0)); }

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
                                        const mergedHeader = getAIHeader(realFilepath, currentApproachPrompt, fileContent) + "\n";
                                        const finalCodePayload = mergedHeader + finalPerfectCode;

                                        await editor.edit(b => {
                                            b.delete(new vscode.Range(0, 0, document.lineCount, 0));
                                            b.insert(new vscode.Position(0, 0), finalCodePayload);
                                        });

                                        await document.save();

                                        // Track provenance for EACH file edited in the Sub-Task graph
                                        if (this._tracker) {
                                            this._tracker.trackStreamedReview(
                                                editor,
                                                fileContent,
                                                data.task,
                                                0,
                                                document.lineCount
                                            );
                                        }

                                        finalMergedFilepath = realFilepath; // Keep the last one for the UI success message
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

                                } catch (error: unknown) {
                                    if (isAbortError(error)) {
                                        throw error; // 🚀 FIX: Bubble the abort up immediately!
                                    }
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git reset --hard`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git branch -D ${sandboxBranch}`, rootUri.fsPath);
                                    } else {
                                        vscode.window.showErrorMessage(`Execution failed: ${errorMessage(error)}`);
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
                                    await new SpecManager(rootUri).markTaskCompleted(data.taskTitle ?? data.task);
                                } catch (e) {
                                    log.warn("Could not auto-update tasks.md", e);
                                }

                                // Trigger the green checkmark
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: "approved", filepath: finalMergedFilepath, summary: `Updated ${finalMergedFilepath} (Total: ${totalTime}s)` });

                                // Guarantee state sync
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `Updated ${finalMergedFilepath}` });
                            } else {
                                const errorSummary = approaches.length > 1 ? `⚠️ All ${approaches.length} MCTS Approaches Failed.` : `⚠️ Execution Failed.`;

                                // 🔥 The UI expects taskStatusUpdate to kill the spinner on failure
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: errorSummary });
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: errorSummary });
                            }

                        } catch (fatalError: unknown) {
                            // 🚀 FIX: Catch the explicit abort and gracefully update the UI to "error" (which triggers the Retry button)
                            if (isAbortError(fatalError) || token.isCancellationRequested) {
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: '🛑 Task Cancelled by User.' });
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: '🛑 Task Cancelled by User.' });
                            } else {
                                // Catch catastrophic Node.js crashes so the UI doesn't hang forever
                                const safeErrorMessage = errorMessage(fatalError);
                                vscode.window.showErrorMessage(`Nexus Catastrophic Failure: ${safeErrorMessage}`);

                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Fatal Crash: ${safeErrorMessage}` });
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error' });
                            }
                        } finally {
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
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;
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
                        } catch (e) {
                            vscode.window.showErrorMessage(t("undo.failed_to_undo"));
                        }
                    } else {
                        vscode.window.showWarningMessage(t("undo.no_history"));
                    }
                    break;
                }

                case "runGlobalCompiler": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    const workspacePath = workspaceFolders[0]!.uri.fsPath;
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Running Global Workspace Compiler..." });

                    // 🚀 POLYGLOT GLOBAL COMPILER: Sniff the workspace to find the right command
                    let buildCommand = "";
                    try {
                        const files = await vscode.workspace.fs.readDirectory(workspaceFolders[0]!.uri);
                        const fileNames = files.map(f => f[0]);

                        if (fileNames.includes('pom.xml')) { buildCommand = "mvn clean compile"; }
                        else if (fileNames.includes('build.gradle')) { buildCommand = "gradle build -x test"; }
                        else if (fileNames.includes('go.mod')) { buildCommand = "go build ./..."; }
                        else if (fileNames.includes('requirements.txt')) { buildCommand = "python -m compileall ."; }
                        else if (fileNames.includes('tsconfig.json')) { buildCommand = "npx -p typescript tsc --noEmit"; }
                        else if (fileNames.includes('package.json')) { buildCommand = "npm run build"; }
                        else { buildCommand = "echo 'No standard build file found (e.g., tsconfig.json, pom.xml). Skipping build.'"; }
                    } catch (e) {
                        // 🚀 FIX: Do not assume TypeScript if the environment is completely unknown!
                        buildCommand = "echo 'No standard build system detected (e.g., tsconfig.json, pom.xml). Skipping global compilation.'";
                    }

                    const result = await this._terminalManager?.runCommandWithCapture(buildCommand, workspacePath);

                    if (result && result.success) {
                        vscode.window.showInformationMessage(t("build_healer.compiler_passed"));
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    } else if (result && !result.success) {
                        vscode.window.showErrorMessage(t("build_healer.compiler_failed"));
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing global build failures..." });

                        try {
                            // 1. Extract broken file paths from the TypeScript error log
                            // e.g. "src/models/user.ts(5,10): error TS2304..." -> "src/models/user.ts"
                            const fileRegex = /([a-zA-Z0-9_\-\/\\]+\.(?:ts|tsx|js|jsx|py|go|rs|cpp|c|h|hpp|java|rb|php|cs))/g;
                            const matches = [...new Set(result.output.match(fileRegex))]; // Get unique files

                            if (matches.length === 0) { throw new Error("Could not parse file paths from error log."); }

                            // 2. Read the contents of the broken files
                            let brokenFilesContext = "";
                            for (const file of matches) {
                                try {
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, file);
                                    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
                                    brokenFilesContext += `\n--- FILE: ${file} ---\n\`\`\`\n${content}\n\`\`\`\n`;
                                } catch (e) {
                                    // File might be a phantom import that doesn't exist yet
                                }
                            }

                            // 3. Call the Build-Healer Agent
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Healing ${matches.length} cross-file errors...` });
                            const fixes = await healGlobalBuild(result.output, brokenFilesContext, data.codingStyle || 'precise');

                            // 4. Apply the Autonomous Edits
                            if (fixes && fixes.length > 0) {
                                const workspaceEdit = new vscode.WorkspaceEdit();

                                for (const edit of fixes) {
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, edit.filepath);

                                    // Ensure file exists
                                    try { await vscode.workspace.fs.stat(fileUri); }
                                    catch { await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0)); }

                                    const document = await vscode.workspace.openTextDocument(fileUri);
                                    const aiHeader = getAIHeader(edit.filepath, "Build-Healer Patch");
                                    const finalCode = aiHeader + edit.code;

                                    workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), finalCode);
                                }

                                if (await vscode.workspace.applyEdit(workspaceEdit)) {
                                    // Save all dirty documents so TS can see the updates
                                    const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                                    for (const doc of dirtyDocs) { await doc.save(); }

                                    vscode.window.showInformationMessage(`✅ Build-Healer autonomously patched ${fixes.length} files!`);
                                }
                            } else {
                                vscode.window.showWarningMessage(t("build_healer.no_safe_patch"));
                            }
                        } catch (error: unknown) {
                            log.error("[DEBUG-HEALER]", error);

                            //  THE FIX: Expose the actual error and the raw terminal output so the developer can see why it failed!
                            const safeError = errorMessage(error);
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
                    if (!workspaceFolders) { return; }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;

                    const fileUri = vscode.Uri.joinPath(rootUri, data.filepath);
                    const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);

                    await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, `NexusCode Diff: ${path.basename(data.filepath)}`);
                    break;
                }

                case "openFile": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;

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
                    } catch (e) {
                        vscode.window.showErrorMessage(`NexusCode: Could not open ${fileUri.fsPath}`);
                    }
                    break;
                }

                case "readFileContext": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    // Parse the target file and optional line ranges (e.g., "src/App.tsx:10-50")
                    let targetFile = data.file;
                    let startLine = 0;
                    let endLine = Infinity;

                    const match = targetFile.match(/(.*?):(\d+)(?:-(\d+))?$/);
                    if (match) {
                        targetFile = match[1];
                        startLine = Math.max(0, parseInt(match[2], 10) - 1); // 0-indexed
                        if (match[3]) { endLine = parseInt(match[3], 10); }
                        else { endLine = startLine + 100; }
                    }

                    const fileUri = vscode.Uri.joinPath(this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri, targetFile);
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
                    } catch (e) {
                        log.error("Failed to read file for context:", e);
                    }
                    break;
                }

                case "executeAllTasks": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode: Drafting Atomic Plan...",
                        cancellable: true
                    }, async (progress, token) => {
                        try {
                            const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                            const projectContext = await getProjectContext(contextRoot);
                            const allEdits: AtomicEdit[] = [];
                            const BATCH_SIZE = 5;

                            for (let i = 0; i < data.tasks.length; i += BATCH_SIZE) {
                                if (token.isCancellationRequested) { break; }
                                const batch = data.tasks.slice(i, i + BATCH_SIZE);
                                const batchNum = Math.ceil((i + 1) / BATCH_SIZE);
                                const totalBatches = Math.ceil(data.tasks.length / BATCH_SIZE);

                                progress.report({ message: `Drafting batch ${batchNum}/${totalBatches}...` });
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: `Drafting batch ${batchNum}/${totalBatches}: ${batch[0]}...` });

                                try {
                                    const batchEdits = await generateAtomicEdits(batch, projectContext, data.codingStyle);
                                    allEdits.push(...batchEdits);
                                } catch (e) { }
                            }

                            if (token.isCancellationRequested) { return; }

                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Compiling Final Review..." });
                            this._view?.webview.postMessage({ type: 'reviewEdits', edits: allEdits, tasks: data.tasks });

                            vscode.window.showInformationMessage(`Draft complete. Generated code for ${allEdits.length} files.`);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        } catch (error) {
                            vscode.window.showErrorMessage(`Drafting Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                    });
                    break;
                }

                case "commitAtomicEdits": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders || !data.edits) { return; }

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode: Committing Changes...",
                        cancellable: false
                    }, async () => {
                        const workspaceEdit = new vscode.WorkspaceEdit();
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0]!.uri;

                        for (const edit of data.edits) {
                            const fileUri = vscode.Uri.joinPath(rootUri, edit.filepath);
                            const aiHeader = getAIHeader(edit.filepath, "Atomic Implementation");
                            const finalCode = aiHeader + edit.code;

                            try { await vscode.workspace.fs.stat(fileUri); }
                            catch { await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0)); }

                            const document = await vscode.workspace.openTextDocument(fileUri);
                            workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), finalCode);
                        }

                        if (await vscode.workspace.applyEdit(workspaceEdit)) {
                            const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                            for (const doc of dirtyDocs) { await doc.save(); }

                            this._view?.webview.postMessage({ type: 'allTasksCompleted', status: 'approved' });
                            vscode.window.showInformationMessage(t("transactions.atomic_committed"));
                        }
                    });
                    break;
                }

                case "generateAndRunTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const activeEditor = vscode.window.activeTextEditor;

                    if (!workspaceFolders || !activeEditor) { return; }

                    const workspacePath = workspaceFolders[0]!.uri.fsPath;

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode is writing and executing tests...",
                        cancellable: false
                    }, async () => {
                        try {
                            this._view?.webview.postMessage({ type: 'clearTerminalStream', task: "Auto-Test Setup" });
                            this._view?.webview.postMessage({ type: 'clearTerminalStream', task: "Auto-Test Execution" });
                            const relativeFileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                            const customRules = (await new SpecManager(workspaceFolders[0]!.uri).readSteering()).combined;
                            const testPlan = await generateTests(relativeFileName, activeEditor.document.getText(), customRules);
                            if (activeEditor.document.isDirty) { await activeEditor.document.save(); }

                            if (testPlan.installCommand) {
                                const installResult = await this.confirmAndRunCommand(
                                    testPlan.installCommand,
                                    workspacePath,
                                    'Installing dependencies...',
                                    data.autopilot,
                                    //  THE UI STREAMER: Send the live npm install text to the chat window!
                                    (chunk) => {
                                        this._view?.webview.postMessage({ type: 'streamTerminal', task: "Auto-Test Setup", text: chunk });
                                    }
                                );

                                if (!installResult || !installResult.success) {
                                    vscode.window.showErrorMessage(t("tests.dependency_install_failed"));
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
                            if (parsedPath.ext === '.go') { testFileName = `${parsedPath.name}_test.go`; }
                            else if (parsedPath.ext === '.py') { testFileName = `test_${parsedPath.name}.py`; }
                            else if (parsedPath.ext === '.rs') { testFileName = `${parsedPath.name}_test.rs`; }
                            else if (parsedPath.ext === '.java') { testFileName = `${parsedPath.name.charAt(0).toUpperCase() + parsedPath.name.slice(1)}Test.java`; }
                            else if (parsedPath.ext === '.rb') { testFileName = `test_${parsedPath.name}.rb`; }

                            // Hardcode the route to the root 'tests/' directory
                            const deterministicPath = path.join('tests', cleanDir, testFileName);
                            const testFileUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, deterministicPath);

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

                            const result = await this.confirmAndRunCommand(
                                testPlan.testCommand,
                                workspacePath,
                                'Running tests...',
                                data.autopilot,
                                //  THE UI STREAMER: Send the live test results to the chat window!
                                (chunk) => {
                                    this._view?.webview.postMessage({ type: 'streamTerminal', task: "Auto-Test Execution", text: chunk });
                                }
                            );

                            if (!result) {
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });
                                return;
                            }

                            if (!result.success) {
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Tests failed. Auto-healing...' });

                                try {
                                    const fixResult = await healError(
                                        result.output,
                                        relativeFileName,
                                        activeEditor.document.getText(),
                                        deterministicPath,
                                        testPlan.code
                                    );

                                    const fileToFixUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, fixResult.filepath);
                                    const fixEdit = new vscode.WorkspaceEdit();
                                    const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                                    fixEdit.replace(fileToFixUri, new vscode.Range(0, 0, docToFix.lineCount, 0), fixResult.code);

                                    await vscode.workspace.applyEdit(fixEdit);
                                    await docToFix.save();

                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Re-running tests after heal...' });
                                    const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);

                                    if (retryResult?.success) { vscode.window.showInformationMessage(`Auto-Heal successful! Fixed ${fixResult.filepath}`); }
                                    else { vscode.window.showErrorMessage(t("tests.auto_heal_still_failing")); }

                                } catch (e) {
                                    vscode.window.showErrorMessage(t("tests.auto_heal_parse_failed"));
                                }
                            } else {
                                vscode.window.showInformationMessage(t("tests.all_passed"));
                            }
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });

                        } catch (error) {
                            vscode.window.showErrorMessage(t("tests.generation_failed"));
                        }
                    });
                    break;
                }

                case "executeCommand": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }
                    const workspacePath = workspaceFolders[0]!.uri.fsPath;

                    const maxRetries = 3;
                    let currentAttempt = 1;
                    let success = false;

                    this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing' });

                    while (currentAttempt <= maxRetries && !success) {
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Running \`${data.command}\` (Attempt ${currentAttempt}/${maxRetries})...` });

                        // 1. Run the headless terminal and stream to the UI
                        const result = await this._terminalManager?.runCommandWithCapture(
                            data.command,
                            workspacePath,
                            (chunk) => {
                                // Stream the live terminal output to the React UI!
                                this._view?.webview.postMessage({ type: 'streamTerminal', task: data.task, text: chunk });
                            }
                        );

                        if (!result) { break; }

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
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, edit.filepath);
                                    const document = await vscode.workspace.openTextDocument(fileUri);
                                    workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), edit.code);
                                }
                                await vscode.workspace.applyEdit(workspaceEdit);

                                // Save files so the next terminal run sees the changes!
                                const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                                for (const doc of dirtyDocs) { await doc.save(); }

                                this._view?.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'heal', description: `Auto-Heal Applied to ${fixes.length} files.` });
                            } else {
                                throw new Error("AI could not determine a safe patch.");
                            }
                        } catch (e) {
                            this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: `❌ Auto-heal failed: ${e instanceof Error ? e.message : 'Unknown'}` });
                            break;
                        }

                        currentAttempt++;
                    }

                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    break;
                }

                case "requestModels": {
                    const models = await getAvailableModels();
                    const currentModel = vscode.workspace.getConfiguration('nexuscode').get<string>('model');

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
                            planner:  newCfg.get<boolean>('thinkingPlanner')  ?? true,
                            coder:    newCfg.get<boolean>('thinkingCoder')    ?? true,
                            verifier: newCfg.get<boolean>('thinkingVerifier') ?? true,
                        },
                    });
                    break;
                }

                case "openThinkingSettings": {
                    // Inline "Advanced" link → opens VS Code settings
                    // filtered to the per-agent thinking keys. Lets
                    // power users customize per-agent without us
                    // building inline UI for it.
                    await vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'nexuscode.thinking'
                    );
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
                        let topLevelFilenames: string[] = [];
                        let totalFileCount = 0;
                        if (workspaceRoot) {
                            try {
                                const entries = await vscode.workspace.fs.readDirectory(
                                    vscode.Uri.file(workspaceRoot)
                                );
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
                                    if (totalFileCount >= COUNT_CAP) { break; }
                                    if (kind !== vscode.FileType.Directory) { continue; }
                                    if (SKIP_DIRS.has(name)) { continue; }
                                    try {
                                        const sub = await vscode.workspace.fs.readDirectory(
                                            vscode.Uri.file(path.join(workspaceRoot, name))
                                        );
                                        totalFileCount += sub.filter(
                                            ([_, k]) => k === vscode.FileType.File
                                        ).length;
                                    } catch {
                                        // Subdir read failed (permission,
                                        // race) — treat as 0 contribution.
                                    }
                                }
                            } catch (e) {
                                log.warn(`[Scaffold] Could not list workspace: ${errorMessage(e)}`);
                            }
                        }

                        const detection = detectGreenfield({
                            prompt: userPrompt,
                            topLevelFilenames,
                            totalFileCount,
                        });

                        const templates = discoverTemplates(
                            workspaceRoot,
                            this._extensionUri.fsPath
                        );

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
                    } catch (e) {
                        log.error(`[Scaffold] requestScaffoldDecision failed: ${errorMessage(e)}`);
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
                    // V2.1.1 — webview reports the user's choice. Today
                    // we just log and acknowledge; the actual scaffolding
                    // (template file copy + Planner prompt adjustment)
                    // lands in V2.1.2 / V2.1.3. Logging now lets us
                    // verify the decision flow end-to-end during V2.1.1
                    // QA before V2.1.2 introduces filesystem effects.
                    const action = typeof data.action === 'string' ? data.action : 'skip';
                    const templateId = typeof data.templateId === 'string' ? data.templateId : null;
                    log.info(
                        `[Scaffold] User decision: action=${action}` +
                        (templateId ? ` templateId=${templateId}` : '')
                    );
                    // Echo back so the webview can release its waiting
                    // state and proceed with the user's prompt as
                    // normal (or with scaffolding context once V2.1.2
                    // lands).
                    this._view?.webview.postMessage({
                        type: 'scaffoldDecisionAcknowledged',
                        action,
                        templateId,
                    });
                    break;
                }

                case "approveCommand": {
                    if (this._pendingCommandResolver) { this._pendingCommandResolver(true); }
                    break;
                }

                case "rejectCommand": {
                    if (this._pendingCommandResolver) { this._pendingCommandResolver(false); }
                    break;
                }

                case "generateProjectTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }
                    const rootUri = workspaceFolders[0]!.uri;

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Nexus: Architecting Master Project TDD Suite...`,
                        cancellable: false
                    }, async (progress) => {
                        try {
                            const env = new VSCodeEnvironment();

                            // 🚀 Gather the ENTIRE codebase context using our existing Explorer tooling
                            const projectContext = await getProjectContext(rootUri.fsPath);

                            // Run the Global Two-Phase Test Agent
                            const testResult = await runProjectTestAgent(
                                env,
                                this._activeRequirements,
                                projectContext,
                                rootUri.fsPath,
                                (msg) => progress.report({ message: msg })
                            );

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
                            } else {
                                vscode.window.showErrorMessage(`Failed to generate master TDD suite.`);
                            }
                        } catch (error: unknown) {
                            vscode.window.showErrorMessage(`TDD Generation Error: ${errorMessage(error)}`);
                        }
                    });
                    break;
                }

                // PR 3.2: hooks panel messages. The HookManager owns
                // hook state on the host; we just delegate. Updates flow
                // back through the subscription wired in resolveWebviewView.
                case "requestHookList": {
                    try {
                        const hm = HookManager.getInstance();
                        const summaries = hm.getHookSummaries();
                        this._view?.webview.postMessage({
                            type: 'hookListUpdated',
                            hooks: summaries
                        });
                    } catch (e: unknown) {
                        log.warn('requestHookList failed:', e);
                    }
                    break;
                }
                case "toggleHook": {
                    const id = (data as { id?: unknown }).id;
                    const enabled = (data as { enabled?: unknown }).enabled;
                    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
                        break;
                    }
                    try {
                        await HookManager.getInstance().toggleHook(id, enabled);
                    } catch (e: unknown) {
                        log.warn('toggleHook failed:', e);
                    }
                    break;
                }
                case "runHook": {
                    const id = (data as { id?: unknown }).id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await HookManager.getInstance().runHookManually(id);
                    } catch (e: unknown) {
                        log.warn('runHook failed:', e);
                    }
                    break;
                }
                case "openHookFile": {
                    const id = (data as { id?: unknown }).id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await HookManager.getInstance().openHookFile(id);
                    } catch (e: unknown) {
                        log.warn('openHookFile failed:', e);
                    }
                    break;
                }

                // PR 3.3: steering rules panel messages. Delegate to
                // SteeringManager. Updates round-trip via the
                // subscription wired in resolveWebviewView.
                case "requestSteeringList": {
                    try {
                        const sm = SteeringManager.getInstance();
                        const summaries = await sm.getSteeringSummaries();
                        this._view?.webview.postMessage({
                            type: 'steeringListUpdated',
                            items: summaries
                        });
                    } catch (e: unknown) {
                        log.warn('requestSteeringList failed:', e);
                    }
                    break;
                }
                case "createSteeringFile": {
                    const id = (data as { id?: unknown }).id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await SteeringManager.getInstance().ensureSteeringFile(id);
                    } catch (e: unknown) {
                        log.warn('createSteeringFile failed:', e);
                    }
                    break;
                }
                case "openSteeringFile": {
                    const id = (data as { id?: unknown }).id;
                    if (typeof id !== 'string') {
                        break;
                    }
                    try {
                        await SteeringManager.getInstance().openSteeringFile(id);
                    } catch (e: unknown) {
                        log.warn('openSteeringFile failed:', e);
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
                        const mgr = McpManager.getInstance();
                        this._view?.webview.postMessage({
                            type: 'mcpStatusUpdated',
                            servers: mgr.getServerViews(),
                            configError: mgr.getConfigError()
                        });
                    } catch (e: unknown) {
                        log.warn('requestMcpStatus failed:', e);
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
                        await McpManager.getInstance().reloadConfig();
                    } catch (e: unknown) {
                        log.warn('mcpReload failed:', e);
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
                        const audit = getDeps().audit;
                        const records = await audit.readRecords();
                        const sessions = listSessions(records);
                        this._view?.webview.postMessage({
                            type: 'sessionListUpdated',
                            sessions
                        });
                    } catch (e: unknown) {
                        log.warn('requestSessionList failed:', e);
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
                    const sessionId = (data as { sessionId?: unknown }).sessionId;
                    if (typeof sessionId !== 'string') { break; }
                    try {
                        const audit = getDeps().audit;
                        const records = await audit.readRecords();
                        const summary = summarizeSession(records, sessionId);
                        const timeline = buildTimeline(records, { sessionId });
                        const breakdown = computeTokenBreakdown(records, sessionId);
                        const bundle = buildSessionBundle(records, sessionId);
                        this._view?.webview.postMessage({
                            type: 'sessionBundleUpdated',
                            sessionId,
                            summary,
                            timeline,
                            breakdown,
                            bundle
                        });
                    } catch (e: unknown) {
                        log.warn('requestSessionBundle failed:', e);
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
                            marks: getMarks(),
                            relative: getMarksRelative()
                        });
                    } catch (e: unknown) {
                        log.warn('requestStartupTiming failed:', e);
                    }
                    break;
                }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "static", "js", "main.js")
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "static", "css", "style.css")
    );
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

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}