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
const extension_1 = require("./extension");
const codeGraph_1 = require("./context/codeGraph");
const skillsManager_1 = require("./skillsManager");
const Coordinator_1 = require("./agents/Coordinator");
// AI Services & Tools
const llmService_1 = require("./llmService");
// Context Managers
const projectContext_1 = require("./projectContext");
const lspContext_1 = require("./context/lspContext");
const styleContext_1 = require("./context/styleContext");
const ragIndexer_1 = require("./context/ragIndexer");
const hybridSearch_1 = require("./context/hybridSearch");
const commentStyles_1 = require("./utilities/commentStyles");
const pathUtils_1 = require("./utilities/pathUtils");
const workspaceManager_1 = require("./workspaceManager");
// --- CORE INJECTION ENGINE ---
function injectCodeIntoContent(originalContent, target, newCode, action) {
    let cleanedCode = newCode
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/<\/?(target|filepath|action|plan|reasoning|command|self_critique)[^>]*>/gi, '')
        .trim();
    if (action === 'replace')
        return cleanedCode;
    if (action === 'append')
        return originalContent + "\n\n" + cleanedCode;
    if (!target)
        return originalContent + "\n\n" + cleanedCode;
    const lines = originalContent.split('\n');
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(target)) {
            startIdx = i;
            break;
        }
    }
    if (startIdx === -1) {
        throw new Error(`Target "${target}" not found in file. Aborting injection to prevent code corruption.`);
    }
    if (action === 'insert_before') {
        const before = lines.slice(0, startIdx).join('\n');
        const after = lines.slice(startIdx).join('\n');
        return before + "\n" + cleanedCode + "\n\n" + after;
    }
    let endIdx = startIdx;
    let braces = 0;
    let foundBrace = false;
    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        for (let char of line) {
            if (char === '{') {
                braces++;
                foundBrace = true;
            }
            if (char === '}') {
                braces--;
            }
        }
        if (foundBrace && braces === 0) {
            endIdx = i;
            break;
        }
    }
    const before = lines.slice(0, startIdx).join('\n');
    const after = lines.slice(endIdx + 1).join('\n');
    return before + "\n" + cleanedCode + "\n" + after;
}
class SidebarProvider {
    _extensionUri;
    _view;
    _tracker;
    _terminalManager;
    _metaManager;
    // --- State Management ---
    _activeTaskController;
    _activeRequirements = "";
    _activeDesign = "";
    _lastActiveFile;
    _isMetaMode = false;
    _undoStack = new Map();
    _pendingCommandResolver;
    _diffProvider;
    _lensProvider;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    setTerminalManager(manager) { this._terminalManager = manager; }
    setProvenanceTracker(tracker) { this._tracker = tracker; }
    setMetaManager(manager) { this._metaManager = manager; }
    setDiffProvider(provider) { this._diffProvider = provider; }
    setCodeLensProvider(provider) { this._lensProvider = provider; }
    // --- TELEMETRY PROTOCOL ---
    // HK IPD Patent Claim: Centralized asynchronous event emission standardizing UI/Engine communication
    emit(type, payload = {}) {
        if (this._view) {
            this._view.webview.postMessage({ type, ...payload });
        }
    }
    sendMessageToWebview(message) {
        if (this._view)
            this._view.webview.postMessage(message);
        else
            vscode.window.showInformationMessage("Please open the NexusCode sidebar first.");
    }
    injectTerminalTask(prompt) {
        this.emit('injectTerminalTask', { task: prompt });
    }
    toggleMetaMode() {
        this._isMetaMode = !this._isMetaMode;
        const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
        vscode.window.showWarningMessage(`Switched to: ${mode}`);
        this.emit('metaModeChanged', { value: this._isMetaMode });
    }
    async getTargetContext() {
        if (this._isMetaMode)
            return this._extensionUri.fsPath;
        return vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
    }
    // --- SECURITY & EXECUTION LAYER ---
    async confirmAndRunCommand(command, workspacePath, progressMessage, isAutopilot = false, onStream) {
        this.emit('statusUpdate', { message: `🛡️ Security Monitor inspecting command...` });
        const isMalicious = await (0, llmService_1.askSecurityMonitor)(command);
        if (isMalicious) {
            vscode.window.showErrorMessage(`🚨 Nexus Security Firewall BLOCKED a malicious command: ${command}`);
            this.emit('statusUpdate', { message: `🚨 Command Blocked by Security Monitor.` });
            return { success: false, output: "SECURITY_BLOCK" };
        }
        if (isAutopilot || this._isMetaMode) {
            this.emit('statusUpdate', { message: `🤖 Autopilot Executing: ${command}` });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath, onStream);
        }
        const isApproved = await new Promise((resolve) => {
            this._pendingCommandResolver = resolve;
            this.emit('requestCommandApproval', { command: command, message: progressMessage });
        });
        this._pendingCommandResolver = undefined;
        if (isApproved) {
            this.emit('statusUpdate', { message: progressMessage });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath, onStream);
        }
        else {
            vscode.window.showInformationMessage("Command execution blocked by user.");
            return { success: false, output: "USER_BLOCKED" };
        }
    }
    // --- WEBVIEW INITIALIZATION & ROUTER BINDING ---
    async resolveWebviewView(webviewView) {
        this._view = webviewView;
        this._tracker?.setView(webviewView);
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        // Map incoming messages to discrete handler methods
        webviewView.webview.onDidReceiveMessage(async (data) => {
            try {
                await this.routeTelemetryEvent(data);
            }
            catch (error) {
                console.error("[Nexus Router Error]", error);
                vscode.window.showErrorMessage(`Nexus Error: ${error.message}`);
                this.emit('statusUpdate', { message: "" });
            }
        });
    }
    // --- THE ASYNCHRONOUS TELEMETRY ROUTER ---
    async routeTelemetryEvent(data) {
        const routes = {
            'webviewReady': () => this.handleWebviewReady(),
            'requestWorkspaceGraph': () => this.handleRequestWorkspaceGraph(),
            'saveNexusRules': () => this.handleSaveNexusRules(data),
            'verifyTask': () => this.handleVerifyTask(data),
            'generateRequirements': () => this.handleGenerateRequirements(data),
            'generateDesign': () => this.handleGenerateDesign(data),
            'generateProjectTasks': () => this.handleGenerateProjectTasks(data),
            'requestRevision': () => this.handleRequestRevision(data),
            'updateRequirements': () => this.handleUpdateRequirements(data),
            'updateDesign': () => this.handleUpdateDesign(data),
            'syncHistory': () => this.handleSyncHistory(data),
            'clearHistory': () => this.handleClearHistory(),
            'saveApiKey': () => this.handleSaveApiKey(data),
            'processUserMessage': () => this.handleProcessUserMessage(data),
            'cancelTask': () => this.handleCancelTask(),
            'executeTask': () => this.handleExecuteTask(data),
            'refreshCodeLens': () => this.handleRefreshCodeLens(),
            'undoTaskEdit': () => this.handleUndoTaskEdit(data),
            'runGlobalCompiler': () => this.handleRunGlobalCompiler(data),
            'searchFiles': () => this.handleSearchFiles(data),
            'showDiff': () => this.handleShowDiff(data),
            'openFile': () => this.handleOpenFile(data),
            'readFileContext': () => this.handleReadFileContext(data),
            'executeAllTasks': () => this.handleExecuteAllTasks(data),
            'commitAtomicEdits': () => this.handleCommitAtomicEdits(data),
            'generateAndRunTests': () => this.handleGenerateAndRunTests(data),
            'executeCommand': () => this.handleExecuteCommand(data),
            'requestModels': () => this.handleRequestModels(),
            'setModel': () => this.handleSetModel(data),
            'approveCommand': () => this.handleApproveCommand(),
            'rejectCommand': () => this.handleRejectCommand()
        };
        if (routes[data.type]) {
            await routes[data.type]();
        }
        else {
            console.warn(`[Nexus Router] Unhandled telemetry event type: ${data.type}`);
        }
    }
    // --- DISCRETE HANDLER IMPLEMENTATIONS ---
    async handleWebviewReady() {
        const chatHistory = extension_1.globalContext.globalState.get('nexus_chat_history') || [];
        const taskStatuses = extension_1.globalContext.globalState.get('nexus_task_statuses') || {};
        const taskSummaries = extension_1.globalContext.globalState.get('nexus_task_summaries') || {};
        const taskFiles = extension_1.globalContext.globalState.get('nexus_task_files') || {};
        const hasApiKey = !!(await extension_1.globalContext.secrets.get('nexuscode_apikey'));
        let savedReqs = "";
        let savedDesign = "";
        let savedTasks = null;
        let savedRules = "";
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const rootUri = workspaceFolders[0].uri;
            (0, codeGraph_1.buildWorkspaceGraph)(rootUri).catch(e => console.error("CodeGraph init failed:", e));
            const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
            try {
                savedReqs = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'requirements.md')));
                this._activeRequirements = savedReqs;
            }
            catch (e) { }
            try {
                savedDesign = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'design.md')));
                this._activeDesign = savedDesign;
            }
            catch (e) { }
            try {
                savedTasks = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'))));
            }
            catch (e) { }
            try {
                savedRules = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, '.nexusrules')));
            }
            catch (e) { }
        }
        this.emit('initState', {
            messages: chatHistory,
            taskStatuses,
            taskSummaries,
            taskFiles,
            requirements: savedReqs,
            design: savedDesign,
            tasks: savedTasks,
            nexusRules: savedRules,
            hasKey: hasApiKey
        });
    }
    async handleRequestWorkspaceGraph() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
        const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
        this.emit('statusUpdate', { message: 'Nexus: Indexing AST Code Map...' });
        try {
            let rawCodeGraph = (0, codeGraph_1.getGraphJSON)();
            if (!rawCodeGraph || rawCodeGraph === '{}') {
                await (0, codeGraph_1.buildWorkspaceGraph)(rootUri);
                rawCodeGraph = (0, codeGraph_1.getGraphJSON)();
            }
            let codeGraph = {};
            if (rawCodeGraph) {
                try {
                    codeGraph = typeof rawCodeGraph === 'string' ? JSON.parse(rawCodeGraph) : rawCodeGraph;
                }
                catch (e) { }
            }
            let normalizedCodeGraph = { nodes: [], edges: [] };
            Object.entries(codeGraph).forEach(([filepath, data]) => {
                if (filepath === 'nodes' || filepath === 'edges')
                    return;
                normalizedCodeGraph.nodes.push({ id: filepath, label: filepath.split('/').pop(), group: 'file' });
                if (data.imports) {
                    data.imports.forEach((imp) => {
                        const cleanImp = imp.replace(/['"]/g, '').replace('./', '').replace('../', '');
                        const targetFile = Object.keys(codeGraph).find(k => k.includes(cleanImp));
                        if (targetFile)
                            normalizedCodeGraph.edges.push({ source: filepath, target: targetFile });
                    });
                }
            });
            this.emit('workspaceGraphData', {
                data: { codeMap: codeGraph, reqMap: null, combinedMap: null, isGraphLoading: true }
            });
            this.emit('statusUpdate', { message: 'Nexus: Parsing Traceability Matrix (LLM)...' });
            let reqGraph = { nodes: [], edges: [] };
            try {
                const { parseRequirementGraph } = await import('./context/traceabilityGraph.js');
                const reqString = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'requirements.md')));
                reqGraph = await parseRequirementGraph(reqString);
            }
            catch (e) { }
            let designGraph = { nodes: [], edges: [] };
            try {
                const { parseDesignGraph } = await import('./context/traceabilityGraph.js');
                const designString = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'design.md')));
                designGraph = await parseDesignGraph(designString);
            }
            catch (e) { }
            let tasksJson = null;
            try {
                tasksJson = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'))));
            }
            catch (e) { }
            let combinedGraph = { nodes: [...normalizedCodeGraph.nodes], edges: [...normalizedCodeGraph.edges] };
            try {
                const { buildCombinedGraph } = await import('./context/traceabilityGraph.js');
                combinedGraph = buildCombinedGraph(normalizedCodeGraph, reqGraph, designGraph, tasksJson);
            }
            catch (e) { }
            this.emit('workspaceGraphData', {
                data: { codeMap: codeGraph, reqMap: reqGraph, combinedMap: combinedGraph, isGraphLoading: false }
            });
            this.emit('statusUpdate', { message: '' });
        }
        catch (error) {
            this.emit('workspaceGraphData', {
                data: { codeMap: {}, reqMap: { nodes: [], edges: [] }, combinedMap: { nodes: [], edges: [] }, isGraphLoading: false }
            });
            this.emit('statusUpdate', { message: 'Failed to load maps.' });
        }
    }
    async handleSaveNexusRules(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
        const rulesUri = vscode.Uri.joinPath(rootUri, '.nexusrules');
        try {
            await vscode.workspace.fs.writeFile(rulesUri, Buffer.from(data.text, 'utf8'));
            vscode.window.showInformationMessage("✨ Nexus Skills & Rules successfully saved!");
        }
        catch (e) {
            vscode.window.showErrorMessage("Failed to save .nexusrules");
        }
    }
    async handleVerifyTask(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        this.emit('taskStatusUpdate', { task: data.task, status: 'reviewing', summary: 'Gathering context to verify your code...' });
        try {
            const taskQuery = data.prompt || data.task;
            const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
            const [astContext, hybridContext] = await Promise.all([
                (0, codeGraph_1.getSmartASTContext)(taskQuery),
                (0, hybridSearch_1.retrieveHybridContext)(taskQuery, 5)
            ]);
            const fullContext = `${astContext}\n\n${hybridContext}`;
            this.emit('taskStatusUpdate', { task: data.task, status: 'reviewing', summary: 'AI QA is checking your work against PRD...' });
            const verification = await (0, llmService_1.askQwenToVerifyTask)(taskQuery, this._activeRequirements, fullContext);
            if (verification.verified) {
                const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                const tasksMdUri = vscode.Uri.joinPath(nexusDir, 'tasks.md');
                try {
                    let mdContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(tasksMdUri));
                    mdContent = mdContent.replace(`[ ] **${data.task}**`, `[x] **${data.task}**`).replace(`[ ] ${data.task}`, `[x] ${data.task}`);
                    await vscode.workspace.fs.writeFile(tasksMdUri, Buffer.from(mdContent, 'utf8'));
                }
                catch (e) { }
                try {
                    if (this._activeRequirements) {
                        this.emit('statusUpdate', { message: `Nexus QA: Scanning your code to update Living PRD...` });
                        const reqMdUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'requirements.md');
                        let currentPRD = this._activeRequirements;
                        const prdUpdates = await (0, llmService_1.askQwenToUpdatePRD)(currentPRD, data.task, "Manual Code Edit", fullContext);
                        if (prdUpdates.length > 0) {
                            prdUpdates.forEach(update => { currentPRD = currentPRD.replace(update.original, update.updated); });
                            await vscode.workspace.fs.writeFile(reqMdUri, Buffer.from(currentPRD, 'utf8'));
                            this._activeRequirements = currentPRD;
                            this.emit('requirementsUpdated', { text: currentPRD });
                        }
                    }
                }
                catch (e) { }
                this.emit('taskStatusUpdate', { task: data.task, status: 'approved', summary: `✅ VERIFIED: ${verification.reasoning}` });
                this.emit('statusUpdate', { message: "" });
            }
            else {
                this.emit('taskStatusUpdate', { task: data.task, status: 'rejected', summary: `❌ REJECTED: ${verification.reasoning}` });
            }
        }
        catch (error) {
            this.emit('taskStatusUpdate', { task: data.task, status: 'error', summary: `Verification Error: ${error.message}` });
        }
    }
    async handleGenerateRequirements(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        this._activeTaskController = new AbortController();
        this.emit('reqStep', { message: '━━━ Step 1: Understanding your request & building feature discovery prompt ━━━' });
        try {
            this.emit('reqStep', { message: '━━━ Step 2: Drafting Agile User Stories & Acceptance Criteria ━━━' });
            const reqPlan = await (0, llmService_1.askQwenForRequirements)(data.text, data.context, this._activeTaskController.signal);
            this.emit('reqStep', { message: `Project:      ${reqPlan.projectName}` });
            this.emit('reqStep', { message: `Domain:       ${reqPlan.domain}` });
            this.emit('reqStep', { message: `Stories:      ${reqPlan.userStories.length} generated` });
            let enrichedPrompt = `---\nversion: 1.0.0\ntype: prd\nproject: "${reqPlan.projectName}"\ndomain: "${reqPlan.domain}"\n---\n\n# 📋 Product Requirements Document (PRD)\n\n<metadata>\n  <target_audience>${reqPlan.targetAudience}</target_audience>\n</metadata>\n\n## 🎯 Agile User Stories\n\n`;
            reqPlan.userStories.forEach((us, eIdx) => {
                const epicId = `EPIC-${(eIdx + 1).toString().padStart(2, '0')}`;
                const storyId = `STORY-${epicId}-1`;
                enrichedPrompt += `<epic id="${epicId}" name="${us.epic || 'General'}">\n### ${epicId}: ${us.epic || 'General'}\n\n<story id="${storyId}">\n**Story:** ${us.story || 'N/A'}\n\n**Acceptance Criteria:**\n`;
                const criteria = Array.isArray(us.acceptanceCriteria) ? us.acceptanceCriteria : [us.acceptanceCriteria];
                criteria.forEach((ac, cIdx) => { enrichedPrompt += `- [ ] <criteria id="${storyId}-C${cIdx + 1}">${ac}</criteria>\n`; });
                enrichedPrompt += `</story>\n</epic>\n\n`;
            });
            enrichedPrompt += `## 🛡️ Non-Functional Requirements (NFRs)\n<nfr_list>\n`;
            reqPlan.nonFunctionalRequirements.forEach((nfr) => { enrichedPrompt += `- ${nfr}\n`; });
            enrichedPrompt += `</nfr_list>\n`;
            const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
            const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
            const reqFileUri = vscode.Uri.joinPath(nexusDir, 'requirements.md');
            try {
                await vscode.workspace.fs.createDirectory(nexusDir);
            }
            catch (e) { }
            await vscode.workspace.fs.writeFile(reqFileUri, Buffer.from(enrichedPrompt, 'utf8'));
            this._activeRequirements = enrichedPrompt;
            this.emit('reqStep', { message: `✅ Saved requirements.md` });
            this.emit('requirementsGenerated', { text: enrichedPrompt });
        }
        catch (error) {
            this.emit('reqStep', { message: error.name === 'AbortError' ? `\n🛑 Cancelled by User.` : `\n❌ Error: ${error.message}` });
            this.emit('generationFailed');
        }
        finally {
            this._activeTaskController = undefined;
        }
    }
    async handleGenerateDesign(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        this._activeTaskController = new AbortController();
        this.emit('reqStep', { message: '\n━━━ Step 4: Architecting System Design ━━━\nAnalyzing approved PRD and drafting architecture...\n' });
        try {
            const designDoc = await (0, llmService_1.askQwenForDesign)(data.requirements, this._activeTaskController.signal);
            const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
            const designFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'design.md');
            await vscode.workspace.fs.writeFile(designFileUri, Buffer.from(designDoc, 'utf8'));
            this._activeDesign = designDoc;
            this.emit('reqStep', { message: `✅ Saved design.md` });
            this.emit('designGenerated', { text: designDoc });
        }
        catch (error) {
            this.emit('reqStep', { message: error.name === 'AbortError' ? `\n🛑 Architecting Cancelled by User.` : `\n❌ Error: ${error.message}` });
            this.emit('generationFailed');
        }
        finally {
            this._activeTaskController = undefined;
        }
    }
    async handleGenerateProjectTasks(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        this._activeTaskController = new AbortController();
        this.emit('statusUpdate', { message: "Nexus: Drafting Master Implementation Plan..." });
        this.emit('startChatStream');
        try {
            const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
            const projectContext = await (0, projectContext_1.getProjectContext)(rootUri.fsPath);
            const plan = await (0, llmService_1.askQwenForProjectTasks)(this._activeRequirements, this._activeDesign, projectContext, this._activeTaskController.signal);
            const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'), Buffer.from(JSON.stringify(plan, null, 2), 'utf8'));
            let mdContent = `---\nversion: 1.0.0\ntype: implementation_plan\nstatus: draft\n---\n\n# Master Implementation Plan\n\n## 📁 Folder Structure\n<folder_structure>\n`;
            plan.folderStructure.forEach((f) => mdContent += `- \`${f}\`\n`);
            mdContent += `</folder_structure>\n\n## 🛠️ Execution Tasks\n<tasks>\n`;
            plan.implementationTasks.forEach((t, i) => {
                const taskId = `TASK-${(i + 1).toString().padStart(3, '0')}`;
                const prevTaskId = i > 0 ? `TASK-${(i).toString().padStart(3, '0')}` : 'none';
                if (typeof t === 'string') {
                    mdContent += `<task id="${taskId}" dependsOn="${prevTaskId}">\n${i + 1}. [ ] ${t}\n</task>\n\n`;
                }
                else {
                    mdContent += `<task id="${taskId}" dependsOn="${prevTaskId}" targetFile="${t.file}" relatesTo="${t.relatedRequirement || ''}">\n${i + 1}. [ ] **${t.step}** (File: \`${t.file}\`)\n   - *Instructions:* <instructions>${t.detailedInstructions}</instructions>\n</task>\n\n`;
                }
            });
            mdContent += `</tasks>\n`;
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(nexusDir, 'tasks.md'), Buffer.from(mdContent, 'utf8'));
            const { finalPaths, renamingMap } = await (0, pathUtils_1.resolveCanonicalPaths)(plan.folderStructure, rootUri.fsPath);
            plan.folderStructure = finalPaths;
            plan.implementationTasks = plan.implementationTasks.map((task) => {
                if (typeof task === 'string')
                    return task;
                let updatedTask = { ...task };
                renamingMap.forEach((realPath, plannedPath) => {
                    if (updatedTask.file === plannedPath)
                        updatedTask.file = realPath;
                    if (updatedTask.detailedInstructions.includes(plannedPath))
                        updatedTask.detailedInstructions = updatedTask.detailedInstructions.replace(plannedPath, realPath);
                });
                return updatedTask;
            });
            if (plan.folderStructure.length > 0)
                await (0, workspaceManager_1.createWorkspaceStructure)(plan.folderStructure);
            this.emit('chatToken', { token: "I have analyzed the PRD and System Architecture. Here is the master implementation plan.\n\n" });
            this.emit("structureResponse", { value: plan });
            this.emit('tasksGenerated');
        }
        catch (error) {
            if (error.name === 'AbortError')
                this.emit('statusUpdate', { message: `🛑 Planning Cancelled.` });
            else
                vscode.window.showErrorMessage(`Failed to generate tasks: ${error.message}`);
            this.emit('generationFailed');
        }
        finally {
            this._activeTaskController = undefined;
            this.emit('statusUpdate', { message: "" });
        }
    }
    async handleRequestRevision(data) {
        const feedback = await vscode.window.showInputBox({
            prompt: `Why was the code for "${data.task}" rejected?`,
            placeHolder: "e.g., 'Use axios instead of fetch'"
        });
        if (feedback === undefined)
            return;
        this.emit('startRevision', { task: data.task, feedback: feedback || "Try a different approach and ensure bug-free code." });
    }
    async handleUpdateRequirements(data) {
        this._activeRequirements = data.text;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && data.text.trim()) {
            try {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri, 'nexuscode', 'requirements.md'), Buffer.from(data.text, 'utf8'));
            }
            catch (e) { }
        }
        else if (data.text === "") {
            this._activeRequirements = "";
            this._activeDesign = "";
        }
    }
    async handleUpdateDesign(data) {
        this._activeDesign = data.text;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && data.text.trim()) {
            try {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri, 'nexuscode', 'design.md'), Buffer.from(data.text, 'utf8'));
            }
            catch (e) { }
        }
    }
    async handleSyncHistory(data) {
        let historyToSave = data.messages;
        if (historyToSave.length > 15) {
            this.emit('statusUpdate', { message: "🗜️ Nexus is compacting context memory..." });
            try {
                const RECENT_KEEP_COUNT = 5;
                const messagesToCompact = historyToSave.slice(0, historyToSave.length - RECENT_KEEP_COUNT);
                const recentMessages = historyToSave.slice(historyToSave.length - RECENT_KEEP_COUNT);
                const summary = await (0, llmService_1.compactConversationHistory)(messagesToCompact);
                historyToSave = [{ role: 'assistant', isCompacted: true, content: summary }, ...recentMessages];
                this.emit('historyCompacted', { messages: historyToSave });
            }
            catch (e) { }
            finally {
                this.emit('statusUpdate', { message: "" });
            }
        }
        await extension_1.globalContext.globalState.update('nexus_chat_history', historyToSave);
        await extension_1.globalContext.globalState.update('nexus_task_statuses', data.taskStatuses);
        await extension_1.globalContext.globalState.update('nexus_task_summaries', data.taskSummaries);
        await extension_1.globalContext.globalState.update('nexus_task_files', data.taskFiles);
    }
    async handleClearHistory() {
        await extension_1.globalContext.globalState.update('nexus_chat_history', []);
        await extension_1.globalContext.globalState.update('nexus_task_statuses', {});
        await extension_1.globalContext.globalState.update('nexus_task_summaries', {});
        await extension_1.globalContext.globalState.update('nexus_task_files', {});
    }
    async handleSaveApiKey(data) {
        await extension_1.globalContext.secrets.store('nexuscode_apikey', data.value);
        vscode.window.showInformationMessage("NexusCode: API Key Saved Securely!");
        this.emit('initState', { messages: [], hasKey: true });
    }
    async handleProcessUserMessage(data) {
        this._activeTaskController = new AbortController();
        try {
            const workspacePath = await this.getTargetContext();
            await skillsManager_1.SkillsManager.initializeSkillsDirectory(workspacePath);
            const skillResult = await skillsManager_1.SkillsManager.processSkill(workspacePath, data.text);
            let actualPromptText = data.text;
            if (skillResult.isSkill) {
                this.emit('statusUpdate', { message: `✨ Executing Custom Skill...` });
                actualPromptText = skillResult.skillPrompt;
            }
            else {
                this.emit('statusUpdate', { message: "Nexus: Analyzing intent..." });
            }
            const intent = await (0, llmService_1.determineIntent)(data.text);
            const fullPrompt = data.context ? `--- ATTACHED CONTEXT ---\n${data.context}\n\n--- USER QUERY ---\n${data.text}` : data.text;
            if (intent === 'build') {
                this.emit('statusUpdate', { message: "Nexus: Architecting plan..." });
                this.emit('startChatStream');
                await (0, ragIndexer_1.indexWorkspace)((msg) => this.emit('statusUpdate', { message: msg }));
                const [lspContext, styleGuide, astContext, hybridContext] = await Promise.all([
                    (0, lspContext_1.getLspContext)(data.text), (0, styleContext_1.getProjectStyleGuides)(), (0, codeGraph_1.getSmartASTContext)(data.text), (0, hybridSearch_1.retrieveHybridContext)(data.text, 5)
                ]);
                const reqInj = this._activeRequirements ? `\n--- 📋 STRICT BUSINESS REQUIREMENTS ---\n${this._activeRequirements}\n` : "";
                const desInj = this._activeDesign ? `\n--- 🏗️ SYSTEM ARCHITECTURE ---\n${this._activeDesign}\n` : "";
                const finalContext = `${lspContext}\n\n${astContext}\n\n${hybridContext}\n\n${styleGuide}${reqInj}${desInj}`;
                const result = await (0, llmService_1.askQwenForStructure)(fullPrompt, finalContext);
                this.emit('chatToken', { token: result.explanation + "\n\n" });
                const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                const { finalPaths, renamingMap } = await (0, pathUtils_1.resolveCanonicalPaths)(result.plan.folderStructure, rootSearchPath);
                result.plan.folderStructure = finalPaths;
                result.plan.implementationTasks = result.plan.implementationTasks.map(task => {
                    let updatedTask = task;
                    renamingMap.forEach((realPath, plannedPath) => {
                        const plannedName = path.basename(plannedPath);
                        if (typeof updatedTask === 'string') {
                            if (updatedTask.includes(plannedPath))
                                updatedTask = updatedTask.replace(plannedPath, realPath);
                            else if (updatedTask.includes(plannedName))
                                updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`);
                        }
                    });
                    return updatedTask;
                });
                if (result.plan.folderStructure.length > 0)
                    await (0, workspaceManager_1.createWorkspaceStructure)(result.plan.folderStructure);
                this.emit("structureResponse", { value: result.plan });
            }
            else if (intent === 'explore') {
                this.emit('statusUpdate', { message: "🔍 Agentic Exploration: Investigating..." });
                const exploreTaskId = "Exploration-" + Date.now();
                this.emit('taskStatusUpdate', { task: exploreTaskId, status: 'reviewing', summary: 'Gathering forensic evidence...' });
                const explorationContext = await (0, llmService_1.runAgenticExploration)(data.text, workspacePath, (stepType, desc, details) => this.emit('agentStep', { task: exploreTaskId, stepType, description: desc, details }));
                this.emit('statusUpdate', { message: "Nexus: Analyzing evidence..." });
                this.emit('startChatStream');
                const fullContext = `--- FORENSIC EVIDENCE GATHERED BY TOOLS ---\n${explorationContext}\n\nExplain exactly what went wrong and how to fix it.`;
                await (0, llmService_1.streamQwenChat)(data.text, fullContext, data.history || [], (token) => this.emit('chatToken', { token }), this._activeTaskController.signal);
                this.emit('taskCompleted', { task: exploreTaskId, status: 'approved', summary: 'Exploration Complete' });
            }
            else {
                this.emit('statusUpdate', { message: "Nexus: Gathering context..." });
                const ragContext = await (0, hybridSearch_1.retrieveHybridContext)(data.text, 5);
                if (ragContext)
                    this.emit('glassBrain', { text: ragContext });
                let openFilesContext = "";
                vscode.workspace.textDocuments.forEach(doc => {
                    if (doc.uri.scheme === 'file' && !doc.fileName.includes('node_modules') && !doc.fileName.includes('.git')) {
                        openFilesContext += `\n📍 OPEN FILE: ${vscode.workspace.asRelativePath(doc.uri)}\n\`\`\`\n${doc.getText().substring(0, 3000)}\n\`\`\`\n`;
                    }
                });
                let fullContext = intent === 'explain'
                    ? `Directory Tree:\n${await (0, projectContext_1.getProjectContext)(workspacePath)}\n\nOpen Files:\n${openFilesContext}\n\nRAG:\n${ragContext}`
                    : `Open Files:\n${openFilesContext}\n\nRAG:\n${ragContext}`;
                this.emit('statusUpdate', { message: "Nexus: Thinking..." });
                this.emit('startChatStream');
                await (0, llmService_1.streamQwenChat)(fullPrompt, fullContext, data.history || [], (token) => this.emit('chatToken', { token }), this._activeTaskController.signal);
            }
            this.emit('statusUpdate', { message: "" });
        }
        catch (error) {
            if (error.name === 'AbortError') {
                this.emit('statusUpdate', { message: "⚠️ Generation stopped." });
                setTimeout(() => this.emit('statusUpdate', { message: "" }), 3000);
            }
            else {
                vscode.window.showErrorMessage(`NexusCode Error: ${error.message}`);
                this.emit('taskCompleted', { status: 'error' });
            }
        }
        finally {
            this._activeTaskController = undefined;
        }
    }
    async handleCancelTask() {
        if (this._activeTaskController) {
            this._activeTaskController.abort();
            this._activeTaskController = undefined;
            this.emit('statusUpdate', { message: "⚠️ Task cancelled by user." });
            setTimeout(() => this.emit('statusUpdate', { message: "" }), 3000);
        }
    }
    async handleExecuteTask(data) {
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
        }, async (progress, token) => {
            token.onCancellationRequested(() => this._activeTaskController?.abort());
            const taskStartTime = Date.now();
            const gitCheck = await this._terminalManager?.runCommandWithCapture("git status", rootUri.fsPath);
            const isGitRepo = gitCheck && gitCheck.success;
            this.emit('statusUpdate', { message: `Nexus: Generating MCTS Execution Branches...` });
            // 1. Generate MCTS Approaches (Architectural Exploration)
            let approaches = [originalTaskQuery];
            if (isGitRepo) {
                approaches = await (0, llmService_1.generateMCTSApproaches)(originalTaskQuery, "Generating alternative architectures...");
            }
            let success = false;
            let winningApproach = 0;
            let finalMergedFilepath = "";
            for (let i = 0; i < approaches.length; i++) {
                if (success || token.isCancellationRequested)
                    break;
                const approachNum = i + 1;
                const isMCTSActive = approaches.length > 1;
                const currentApproachPrompt = isMCTSActive ? `Original Task: ${originalTaskQuery}\n\nImplementation Directive (Approach ${approachNum}):\n${approaches[i]}` : originalTaskQuery;
                const sandboxBranch = `nexus-mcts-sandbox-${Date.now()}`;
                try {
                    // Sandbox the Git environment for safe exploration
                    if (isMCTSActive) {
                        await this._terminalManager?.runCommandWithCapture(`git stash`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git checkout -b ${sandboxBranch}`, rootUri.fsPath);
                    }
                    let previousFailures = "";
                    try {
                        const failData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, 'nexuscode', 'NEXUS_FAILURES.md'));
                        previousFailures = new TextDecoder().decode(failData);
                    }
                    catch { }
                    const currentFileContent = "";
                    const lspBlastRadiusContext = "LSP Context dynamic fetch handled by Swarm.";
                    // 2. TRIGGER THE SWARM ORCHESTRATOR
                    const finalDiff = await Coordinator_1.SwarmCoordinator.executeTask(currentApproachPrompt, rootUri.fsPath, currentFileContent, lspBlastRadiusContext, this._activeRequirements, this._activeDesign, previousFailures, data.codingStyle || 'precise', (msg, stepType, details) => {
                        // Stream telemetry to React UI
                        this.emit('statusUpdate', { message: msg });
                        if (stepType && details) {
                            this.emit('agentStep', {
                                task: data.task,
                                stepType: stepType,
                                description: msg.replace('Coordinator: ', ''),
                                details: details
                            });
                        }
                    }, (streamToken) => {
                        this.emit('streamReasoning', { task: data.task, token: streamToken });
                    });
                    if (!finalDiff)
                        throw new Error("Swarm failed to generate verified code.");
                    const realFilepath = finalDiff.filepath;
                    const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);
                    // 3. READ ORIGINAL CONTENT (For Native Diffing)
                    let originalFileContent = "";
                    try {
                        const fileData = await vscode.workspace.fs.readFile(fileUri);
                        originalFileContent = new TextDecoder().decode(fileData);
                    }
                    catch {
                        // File doesn't exist yet, create a blank placeholder
                        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                    }
                    // 4. REGISTER VIRTUAL DOCUMENT FOR NATIVE DIFF
                    if (this._diffProvider) {
                        this._diffProvider.registerOriginalContent(fileUri, originalFileContent);
                    }
                    // 5. INJECT AND FORMAT THE NEW CODE
                    const finalPerfectCode = injectCodeIntoContent(originalFileContent, finalDiff.targetLine || '', finalDiff.code, finalDiff.action);
                    const mergedHeader = (0, commentStyles_1.getAIHeader)(realFilepath, currentApproachPrompt, originalFileContent) + "\n";
                    const finalCodePayload = mergedHeader + finalPerfectCode;
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const editor = await vscode.window.showTextDocument(document, { preview: false });
                    await editor.edit(b => {
                        b.delete(new vscode.Range(0, 0, document.lineCount, 0));
                        b.insert(new vscode.Position(0, 0), finalCodePayload);
                    });
                    // 6. TRIGGER THE INLINE CODELENS (The Mutative Action Gate)
                    if (this._lensProvider) {
                        this._lensProvider.addPendingReview(fileUri, new vscode.Range(0, 0, document.lineCount, 0), data.task);
                    }
                    // Save the document so Linter/Adversarial tests can run against disk
                    await document.save();
                    // Register with Provenance Tracker for HK IPD Compliance
                    if (this._tracker) {
                        this._tracker.trackStreamedReview(editor, originalFileContent, data.task, 0, document.lineCount);
                    }
                    // 7. AUTO-OPEN THE SPLIT-PANE NATIVE DIFF VIEW
                    const originalDiffUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);
                    await vscode.commands.executeCommand('vscode.diff', originalDiffUri, fileUri, `Review: ${path.basename(fileUri.fsPath)}`, { preview: true, viewColumn: vscode.ViewColumn.Beside });
                    // 8. MCTS SUCCESS MERGE
                    if (isMCTSActive) {
                        await this._terminalManager?.runCommandWithCapture(`git add . && git commit -m "chore: nexus mcts approach ${approachNum}"`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git checkout -`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git merge ${sandboxBranch} --squash`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git branch -D ${sandboxBranch}`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git stash pop`, rootUri.fsPath);
                    }
                    success = true;
                    winningApproach = approachNum;
                    finalMergedFilepath = realFilepath;
                }
                catch (error) {
                    // MCTS Failure Rollback
                    if (isMCTSActive) {
                        await this._terminalManager?.runCommandWithCapture(`git reset --hard`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git checkout -`, rootUri.fsPath);
                        await this._terminalManager?.runCommandWithCapture(`git branch -D ${sandboxBranch}`, rootUri.fsPath);
                    }
                    else {
                        vscode.window.showErrorMessage(`Execution failed: ${error.message}`);
                    }
                }
            }
            // 9. UPDATE TELEMETRY STATE
            if (success) {
                const totalTime = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                // Architectural Note: We set status to "reviewing" rather than "approved", 
                // because the Dual-Vector Action Gate requires the human to click the CodeLens first.
                this.emit('taskCompleted', {
                    task: data.task,
                    status: "reviewing",
                    filepath: finalMergedFilepath,
                    summary: `Awaiting your approval... (Total: ${totalTime}s)`
                });
            }
            else {
                this.emit('taskCompleted', {
                    task: data.task,
                    status: 'error',
                    summary: approaches.length > 1 ? `⚠️ All ${approaches.length} MCTS Approaches Failed.` : `⚠️ Execution Failed.`
                });
            }
            this._activeTaskController = undefined;
            this.emit('statusUpdate', { message: "" });
        });
    }
    async handleRefreshCodeLens() {
        vscode.commands.executeCommand('nexuscode.refreshLens');
    }
    async handleUndoTaskEdit(data) {
        const undoData = this._undoStack.get(data.task);
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (undoData && workspaceFolders) {
            const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(rootUri, undoData.filepath);
            try {
                const edit = new vscode.WorkspaceEdit();
                const document = await vscode.workspace.openTextDocument(fileUri);
                edit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), undoData.originalContent);
                await vscode.workspace.applyEdit(edit);
                await document.save();
                vscode.window.showInformationMessage(`⏪ Undid AI edits to ${undoData.filepath}`);
                this.emit('taskStatusUpdate', { task: data.task, status: 'undone', summary: `⏪ Reverted to original state.` });
            }
            catch (e) {
                vscode.window.showErrorMessage("Failed to undo file edit.");
            }
        }
        else {
            vscode.window.showWarningMessage("No undo history found for this task.");
        }
    }
    async handleRunGlobalCompiler(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        const workspacePath = workspaceFolders[0].uri.fsPath;
        this.emit('statusUpdate', { message: "Nexus: Running Global Workspace Compiler..." });
        const result = await this._terminalManager?.runCommandWithCapture("npx tsc --noEmit", workspacePath);
        if (result && result.success) {
            vscode.window.showInformationMessage("✅ Global Compiler Passed! The app is structurally sound.");
            this.emit('statusUpdate', { message: "" });
        }
        else if (result && !result.success) {
            vscode.window.showErrorMessage("❌ Global Compiler Failed. Initializing Build-Healer...");
            this.emit('statusUpdate', { message: "Nexus: Analyzing global build failures..." });
            try {
                const matches = [...new Set(result.output.match(/([a-zA-Z0-9_\-\/\\]+\.(?:ts|tsx|js|jsx|py|go|rs|cpp|c|h|hpp|java|rb|php|cs))/g))];
                if (matches.length === 0)
                    throw new Error("Could not parse file paths from error log.");
                let brokenFilesContext = "";
                for (const file of matches) {
                    try {
                        const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceFolders[0].uri, file)));
                        brokenFilesContext += `\n--- FILE: ${file} ---\n\`\`\`\n${content}\n\`\`\`\n`;
                    }
                    catch (e) { }
                }
                this.emit('statusUpdate', { message: `Nexus: Healing ${matches.length} cross-file errors...` });
                const fixes = await (0, llmService_1.askQwenToHealGlobalBuild)(result.output, brokenFilesContext, data.codingStyle || 'precise');
                if (fixes && fixes.length > 0) {
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    for (const edit of fixes) {
                        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filepath);
                        try {
                            await vscode.workspace.fs.stat(fileUri);
                        }
                        catch {
                            await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                        }
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), (0, commentStyles_1.getAIHeader)(edit.filepath, "Build-Healer Patch") + edit.code);
                    }
                    if (await vscode.workspace.applyEdit(workspaceEdit)) {
                        vscode.workspace.textDocuments.filter(d => d.isDirty).forEach(async (doc) => await doc.save());
                        vscode.window.showInformationMessage(`✅ Build-Healer autonomously patched ${fixes.length} files!`);
                    }
                }
                else {
                    vscode.window.showWarningMessage("⚠️ Build-Healer could not determine a safe patch. Manual intervention required.");
                }
            }
            catch (error) {
                vscode.window.showErrorMessage(`Build-Healer Aborted: ${error.message}`);
                this.emit('statusUpdate', { message: `⚠️ Healer failed to parse terminal.` });
                this.emit('streamTerminal', { task: "Global Compiler", text: result.output || "No terminal output captured." });
            }
            this.emit('statusUpdate', { message: "" });
        }
    }
    async handleSearchFiles(data) {
        const cleanQuery = data.query.split(':')[0];
        const files = await vscode.workspace.findFiles(`**/*${cleanQuery}*`, '{**/node_modules/**,**/.git/**,**/dist/**}', 10);
        this.emit('searchResults', { results: files.map(f => vscode.workspace.asRelativePath(f)), originalQuery: data.query });
    }
    async handleShowDiff(data) {
        const rootUri = this._isMetaMode ? this._extensionUri : vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, data.filepath);
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(`nexus-original:${fileUri.path}`), fileUri, `NexusCode Diff: ${path.basename(data.filepath)}`);
    }
    async handleOpenFile(data) {
        const rootUri = this._isMetaMode ? this._extensionUri : vscode.workspace.workspaceFolders[0].uri;
        const fullPath = path.isAbsolute(data.filepath) ? data.filepath : path.join(rootUri.fsPath, data.filepath);
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
            const editor = await vscode.window.showTextDocument(document, { preview: false });
            if (data.symbol) {
                const symbolIdx = document.getText().indexOf(data.symbol);
                if (symbolIdx !== -1) {
                    const pos = document.positionAt(symbolIdx);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
        }
        catch (e) {
            vscode.window.showErrorMessage(`NexusCode: Could not open ${fullPath}`);
        }
    }
    async handleReadFileContext(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        let targetFile = data.file;
        let startLine = 0, endLine = Infinity;
        const match = targetFile.match(/(.*?):(\d+)(?:-(\d+))?$/);
        if (match) {
            targetFile = match[1];
            startLine = Math.max(0, parseInt(match[2], 10) - 1);
            endLine = match[3] ? parseInt(match[3], 10) : startLine + 100;
        }
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri, targetFile));
            let code = new TextDecoder().decode(content);
            if (startLine > 0 || endLine !== Infinity) {
                const lines = code.split('\n');
                code = `// [PARTIAL FILE READ: Lines ${startLine + 1} to ${Math.min(endLine, lines.length)}]\n` + lines.slice(startLine, endLine).join('\n');
            }
            this.emit('addContext', { file: data.file, code: code, language: path.extname(targetFile).substring(1) || 'text' });
        }
        catch (e) {
            console.error("Failed to read file:", e);
        }
    }
    async handleExecuteAllTasks(data) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "NexusCode: Drafting Atomic Plan...", cancellable: true }, async (progress, token) => {
            try {
                const projectContext = await (0, projectContext_1.getProjectContext)(this._isMetaMode ? this._extensionUri.fsPath : undefined);
                const allEdits = [];
                const BATCH_SIZE = 5;
                for (let i = 0; i < data.tasks.length; i += BATCH_SIZE) {
                    if (token.isCancellationRequested)
                        break;
                    const batch = data.tasks.slice(i, i + BATCH_SIZE);
                    const batchNum = Math.ceil((i + 1) / BATCH_SIZE);
                    progress.report({ message: `Drafting batch ${batchNum}...` });
                    this.emit('statusUpdate', { message: `Drafting batch ${batchNum}: ${batch[0]}...` });
                    allEdits.push(...(await (0, llmService_1.askQwenForAtomicEdits)(batch, projectContext, data.codingStyle)));
                }
                if (token.isCancellationRequested)
                    return;
                this.emit('statusUpdate', { message: "Compiling Final Review..." });
                this.emit('reviewEdits', { edits: allEdits, tasks: data.tasks });
                vscode.window.showInformationMessage(`Draft complete. Generated code for ${allEdits.length} files.`);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Drafting Failed: ${error.message}`);
            }
            finally {
                this.emit('statusUpdate', { message: "" });
            }
        });
    }
    async handleCommitAtomicEdits(data) {
        if (!vscode.workspace.workspaceFolders || !data.edits)
            return;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "NexusCode: Committing Changes...", cancellable: false }, async () => {
            const workspaceEdit = new vscode.WorkspaceEdit();
            const rootUri = this._isMetaMode ? this._extensionUri : vscode.workspace.workspaceFolders[0].uri;
            for (const edit of data.edits) {
                const fileUri = vscode.Uri.joinPath(rootUri, edit.filepath);
                try {
                    await vscode.workspace.fs.stat(fileUri);
                }
                catch {
                    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                }
                const document = await vscode.workspace.openTextDocument(fileUri);
                workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), (0, commentStyles_1.getAIHeader)(edit.filepath, "Atomic Implementation") + edit.code);
            }
            if (await vscode.workspace.applyEdit(workspaceEdit)) {
                vscode.workspace.textDocuments.filter(d => d.isDirty).forEach(async (doc) => await doc.save());
                this.emit('allTasksCompleted', { status: 'approved' });
                vscode.window.showInformationMessage("Atomic Transaction Committed.");
            }
        });
    }
    async handleGenerateAndRunTests(data) {
        const activeEditor = vscode.window.activeTextEditor;
        if (!vscode.workspace.workspaceFolders || !activeEditor)
            return;
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Writing and executing tests...", cancellable: false }, async () => {
            try {
                this.emit('clearTerminalStream', { task: "Auto-Test Setup" });
                this.emit('clearTerminalStream', { task: "Auto-Test Execution" });
                const relativeFileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                let customRules = "";
                try {
                    customRules = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.nexusrules')));
                }
                catch { }
                const testPlan = await (0, llmService_1.askQwenForTests)(relativeFileName, activeEditor.document.getText(), customRules);
                if (activeEditor.document.isDirty)
                    await activeEditor.document.save();
                if (testPlan.installCommand) {
                    const installResult = await this.confirmAndRunCommand(testPlan.installCommand, workspacePath, 'Installing dependencies...', data.autopilot, (chunk) => this.emit('streamTerminal', { task: "Auto-Test Setup", text: chunk }));
                    if (!installResult?.success) {
                        vscode.window.showErrorMessage("Dependency installation failed.");
                        this.emit('statusUpdate', { message: '⚠️ Tests aborted due to install failure.' });
                        return;
                    }
                }
                const parsedPath = path.parse(relativeFileName);
                let cleanDir = parsedPath.dir.replace(/^src\/?/, '');
                const testFileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, path.join('tests', cleanDir, `${parsedPath.name}.test${parsedPath.ext}`));
                const createEdit = new vscode.WorkspaceEdit();
                createEdit.createFile(testFileUri, { ignoreIfExists: true });
                await vscode.workspace.applyEdit(createEdit);
                const doc = await vscode.workspace.openTextDocument(testFileUri);
                const replaceEdit = new vscode.WorkspaceEdit();
                replaceEdit.replace(testFileUri, new vscode.Range(0, 0, doc.lineCount, 0), testPlan.code);
                await vscode.workspace.applyEdit(replaceEdit);
                await vscode.window.showTextDocument(doc);
                await doc.save();
                const result = await this.confirmAndRunCommand(testPlan.testCommand, workspacePath, 'Running tests...', data.autopilot, (chunk) => this.emit('streamTerminal', { task: "Auto-Test Execution", text: chunk }));
                if (!result)
                    return;
                if (!result.success) {
                    this.emit('statusUpdate', { message: 'Tests failed. Auto-healing...' });
                    try {
                        const fixResult = await (0, llmService_1.askQwenToFixError)(result.output, relativeFileName, activeEditor.document.getText(), path.join('tests', cleanDir, `${parsedPath.name}.test${parsedPath.ext}`), testPlan.code);
                        const fileToFixUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, fixResult.filepath);
                        const fixEdit = new vscode.WorkspaceEdit();
                        const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                        fixEdit.replace(fileToFixUri, new vscode.Range(0, 0, docToFix.lineCount, 0), fixResult.code);
                        await vscode.workspace.applyEdit(fixEdit);
                        await docToFix.save();
                        this.emit('statusUpdate', { message: 'Re-running tests after heal...' });
                        const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);
                        if (retryResult?.success)
                            vscode.window.showInformationMessage(`Auto-Heal successful!`);
                        else
                            vscode.window.showErrorMessage("Auto-Heal attempted, but tests still failing.");
                    }
                    catch (e) {
                        vscode.window.showErrorMessage("Auto-heal failed.");
                    }
                }
                else {
                    vscode.window.showInformationMessage("All tests passed!");
                }
                this.emit('statusUpdate', { message: '' });
            }
            catch (error) {
                vscode.window.showErrorMessage("Failed to run tests.");
            }
        });
    }
    async handleExecuteCommand(data) {
        if (!vscode.workspace.workspaceFolders)
            return;
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const maxRetries = 3;
        let currentAttempt = 1;
        this.emit('taskStatusUpdate', { task: data.task, status: 'reviewing' });
        while (currentAttempt <= maxRetries) {
            this.emit('statusUpdate', { message: `Nexus: Running \`${data.command}\` (Attempt ${currentAttempt}/${maxRetries})...` });
            const result = await this._terminalManager?.runCommandWithCapture(data.command, workspacePath, (chunk) => this.emit('streamTerminal', { task: data.task, text: chunk }));
            if (!result)
                break;
            if (result.success) {
                this.emit('taskCompleted', { task: data.task, status: 'approved', summary: `✅ Command executed flawlessly.` });
                break;
            }
            this.emit('statusUpdate', { message: `🚨 Command Failed. Intercepting Error for Auto-Heal...` });
            this.emit('agentStep', { task: data.task, stepType: 'error', description: `Failed (Code ${result.code})`, details: result.output.substring(0, 1000) });
            if (currentAttempt === maxRetries) {
                this.emit('taskCompleted', { task: data.task, status: 'error', summary: `❌ Failed after ${maxRetries} attempts.` });
                break;
            }
            this.emit('statusUpdate', { message: `Nexus: Architecting fix for terminal error...` });
            try {
                const { askQwenToHealGlobalBuild } = await import('./llmService.js');
                const fixes = await askQwenToHealGlobalBuild(result.output, "Fix the terminal crash.", data.codingStyle);
                if (fixes && fixes.length > 0) {
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    for (const edit of fixes) {
                        const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, edit.filepath);
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        workspaceEdit.replace(fileUri, new vscode.Range(0, 0, document.lineCount, 0), edit.code);
                    }
                    await vscode.workspace.applyEdit(workspaceEdit);
                    vscode.workspace.textDocuments.filter(d => d.isDirty).forEach(async (doc) => await doc.save());
                    this.emit('agentStep', { task: data.task, stepType: 'heal', description: `Auto-Heal Applied to ${fixes.length} files.` });
                }
                else
                    throw new Error("AI could not determine a safe patch.");
            }
            catch (e) {
                this.emit('taskCompleted', { task: data.task, status: 'error', summary: `❌ Auto-heal failed: ${e.message}` });
                break;
            }
            currentAttempt++;
        }
        this.emit('statusUpdate', { message: "" });
    }
    async handleRequestModels() {
        const models = await (0, llmService_1.getAvailableModels)();
        this.emit('updateModelsList', { models, currentModel: vscode.workspace.getConfiguration('nexuscode').get('model') });
    }
    async handleSetModel(data) {
        await vscode.workspace.getConfiguration('nexuscode').update('model', data.value, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(`NexusCode: Model set to ${data.value}`, 3000);
    }
    async handleApproveCommand() { if (this._pendingCommandResolver)
        this._pendingCommandResolver(true); }
    async handleRejectCommand() { if (this._pendingCommandResolver)
        this._pendingCommandResolver(false); }
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
            this.emit('statusUpdate', { message: "🎨 Self-Evolution: Rebuilding UI..." });
            const webviewPath = path.join(this._extensionUri.fsPath, 'webview-ui');
            const buildResult = await this._terminalManager?.runCommandWithCapture("npm run build", webviewPath);
            if (buildResult?.success) {
                vscode.window.showInformationMessage("🎨 UI Rebuilt! Refreshing Webview...");
                vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
            }
            else {
                vscode.window.showErrorMessage("💥 UI Build Failed! Check Output.");
            }
        }
        else {
            this.emit('statusUpdate', { message: "🧬 Self-Evolution: Recompiling..." });
            const compileResult = await this._terminalManager?.runCommandWithCapture("npm run compile", this._extensionUri.fsPath);
            if (compileResult?.success) {
                vscode.window.showInformationMessage("🧬 Evolution Applied. Reload window to see changes.");
            }
            else {
                vscode.window.showErrorMessage("💥 Build Failed! Check Output.");
            }
        }
        this.emit('statusUpdate', { message: "" });
    }
    // --- VIEW RENDERER ---
    _getHtmlForWebview(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "style.css"));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${styleUri}" rel="stylesheet"></head><body><div id="root"></div><script type="module" src="${scriptUri}"></script></body></html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
//# sourceMappingURL=SidebarProvider.js.map