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
const PlannerAgent_1 = require("./agents/PlannerAgent");
const toolEventEmitter_1 = require("./agents/toolEventEmitter");
const toolAuditCorrelator_1 = require("./audit/toolAuditCorrelator");
const SpecManager_1 = require("./specs/SpecManager");
const VSCodeEnvironment_1 = require("./adapters/VSCodeEnvironment");
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
// Utilities
const commentStyles_1 = require("./utilities/commentStyles");
const pathUtils_1 = require("./utilities/pathUtils");
const workspaceManager_1 = require("./workspaceManager");
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
    _undoStack = new Map();
    _pendingCommandResolver;
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
        if (this._isMetaMode)
            return new SpecManager_1.SpecManager(this._extensionUri);
        if (!folders || folders.length === 0)
            return null;
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
        vscode.workspace.registerTextDocumentContentProvider('nexus-diff', diffProvider_1.originalContentProvider);
        this._tracker?.setView(webviewView);
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build")
            ]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                //  THE FIX: The Webview Handshake. Loads chat history, PRD, design, tasks, steering rules.
                case "webviewReady": {
                    const chatHistory = (0, container_1.getDeps)().state.get('nexus_chat_history') || [];
                    const taskStatuses = (0, container_1.getDeps)().state.get('nexus_task_statuses') || {};
                    const taskSummaries = (0, container_1.getDeps)().state.get('nexus_task_summaries') || {};
                    const taskFiles = (0, container_1.getDeps)().state.get('nexus_task_files') || {};
                    const hasApiKey = !!(await (0, container_1.getDeps)().secrets.get('nexuscode_apikey'));
                    let savedReqs = "";
                    let savedDesign = "";
                    let savedTasks = null;
                    let savedRules = "";
                    let savedPhaseState = null;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const rootUri = workspaceFolders[0].uri;
                        (0, codeGraph_1.buildWorkspaceGraph)(rootUri).catch(e => logger_1.log.error("CodeGraph init failed:", e));
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
                        hasKey: hasApiKey
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
                            if (filepath === 'nodes' || filepath === 'edges')
                                return;
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
                        // Fetch & Parse Requirements (PRD)
                        let reqGraph = { nodes: [], edges: [] };
                        try {
                            const { parseRequirementGraph } = await import('./context/traceabilityGraph.js');
                            const reqString = await specs.readRequirements();
                            if (reqString) {
                                reqGraph = await parseRequirementGraph(reqString);
                            }
                        }
                        catch (e) {
                            logger_1.log.debug("[DEBUG-MAP] 🟡 No requirements.md found or parsing failed:", e instanceof Error ? e.message : String(e));
                        }
                        // Fetch & Parse Architecture (Design)
                        let designGraph = { nodes: [], edges: [] };
                        try {
                            const { parseDesignGraph } = await import('./context/traceabilityGraph.js');
                            const designString = await specs.readDesign();
                            if (designString) {
                                designGraph = await parseDesignGraph(designString);
                            }
                        }
                        catch (e) {
                            logger_1.log.debug("[DEBUG-MAP] 🟡 No design.md found or parsing failed:", e instanceof Error ? e.message : String(e));
                        }
                        let tasksJson = await specs.readTasksJson();
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
                                isGraphLoading: false // Unlocks the UI buttons
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
                        const [astContext, hybridContext] = await Promise.all([
                            (0, codeGraph_1.getSmartASTContext)(taskQuery),
                            (0, hybridSearch_1.retrieveHybridContext)(taskQuery, 5)
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
                                    const prdUpdates = await (0, llmService_1.updateLivingPRD)(currentPRD, data.task, "Manual Code Edit", fullContext);
                                    if (prdUpdates.length > 0) {
                                        prdUpdates.forEach(update => {
                                            currentPRD = currentPRD.replace(update.original, update.updated);
                                        });
                                        await specs.writeRequirements(currentPRD);
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
                        reqPlan.userStories.forEach((us, eIdx) => {
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
                        enrichedPrompt += `## 🛡️ Non-Functional Requirements (NFRs)\n`;
                        enrichedPrompt += `<nfr_list>\n`;
                        reqPlan.nonFunctionalRequirements.forEach((nfr) => { enrichedPrompt += `- ${nfr}\n`; });
                        enrichedPrompt += `</nfr_list>\n`;
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const specs = new SpecManager_1.SpecManager(rootUri);
                        await specs.writeRequirements(enrichedPrompt);
                        this._activeRequirements = enrichedPrompt;
                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved requirements.md` });
                        this._view?.webview.postMessage({ type: 'requirementsGenerated', text: enrichedPrompt });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await specs.readPhaseState() });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Cancelled by User.` });
                        }
                        else {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${(0, errors_1.errorMessage)(error)}` });
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' }); // Reset UI
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
                        await gateSpecs.requirePhaseApproved('design');
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
                        await new SpecManager_1.SpecManager(rootUri).writeDesign(designDoc);
                        this._activeDesign = designDoc;
                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved design.md` });
                        this._view?.webview.postMessage({ type: 'designGenerated', text: designDoc });
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await new SpecManager_1.SpecManager(rootUri).readPhaseState() });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Architecting Cancelled by User.` });
                        }
                        else {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${(0, errors_1.errorMessage)(error)}` });
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' });
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
                        await gateSpecs.requirePhaseApproved('tasks');
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
                        const plan = await (0, llmService_1.generateTasks)(this._activeRequirements, this._activeDesign, projectContext, this._activeTaskController.signal);
                        const specs = new SpecManager_1.SpecManager(rootUri);
                        await specs.writeTasksJson(plan);
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
                        await specs.writeTasksMd(mdContent);
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
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: await specs.readPhaseState() });
                    }
                    catch (error) {
                        if ((0, errors_1.isAbortError)(error)) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🛑 Planning Cancelled by User.` });
                        }
                        else {
                            vscode.window.showErrorMessage(`Failed to generate tasks: ${(0, errors_1.errorMessage)(error)}`);
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' });
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
                        const next = await specs.setPhaseStatus(data.phase, 'approved');
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
                        const next = await specs.resetFromPhase(data.phase);
                        this._view?.webview.postMessage({ type: 'phaseStateUpdated', phaseState: next });
                        vscode.window.showInformationMessage(`↩️ ${data.phase} rejected. Regenerate when ready.`);
                    }
                    break;
                }
                case "updateRequirements": {
                    this._activeRequirements = data.text;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        try {
                            await new SpecManager_1.SpecManager(rootUri).writeRequirements(data.text);
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
                            await new SpecManager_1.SpecManager(rootUri).writeDesign(data.text);
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
                    await (0, container_1.getDeps)().state.update('nexus_task_statuses', {});
                    await (0, container_1.getDeps)().state.update('nexus_task_summaries', {});
                    await (0, container_1.getDeps)().state.update('nexus_task_files', {});
                    break;
                case "saveApiKey":
                    await (0, container_1.getDeps)().secrets.store('nexuscode_apikey', data.value);
                    vscode.window.showInformationMessage((0, i18n_1.t)("api_key.saved_securely"));
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
                        }
                        else {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing intent..." });
                        }
                        const intent = await (0, llmService_1.determineIntent)(data.text);
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
                            const [lspContext, styleGuideMsgs, astContext, hybridContext] = await Promise.all([
                                (0, lspContext_1.getLspContext)(data.text),
                                (0, styleContext_1.getProjectStyleGuides)(),
                                (0, codeGraph_1.getSmartASTContext)(data.text),
                                (0, hybridSearch_1.retrieveHybridContext)(data.text, 5)
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
                            const result = await (0, llmService_1.generatePlan)(fullPrompt, finalContext);
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
                            this._view?.webview.postMessage({ type: 'startChatStream' });
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
                case "executeTask": {
                    const originalTaskQuery = data.prompt || data.task;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
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
                                approaches = await (0, llmService_1.generateMCTSApproaches)(originalTaskQuery, "Generating alternative architectures...");
                            }
                            let success = false;
                            let finalMergedFilepath = "";
                            for (let i = 0; i < approaches.length; i++) {
                                if (success || token.isCancellationRequested)
                                    break;
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
                                    const finalDiffs = await (0, Coordinator_1.runTask)({
                                        env,
                                        task: currentApproachPrompt,
                                        workspaceRoot: rootUri.fsPath,
                                        activeRequirements: this._activeRequirements,
                                        activeDesign: this._activeDesign,
                                        previousFailures,
                                        globalRules,
                                        log: (msg, stepType, details) => {
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
                                        streamCallback: (streamToken) => {
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: streamToken });
                                        },
                                        ...(this._activeTaskController?.signal ? { abortSignal: this._activeTaskController.signal } : {}),
                                        usageCallback: (usage) => {
                                            this._view?.webview.postMessage({ type: 'tokenUsage', task: data.task, usage });
                                        },
                                        // Lifecycle event emitter for tool calls.
                                        // Lazily-constructed; sink is webview
                                        // postMessage. The 'toolCallEvent'
                                        // messages are consumed by the rich
                                        // tool-call cards in the webview.
                                        toolEventEmitter: this.getToolEventEmitter(),
                                    });
                                    if (!finalDiffs || finalDiffs.length === 0)
                                        throw new Error("Swarm failed to generate verified code.");
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
                                        const mergedHeader = (0, commentStyles_1.getAIHeader)(realFilepath, currentApproachPrompt, fileContent) + "\n";
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
                                    await new SpecManager_1.SpecManager(rootUri).markTaskCompleted(data.taskTitle ?? data.task);
                                }
                                catch (e) {
                                    logger_1.log.warn("Could not auto-update tasks.md", e);
                                }
                                // Trigger the green checkmark
                                this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: "approved", filepath: finalMergedFilepath, summary: `Updated ${finalMergedFilepath} (Total: ${totalTime}s)` });
                                // Guarantee state sync
                                this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `Updated ${finalMergedFilepath}` });
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
                        if (fileNames.includes('pom.xml'))
                            buildCommand = "mvn clean compile";
                        else if (fileNames.includes('build.gradle'))
                            buildCommand = "gradle build -x test";
                        else if (fileNames.includes('go.mod'))
                            buildCommand = "go build ./...";
                        else if (fileNames.includes('requirements.txt'))
                            buildCommand = "python -m compileall .";
                        else if (fileNames.includes('tsconfig.json'))
                            buildCommand = "npx -p typescript tsc --noEmit";
                        else if (fileNames.includes('package.json'))
                            buildCommand = "npm run build";
                        else
                            buildCommand = "echo 'No standard build file found (e.g., tsconfig.json, pom.xml). Skipping build.'";
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
                    if (!workspaceFolders)
                        return;
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
                            for (const doc of dirtyDocs)
                                await doc.save();
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
                            if (parsedPath.ext === '.go')
                                testFileName = `${parsedPath.name}_test.go`;
                            else if (parsedPath.ext === '.py')
                                testFileName = `test_${parsedPath.name}.py`;
                            else if (parsedPath.ext === '.rs')
                                testFileName = `${parsedPath.name}_test.rs`;
                            else if (parsedPath.ext === '.java')
                                testFileName = `${parsedPath.name.charAt(0).toUpperCase() + parsedPath.name.slice(1)}Test.java`;
                            else if (parsedPath.ext === '.rb')
                                testFileName = `test_${parsedPath.name}.rb`;
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
                    if (!workspaceFolders)
                        return;
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
                        if (!result)
                            break;
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
                                for (const doc of dirtyDocs)
                                    await doc.save();
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
                case "approveCommand": {
                    if (this._pendingCommandResolver)
                        this._pendingCommandResolver(true);
                    break;
                }
                case "rejectCommand": {
                    if (this._pendingCommandResolver)
                        this._pendingCommandResolver(false);
                    break;
                }
                case "generateProjectTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
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