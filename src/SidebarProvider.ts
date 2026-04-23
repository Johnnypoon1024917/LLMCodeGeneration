// src/SidebarProvider.ts
import * as vscode from "vscode";
import * as path from 'path';
import { globalContext } from './extension';
import { originalContentProvider } from './diffProvider';
import { getSmartASTContext, getGraphJSON, buildWorkspaceGraph } from './context/codeGraph';
import { SkillsManager } from './skillsManager';
import { SwarmCoordinator } from './agents/Coordinator';
import { parseRequirementGraph, buildCombinedGraph } from './context/traceabilityGraph';
import { VSCodeEnvironment } from './adapters/VSCodeEnvironment';
import { runProjectTestAgent } from './agents/testAgent';

// AI Services & Tools
import {
    askQwenForStructure,
    askQwenToFixError,
    askQwenForTests,
    askQwenForTargetFile,
    askQwenForAtomicEdits,
    AtomicEdit,
    streamQwenForCode,
    runAgenticExploration,
    getAvailableModels,
    determineIntent,
    streamQwenChat,
    askQwenForRequirements,
    askQwenForDesign,
    askQwenForProjectTasks,
    askQwenToVerifyTask,
    askQwenToUpdatePRD,
    reviewCodeCompleteness,
    askQwenToHealGlobalBuild,
    askSecurityMonitor,
    generateAdversarialTest,
    compactConversationHistory,
    generateMCTSApproaches
} from "./llmService";

// Context Managers
import { getProjectContext } from "./projectContext";
import { getLspContext } from './context/lspContext';
import { getProjectStyleGuides } from './context/styleContext';
import { indexWorkspace, retrieveContext } from './context/ragIndexer';
import { retrieveHybridContext } from './context/hybridSearch';

// Utilities
import { resolveMissingImports } from './utilities/importResolver';
import { getAIHeader } from './utilities/commentStyles';
import { resolveCanonicalPaths } from './utilities/pathUtils';
import { getInjectionPosition } from './utilities/symbolManager';

// Core Managers
import { ProvenanceTracker } from "./provenanceTracker";
import { createWorkspaceStructure } from "./workspaceManager";
import { TerminalManager } from './terminalManager';
import { MetaContextManager } from "./metaContextManager";

function applySearchReplace(originalContent: string, searchBlock: string, replaceBlock: string, fullBuffer: string): string {
    // 1. Clean the blocks of any accidental markdown formatting the LLM might have included
    const cleanSearch = searchBlock.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    const cleanReplace = replaceBlock.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

    // 2. If no search block was found by the regex, the LLM likely generated the whole file.
    // We fallback to just returning the cleaned full buffer.
    if (!cleanSearch) {
        return fullBuffer.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    }

    // 3. Strict substring replacement
    if (originalContent.includes(cleanSearch)) {
        return originalContent.replace(cleanSearch, cleanReplace);
    } else {
        // 🔥 THE POISON PILL: If the SEARCH block doesn't perfectly match the file, we abort.
        // This prevents the agent from corrupting the file with hallucinatory edits.
        throw new Error("Target SEARCH block not found in file. The AI hallucinated the existing code. Aborting to prevent corruption.");
    }
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    public _view?: vscode.WebviewView;
    private _tracker?: ProvenanceTracker;
    private _terminalManager?: TerminalManager;
    private _metaManager?: MetaContextManager;
    private _activeTaskController?: AbortController;
    private _activeRequirements: string = "";
    private _activeDesign: string = "";
    private _lastActiveFile?: string;
    private _isMetaMode: boolean = false;
    private _skillsManager: SkillsManager;
    
    private _undoStack = new Map<string, { filepath: string, originalContent: string }>();
    private _pendingCommandResolver?: (approved: boolean) => void;

    constructor(private readonly _extensionUri: vscode.Uri) {
        this._skillsManager = new SkillsManager();
    }

    public setTerminalManager(manager: TerminalManager) { this._terminalManager = manager; }
    public setProvenanceTracker(tracker: ProvenanceTracker) { this._tracker = tracker; }
    public setMetaManager(manager: MetaContextManager) { this._metaManager = manager; }

    public sendMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        } else {
            vscode.window.showInformationMessage("Please open the NexusCode sidebar first.");
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
        vscode.window.showWarningMessage(`Switched to: ${mode}`);
        this._view?.webview.postMessage({ type: 'metaModeChanged', value: this._isMetaMode });
    }

    private async getTargetContext(): Promise<string> {
        if (this._isMetaMode) { return this._extensionUri.fsPath; }
        return vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
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
            vscode.window.showErrorMessage(`🚨 Nexus Security Firewall BLOCKED a malicious command: ${command}`);
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
            vscode.window.showInformationMessage("Command execution blocked by user.");
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
                vscode.window.showInformationMessage("🎨 UI Rebuilt! Refreshing Webview...");
                vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
            } else {
                vscode.window.showErrorMessage("💥 UI Build Failed! Check Output.");
            }
        } else {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🧬 Self-Evolution: Recompiling..." });
            const compileResult = await this._terminalManager?.runCommandWithCapture("npm run compile", this._extensionUri.fsPath);

            if (compileResult?.success) {
                vscode.window.showInformationMessage("🧬 Evolution Applied. Reload window to see changes.");
            } else {
                vscode.window.showErrorMessage("💥 Build Failed! Check Output.");
            }
        }
        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        vscode.workspace.registerTextDocumentContentProvider('nexus-diff', originalContentProvider);
        this._tracker?.setView(webviewView);
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {

                //  THE FIX: The Webview Handshake. Loads chat history, PRDs, AND .nexusrules
                case "webviewReady": {
                    const chatHistory = globalContext.globalState.get<any[]>('nexus_chat_history') || [];
                    const taskStatuses = globalContext.globalState.get<any>('nexus_task_statuses') || {};
                    const taskSummaries = globalContext.globalState.get<any>('nexus_task_summaries') || {};
                    const taskFiles = globalContext.globalState.get<any>('nexus_task_files') || {};
                    const hasApiKey = !!(await globalContext.secrets.get('nexuscode_apikey'));

                    let savedReqs = "";
                    let savedDesign = "";
                    let savedTasks = null;
                    let savedRules = "";

                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const rootUri = workspaceFolders[0].uri;
                        buildWorkspaceGraph(rootUri).catch(e => console.error("CodeGraph init failed:", e));
                        const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                        try { savedReqs = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'requirements.md'))); this._activeRequirements = savedReqs; } catch (e) { }
                        try { savedDesign = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'design.md'))); this._activeDesign = savedDesign; } catch (e) { }
                        try {
                            const taskData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'));
                            savedTasks = JSON.parse(new TextDecoder().decode(taskData));
                        } catch (e) { }

                        try {
                            const rulesUri = vscode.Uri.joinPath(rootUri, '.nexusrules');
                            savedRules = new TextDecoder().decode(await vscode.workspace.fs.readFile(rulesUri));
                        } catch (e) { }
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
                        hasKey: hasApiKey
                    });
                    break;
                }

                case "requestWorkspaceGraph": {
                    console.log("[DEBUG-MAP] 🟢 1. Webview requested workspace graph.");
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        console.log("[DEBUG-MAP] 🔴 Workspace folders not found.");
                        return;
                    }

                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');

                    this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Nexus: Indexing AST Code Map...' });

                    try {
                        console.log("[DEBUG-MAP] 🟡 2. Fetching raw CodeGraph...");
                        let rawCodeGraph = getGraphJSON();

                        // Force build if empty
                        if (!rawCodeGraph || rawCodeGraph === '{}') {
                            await buildWorkspaceGraph(rootUri);
                            rawCodeGraph = getGraphJSON();
                        }

                        let codeGraph: any = {};
                        if (rawCodeGraph) {
                            try { codeGraph = typeof rawCodeGraph === 'string' ? JSON.parse(rawCodeGraph) : rawCodeGraph; }
                            catch (e) { console.error("[DEBUG-MAP] 🔴 CodeGraph Parse Error:", e instanceof Error ? e.message : String(e)); }
                        }

                        console.log("[DEBUG-MAP] 🟡 3. Normalizing AST Dictionary...");
                        let normalizedCodeGraph: { nodes: any[], edges: any[] } = { nodes: [], edges: [] };
                        Object.entries(codeGraph).forEach(([filepath, data]: [string, any]) => {
                            if (filepath === 'nodes' || filepath === 'edges') return;

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
                        console.log("[DEBUG-MAP] 🟢 4. Sending Initial CodeMap to Webview!");
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
                            const reqData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'requirements.md'));
                            const reqString = new TextDecoder().decode(reqData);
                            reqGraph = await parseRequirementGraph(reqString);
                        } catch (e) {
                            console.log("[DEBUG-MAP] 🟡 No requirements.md found or parsing failed:", e instanceof Error ? e.message : String(e));
                        }

                        // Fetch & Parse Architecture (Design)
                        let designGraph: any = { nodes: [], edges: [] };
                        try {
                            const { parseDesignGraph } = await import('./context/traceabilityGraph.js');
                            const designData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'design.md'));
                            const designString = new TextDecoder().decode(designData);
                            designGraph = await parseDesignGraph(designString);
                        } catch (e) {
                            console.log("[DEBUG-MAP] 🟡 No design.md found or parsing failed:", e instanceof Error ? e.message : String(e));
                        }

                        let tasksJson = null;
                        try {
                            const taskData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'));
                            tasksJson = JSON.parse(new TextDecoder().decode(taskData));
                        } catch (e) {
                            console.log("[DEBUG-MAP] 🟡 No tasks.json found (Normal if tasks aren't generated yet).");
                        }

                        // 2. Build the Ultimate Combined Matrix
                        let combinedGraph: any = { nodes: [...normalizedCodeGraph.nodes], edges: [...normalizedCodeGraph.edges] };
                        try {
                            const { buildCombinedGraph } = await import('./context/traceabilityGraph.js');
                            //  THE FIX: This now executes NO MATTER WHAT, successfully merging Code + PRD!
                            combinedGraph = buildCombinedGraph(normalizedCodeGraph, reqGraph, designGraph, tasksJson);
                        } catch (e) {
                            console.log("[DEBUG-MAP] 🔴 Graph Combining failed:", e instanceof Error ? e.message : String(e));
                        }

                        console.log("[DEBUG-MAP] 🟢 5. Sending Final Traceability Payload to Webview!");
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
                        console.error("[DEBUG-MAP] 🔴 FATAL GRAPH ERROR:", safeError);

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
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const rulesUri = vscode.Uri.joinPath(rootUri, '.nexusrules');
                        try {
                            await vscode.workspace.fs.writeFile(rulesUri, Buffer.from(data.text, 'utf8'));
                            vscode.window.showInformationMessage("✨ Nexus Skills & Rules successfully saved!");
                        } catch (e) {
                            vscode.window.showErrorMessage("Failed to save .nexusrules");
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
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;

                        const [astContext, hybridContext] = await Promise.all([
                            getSmartASTContext(taskQuery),
                            retrieveHybridContext(taskQuery, 5)
                        ]);
                        const fullContext = `${astContext}\n\n${hybridContext}`;

                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'AI QA is checking your work against PRD...' });

                        const verification = await askQwenToVerifyTask(taskQuery, this._activeRequirements, fullContext);

                        if (verification.verified) {
                            const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                            const tasksMdUri = vscode.Uri.joinPath(nexusDir, 'tasks.md');
                            try {
                                let mdContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(tasksMdUri));
                                mdContent = mdContent.replace(`[ ] **${data.task}**`, `[x] **${data.task}**`);
                                mdContent = mdContent.replace(`[ ] ${data.task}`, `[x] ${data.task}`);
                                await vscode.workspace.fs.writeFile(tasksMdUri, Buffer.from(mdContent, 'utf8'));
                            } catch (e) { console.warn("Could not update tasks.md"); }

                            try {
                                if (this._activeRequirements) {
                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus QA: Scanning your code to update Living PRD...` });
                                    const reqMdUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'requirements.md');
                                    let currentPRD = this._activeRequirements;

                                    const prdUpdates = await askQwenToUpdatePRD(currentPRD, data.task, "Manual Code Edit", fullContext);

                                    if (prdUpdates.length > 0) {
                                        prdUpdates.forEach(update => {
                                            currentPRD = currentPRD.replace(update.original, update.updated);
                                        });

                                        await vscode.workspace.fs.writeFile(reqMdUri, Buffer.from(currentPRD, 'utf8'));
                                        this._activeRequirements = currentPRD;
                                        this._view?.webview.postMessage({ type: 'requirementsUpdated', text: currentPRD });
                                    }
                                }
                            } catch (e) {
                                console.warn("[DEBUG] Living PRD QA check failed for manual verify", e);
                            }

                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `✅ VERIFIED: ${verification.reasoning}` });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        } else {
                            
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'rejected', summary: `❌ REJECTED: ${verification.reasoning}` });
                        }

                    } catch (error: any) {
                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Verification Error: ${error.message}` });
                    }
                    break;
                }

                case "generateRequirements": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }
                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '━━━ Step 1: Understanding your request & building feature discovery prompt ━━━' });

                    try {
                        this._view?.webview.postMessage({ type: 'reqStep', message: '━━━ Step 2: Drafting Agile User Stories & Acceptance Criteria ━━━' });

                        const reqPlan = await askQwenForRequirements(data.text, data.context, this._activeTaskController.signal);

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

                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                        const reqFileUri = vscode.Uri.joinPath(nexusDir, 'requirements.md');

                        try { await vscode.workspace.fs.createDirectory(nexusDir); } catch (e) { }
                        await vscode.workspace.fs.writeFile(reqFileUri, Buffer.from(enrichedPrompt, 'utf8'));
                        this._activeRequirements = enrichedPrompt;

                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved requirements.md` });
                        this._view?.webview.postMessage({ type: 'requirementsGenerated', text: enrichedPrompt });
                    } catch (error: any) {
                        if (error.name === 'AbortError') {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Cancelled by User.` });
                        } else {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${error.message}` });
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

                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Step 4: Architecting System Design ━━━' });
                    this._view?.webview.postMessage({ type: 'reqStep', message: 'Analyzing approved PRD and drafting architecture...\n' });

                    try {
                        const designDoc = await askQwenForDesign(data.requirements, this._activeTaskController.signal);

                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const designFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'design.md');
                        await vscode.workspace.fs.writeFile(designFileUri, Buffer.from(designDoc, 'utf8'));

                        this._activeDesign = designDoc;

                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved design.md` });
                        this._view?.webview.postMessage({ type: 'designGenerated', text: designDoc });
                    } catch (error: any) {
                        if (error.name === 'AbortError') {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n🛑 Architecting Cancelled by User.` });
                        } else {
                            this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${error.message}` });
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
                    this._activeTaskController = new AbortController();
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Drafting Master Implementation Plan..." });
                    this._view?.webview.postMessage({ type: 'startChatStream' });

                    try {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const projectContext = await getProjectContext(rootUri.fsPath);

                        const plan = await askQwenForProjectTasks(
                            this._activeRequirements,
                            this._activeDesign,
                            projectContext,
                            this._activeTaskController.signal
                        );

                        const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');

                        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'), Buffer.from(JSON.stringify(plan, null, 2), 'utf8'));

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

                        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(nexusDir, 'tasks.md'), Buffer.from(mdContent, 'utf8'));

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

                    } catch (error: any) {
                        if (error.name === 'AbortError') {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `🛑 Planning Cancelled by User.` });
                        } else {
                            vscode.window.showErrorMessage(`Failed to generate tasks: ${error.message}`);
                        }
                        this._view?.webview.postMessage({ type: 'generationFailed' });
                    } finally {
                        this._activeTaskController = undefined;
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    break;
                }

                case "requestRevision": {
                    const feedback = await vscode.window.showInputBox({
                        prompt: `Why was the code for "${data.task}" rejected?`,
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

                case "updateRequirements": {
                    this._activeRequirements = data.text;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const reqFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'requirements.md');
                        try { await vscode.workspace.fs.writeFile(reqFileUri, Buffer.from(data.text, 'utf8')); } catch (e) { }
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
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const designFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'design.md');
                        try { await vscode.workspace.fs.writeFile(designFileUri, Buffer.from(data.text, 'utf8')); } catch (e) { }
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
                            console.error("Compaction failed", e);
                        } finally {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                    }

                    await globalContext.globalState.update('nexus_chat_history', historyToSave);
                    await globalContext.globalState.update('nexus_task_statuses', data.taskStatuses);
                    await globalContext.globalState.update('nexus_task_summaries', data.taskSummaries);
                    await globalContext.globalState.update('nexus_task_files', data.taskFiles);
                    break;
                }

                case "clearHistory":
                    await globalContext.globalState.update('nexus_chat_history', []);
                    await globalContext.globalState.update('nexus_task_statuses', {});
                    await globalContext.globalState.update('nexus_task_summaries', {});
                    await globalContext.globalState.update('nexus_task_files', {});
                    break;

                case "saveApiKey":
                    await globalContext.secrets.store('nexuscode_apikey', data.value);
                    vscode.window.showInformationMessage("NexusCode: API Key Saved Securely!");
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

                        let actualPromptText = data.text;

                        if (skillResult.isSkill) {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `✨ Executing Custom Skill...` });
                            actualPromptText = skillResult.skillPrompt; // Override with the Markdown Instructions!
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

                            const [lspContext, styleGuide, astContext, hybridContext] = await Promise.all([
                                getLspContext(data.text),
                                getProjectStyleGuides(),
                                getSmartASTContext(data.text),
                                retrieveHybridContext(data.text, 5)
                            ]);

                            const requirementInjection = this._activeRequirements ? `\n\n--- 📋 STRICT BUSINESS REQUIREMENTS ---\nYou must follow these rules absolutely:\n${this._activeRequirements}\n-----------------------------------\n` : "";
                            const designInjection = this._activeDesign ? `\n\n--- 🏗️ SYSTEM ARCHITECTURE & DESIGN ---\nYou must follow this technical design strictly:\n${this._activeDesign}\n-----------------------------------\n` : "";

                            const finalContext = `${lspContext}\n\n${astContext}\n\n${hybridContext}\n\n${styleGuide}${requirementInjection}${designInjection}`;

                            const result = await askQwenForStructure(fullPrompt, finalContext);

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

                            // 🤖 THE CLAUDE CODE LOOP: It will now use grep and read_file autonomously!
                            const explorationContext = await runAgenticExploration(
                                data.text,
                                workspacePath,
                                (stepType, desc, details) => {
                                    this._view?.webview.postMessage({
                                        type: 'agentStep',
                                        task: exploreTaskId,
                                        stepType: stepType,
                                        description: desc,
                                        details: details
                                    });
                                }
                            );

                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing evidence..." });
                            this._view?.webview.postMessage({ type: 'startChatStream' });

                            const fullContext = `--- FORENSIC EVIDENCE GATHERED BY TOOLS ---\n${explorationContext}\n\nBased on this evidence, explain exactly what went wrong and how we should fix it.`;

                            // Stream the final analysis back to the chat window
                            await streamQwenChat(
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

                            await streamQwenChat(
                                fullPrompt, fullContext,
                                data.history || [],
                                (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); },
                                this._activeTaskController.signal
                            );
                        }

                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    } catch (error: any) {
                        if (error.name === 'AbortError') {
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "⚠️ Generation stopped." });
                            setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);
                        } else {
                            vscode.window.showErrorMessage(`NexusCode Error: ${error.message}`);
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
                    if (!workspaceFolders) return;

                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    this._activeTaskController = new AbortController();

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode Swarm Execution Engine...",
                        cancellable: true
                    }, async (progress, token) => {
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
                            let winningApproach = 0;
                            let finalMergedFilepath = "";

                            for (let i = 0; i < approaches.length; i++) {
                                if (success || token.isCancellationRequested) break;

                                const approachNum = i + 1;
                                const isMCTSActive = approaches.length > 1;
                                const currentApproachPrompt = isMCTSActive ? `Original Task: ${originalTaskQuery}\n\nImplementation Directive (Approach ${approachNum}):\n${approaches[i]}` : originalTaskQuery;

                                const sandboxBranch = `nexus-mcts-sandbox-${Date.now()}`;

                                try {
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git stash`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -b ${sandboxBranch}`, rootUri.fsPath);
                                    }

                                    let previousFailures = "";
                                    try {
                                        const failData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, 'nexuscode', 'NEXUS_FAILURES.md'));
                                        previousFailures = new TextDecoder().decode(failData);
                                    } catch { }

                                    const lspBlastRadiusContext = "LSP Context dynamic fetch handled by Swarm.";
                                    const env = new VSCodeEnvironment();

                                    //  THE SWARM ORCHESTRATOR (PHASE 4: Array of Diffs)
                                    const finalDiffs = await SwarmCoordinator.executeTask(
                                        env,
                                        currentApproachPrompt,
                                        rootUri.fsPath,
                                        lspBlastRadiusContext,
                                        this._activeRequirements,
                                        this._activeDesign,
                                        previousFailures,
                                        data.codingStyle || 'precise',
                                        (msg, stepType, details) => {
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
                                        (streamToken) => {
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: streamToken });
                                        }
                                    );

                                    if (!finalDiffs || finalDiffs.length === 0) throw new Error("Swarm failed to generate verified code.");

                                    // 🚀 UPGRADED: Loop through every diff generated by the Swarm and apply them!
                                    for (const finalDiff of finalDiffs) {
                                        const realFilepath = finalDiff.filepath;
                                        const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);

                                        let fileContent = "";
                                        try {
                                            const fileData = await vscode.workspace.fs.readFile(fileUri);
                                            fileContent = new TextDecoder().decode(fileData);
                                        } catch { await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0)); }

                                        // Apply the Phase 1 Search/Replace logic
                                        const finalPerfectCode = applySearchReplace(fileContent, finalDiff.searchBlock, finalDiff.replaceBlock, finalDiff.fullOutputBuffer);

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
                                    winningApproach = approachNum;

                                } catch (error: any) {
                                    if (isMCTSActive) {
                                        await this._terminalManager?.runCommandWithCapture(`git reset --hard`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git checkout -`, rootUri.fsPath);
                                        await this._terminalManager?.runCommandWithCapture(`git branch -D ${sandboxBranch}`, rootUri.fsPath);
                                    } else {
                                        vscode.window.showErrorMessage(`Execution failed: ${error.message}`);
                                    }
                                }
                            } // End of MCTS approaches loop

                            // 🚀 THE FIX: Aggressively update the task status so the UI spinner stops!
                            if (success) {
                                const totalTime = ((Date.now() - taskStartTime) / 1000).toFixed(1);

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

                        } catch (fatalError: any) {
                            // Catch catastrophic Node.js crashes so the UI doesn't hang forever
                            const safeErrorMessage = fatalError instanceof Error ? fatalError.message : "Unknown Fatal Error";
                            vscode.window.showErrorMessage(`Nexus Catastrophic Failure: ${safeErrorMessage}`);

                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Fatal Crash: ${safeErrorMessage}` });
                            this._view?.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error' });
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
                        } catch (e) {
                            vscode.window.showErrorMessage("Failed to undo file edit.");
                        }
                    } else {
                        vscode.window.showWarningMessage("No undo history found for this task.");
                    }
                    break;
                }

                case "runGlobalCompiler": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) { return; }

                    const workspacePath = workspaceFolders[0].uri.fsPath;
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Running Global Workspace Compiler..." });

                    // Run the dry-run build
                    const buildCommand = "npx tsc --noEmit";
                    const result = await this._terminalManager?.runCommandWithCapture(buildCommand, workspacePath);

                    if (result && result.success) {
                        vscode.window.showInformationMessage("✅ Global Compiler Passed! The app is structurally sound.");
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    } else if (result && !result.success) {
                        vscode.window.showErrorMessage("❌ Global Compiler Failed. Initializing Build-Healer...");
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
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, file);
                                    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
                                    brokenFilesContext += `\n--- FILE: ${file} ---\n\`\`\`\n${content}\n\`\`\`\n`;
                                } catch (e) {
                                    // File might be a phantom import that doesn't exist yet
                                }
                            }

                            // 3. Call the Build-Healer Agent
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Healing ${matches.length} cross-file errors...` });
                            const fixes = await askQwenToHealGlobalBuild(result.output, brokenFilesContext, data.codingStyle || 'precise');

                            // 4. Apply the Autonomous Edits
                            if (fixes && fixes.length > 0) {
                                const workspaceEdit = new vscode.WorkspaceEdit();

                                for (const edit of fixes) {
                                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filepath);

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
                                vscode.window.showWarningMessage("⚠️ Build-Healer could not determine a safe patch. Manual intervention required.");
                            }
                        } catch (error: any) {
                            console.error("[DEBUG-HEALER]", error);

                            //  THE FIX: Expose the actual error and the raw terminal output so the developer can see why it failed!
                            const safeError = error instanceof Error ? error.message : String(error);
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
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;

                    const fileUri = vscode.Uri.joinPath(rootUri, data.filepath);
                    const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);

                    await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, `NexusCode Diff: ${path.basename(data.filepath)}`);
                    break;
                }

                case "openFile": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;
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
                    } catch (e) {
                        console.error("Failed to read file for context:", e);
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
                                    const batchEdits = await askQwenForAtomicEdits(batch, projectContext, data.codingStyle);
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
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;

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
                            for (const doc of dirtyDocs) await doc.save();

                            this._view?.webview.postMessage({ type: 'allTasksCompleted', status: 'approved' });
                            vscode.window.showInformationMessage("Atomic Transaction Committed with AI Metadata.");
                        }
                    });
                    break;
                }

                case "generateAndRunTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const activeEditor = vscode.window.activeTextEditor;

                    if (!workspaceFolders || !activeEditor) { return; }

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
                            let customRules = "";
                            try {
                                const rulesUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.nexusrules');
                                customRules = new TextDecoder().decode(await vscode.workspace.fs.readFile(rulesUri));
                            } catch (e) {
                                // No rules file exists yet, perfectly fine.
                            }
                            const testPlan = await askQwenForTests(relativeFileName, activeEditor.document.getText(), customRules);
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
                                    vscode.window.showErrorMessage("Dependency installation failed. Aborting tests.");
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

                            // Force the .test extension (e.g. auth.ts -> auth.test.ts)
                            const testFileName = `${parsedPath.name}.test${parsedPath.ext}`;

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
                                    const fixResult = await askQwenToFixError(
                                        result.output,
                                        relativeFileName,
                                        activeEditor.document.getText(),
                                        deterministicPath,
                                        testPlan.code
                                    );

                                    const fileToFixUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fixResult.filepath);
                                    const fixEdit = new vscode.WorkspaceEdit();
                                    const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                                    fixEdit.replace(fileToFixUri, new vscode.Range(0, 0, docToFix.lineCount, 0), fixResult.code);

                                    await vscode.workspace.applyEdit(fixEdit);
                                    await docToFix.save();

                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: 'Re-running tests after heal...' });
                                    const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);

                                    if (retryResult?.success) { vscode.window.showInformationMessage(`Auto-Heal successful! Fixed ${fixResult.filepath}`); }
                                    else { vscode.window.showErrorMessage("Auto-Heal attempted, but tests still failing."); }

                                } catch (e) {
                                    vscode.window.showErrorMessage("Auto-heal failed to parse LLM output.");
                                }
                            } else {
                                vscode.window.showInformationMessage("All tests passed on the first try!");
                            }
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: '' });

                        } catch (error) {
                            vscode.window.showErrorMessage("Failed to generate or run tests.");
                        }
                    });
                    break;
                }

                case "executeCommand": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;
                    const workspacePath = workspaceFolders[0].uri.fsPath;

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

                        if (!result) break;

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
                            const { askQwenToHealGlobalBuild } = await import('./llmService.js');
                            // We pass the exact terminal error back to the AI
                            const fixes = await askQwenToHealGlobalBuild(result.output, "Fix the terminal crash.", data.codingStyle);

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
                                for (const doc of dirtyDocs) await doc.save();

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

                case "approveCommand": {
                    if (this._pendingCommandResolver) this._pendingCommandResolver(true);
                    break;
                }

                case "rejectCommand": {
                    if (this._pendingCommandResolver) this._pendingCommandResolver(false);
                    break;
                }

                case "generateProjectTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;
                    const rootUri = workspaceFolders[0].uri;

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

                                vscode.window.showInformationMessage(`✅ Master TDD Suite successfully generated in /nexuscode!`);
                            } else {
                                vscode.window.showErrorMessage(`Failed to generate master TDD suite.`);
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`TDD Generation Error: ${error.message}`);
                        }
                    });
                    break;
                }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "style.css"));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${styleUri}" rel="stylesheet"></head><body><div id="root"></div><script type="module" src="${scriptUri}"></script></body></html>`;
    }
}