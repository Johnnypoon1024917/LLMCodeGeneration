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
const diffProvider_1 = require("./diffProvider");
const codeGraph_1 = require("./context/codeGraph");
// AI Services & Tools
const llmService_1 = require("./llmService");
// Context Managers
const projectContext_1 = require("./projectContext");
const lspContext_1 = require("./context/lspContext");
const styleContext_1 = require("./context/styleContext");
const ragIndexer_1 = require("./context/ragIndexer");
const hybridSearch_1 = require("./context/hybridSearch");
// Utilities
const importResolver_1 = require("./utilities/importResolver");
const commentStyles_1 = require("./utilities/commentStyles");
const pathUtils_1 = require("./utilities/pathUtils");
const workspaceManager_1 = require("./workspaceManager");
function injectCodeIntoContent(originalContent, target, newCode, action) {
    if (action === 'replace')
        return newCode;
    if (action === 'append')
        return originalContent + "\n\n" + newCode;
    // For 'inject', we must find the target and surgically replace it
    if (!target)
        return originalContent + "\n\n" + newCode; // Fallback
    const lines = originalContent.split('\n');
    let startIdx = -1;
    // 1. Find the target line
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(target)) {
            startIdx = i;
            break;
        }
    }
    if (startIdx === -1) {
        console.warn(`[DEBUG-INJECT] Target "${target}" not found. Falling back to append.`);
        return originalContent + "\n\n" + newCode;
    }
    // 2. Count braces to find the exact end of the function/class
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
    // 3. Splice the new code flawlessly into the original file
    const before = lines.slice(0, startIdx).join('\n');
    const after = lines.slice(endIdx + 1).join('\n');
    return before + "\n" + newCode + "\n" + after;
}
class SidebarProvider {
    _extensionUri;
    _view;
    _tracker;
    _terminalManager;
    _metaManager;
    _activeTaskController;
    _activeRequirements = "";
    _activeDesign = "";
    _lastActiveFile;
    _isMetaMode = false;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    setTerminalManager(manager) { this._terminalManager = manager; }
    setProvenanceTracker(tracker) { this._tracker = tracker; }
    setMetaManager(manager) { this._metaManager = manager; }
    sendMessageToWebview(message) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
        else {
            vscode.window.showInformationMessage("Please open the NexusCode sidebar first.");
        }
    }
    injectTerminalTask(prompt) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'injectTerminalTask',
                task: prompt
            });
        }
    }
    toggleMetaMode() {
        this._isMetaMode = !this._isMetaMode;
        const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
        vscode.window.showWarningMessage(`Switched to: ${mode}`);
        this._view?.webview.postMessage({ type: 'metaModeChanged', value: this._isMetaMode });
    }
    async getTargetContext() {
        if (this._isMetaMode)
            return this._extensionUri.fsPath;
        return vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
    }
    // --- 🛡️ ENTERPRISE GUARDRAIL: Human-in-the-Loop Command Execution ---
    async confirmAndRunCommand(command, workspacePath, progressMessage) {
        const userChoice = await vscode.window.showWarningMessage(`NexusCode wants to execute a terminal command:\n\n\`${command}\``, { modal: true }, "Run Command", "Deny");
        if (userChoice === "Run Command") {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: progressMessage });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath);
        }
        else {
            vscode.window.showInformationMessage("Command execution cancelled by user.");
            return undefined;
        }
    }
    async handlePostApproval(uri) {
        if (!this._isMetaMode)
            return;
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty)
            await document.save();
        const filepath = uri.fsPath;
        if (filepath.includes('webview-ui')) {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🎨 Self-Evolution: Rebuilding UI..." });
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
            this._view?.webview.postMessage({ type: 'statusUpdate', message: "🧬 Self-Evolution: Recompiling..." });
            const compileResult = await this._terminalManager?.runCommandWithCapture("npm run compile", this._extensionUri.fsPath);
            if (compileResult?.success) {
                vscode.window.showInformationMessage("🧬 Evolution Applied. Reload window to see changes.");
            }
            else {
                vscode.window.showErrorMessage("💥 Build Failed! Check Output.");
            }
        }
        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
    }
    async resolveWebviewView(webviewView) {
        this._view = webviewView;
        this._tracker?.setView(webviewView);
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        // 🔥 ENTERPRISE UPGRADE: Load Session and Auth State
        const chatHistory = extension_1.globalContext.globalState.get('nexus_chat_history') || [];
        const taskStatuses = extension_1.globalContext.globalState.get('nexus_task_statuses') || {};
        const taskSummaries = extension_1.globalContext.globalState.get('nexus_task_summaries') || {};
        const hasApiKey = !!(await extension_1.globalContext.secrets.get('nexuscode_apikey'));
        // Load requirements and design from .md files!
        let savedReqs = "";
        let savedDesign = "";
        let savedTasks = null;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const nexusDir = vscode.Uri.joinPath(workspaceFolders[0].uri, 'nexuscode');
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
                const taskData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'));
                savedTasks = JSON.parse(new TextDecoder().decode(taskData));
            }
            catch (e) { }
        }
        // Send initial state to React
        webviewView.webview.postMessage({
            type: 'initState',
            messages: chatHistory,
            taskStatuses: taskStatuses,
            taskSummaries: taskSummaries,
            requirements: savedReqs,
            design: savedDesign,
            tasks: savedTasks,
            hasKey: hasApiKey
        });
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "verifyTask": {
                    if (!workspaceFolders)
                        return;
                    this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'Gathering context to verify your code...' });
                    try {
                        const taskQuery = data.prompt || data.task;
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        // Gather the context of the code you just wrote
                        const [astContext, hybridContext] = await Promise.all([
                            (0, codeGraph_1.getSmartASTContext)(taskQuery),
                            (0, hybridSearch_1.retrieveHybridContext)(taskQuery, 5)
                        ]);
                        const fullContext = `${astContext}\n\n${hybridContext}`;
                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'reviewing', summary: 'AI QA is checking your work against PRD...' });
                        const verification = await (0, llmService_1.askQwenToVerifyTask)(taskQuery, this._activeRequirements, fullContext);
                        if (verification.verified) {
                            // ✅ IT PASSED! Check off the box in tasks.md
                            const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                            const tasksMdUri = vscode.Uri.joinPath(nexusDir, 'tasks.md');
                            try {
                                let mdContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(tasksMdUri));
                                mdContent = mdContent.replace(`[ ] **${data.task}**`, `[x] **${data.task}**`);
                                mdContent = mdContent.replace(`[ ] ${data.task}`, `[x] ${data.task}`);
                                await vscode.workspace.fs.writeFile(tasksMdUri, Buffer.from(mdContent, 'utf8'));
                            }
                            catch (e) {
                                console.warn("Could not update tasks.md");
                            }
                            // 🔥 ENHANCEMENT A: Update the Living PRD for manually written code too!
                            try {
                                if (this._activeRequirements) {
                                    this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus QA: Scanning your code to update Living PRD...` });
                                    const reqMdUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'requirements.md');
                                    let currentPRD = this._activeRequirements;
                                    // Use fullContext as the "new code" representation since they wrote it manually
                                    const prdUpdates = await (0, llmService_1.askQwenToUpdatePRD)(currentPRD, data.task, "Manual Code Edit", fullContext);
                                    if (prdUpdates.length > 0) {
                                        prdUpdates.forEach(update => {
                                            currentPRD = currentPRD.replace(update.original, update.updated);
                                        });
                                        await vscode.workspace.fs.writeFile(reqMdUri, Buffer.from(currentPRD, 'utf8'));
                                        this._activeRequirements = currentPRD;
                                    }
                                }
                            }
                            catch (e) {
                                console.warn("[DEBUG] Living PRD QA check failed for manual verify", e);
                            }
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'approved', summary: `✅ VERIFIED: ${verification.reasoning}` });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                        else {
                            // ❌ IT FAILED!
                            this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'rejected', summary: `❌ REJECTED: ${verification.reasoning}` });
                        }
                    }
                    catch (error) {
                        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: data.task, status: 'error', summary: `Verification Error: ${error.message}` });
                    }
                    break;
                }
                case "generateRequirements": {
                    if (!workspaceFolders)
                        return;
                    this._view?.webview.postMessage({ type: 'reqStep', message: '━━━ Step 1: Understanding your request & building feature discovery prompt ━━━' });
                    this._view?.webview.postMessage({ type: 'reqStep', message: `Generated prompt for LLM (${data.text.length + 150} chars)\n` });
                    try {
                        this._view?.webview.postMessage({ type: 'reqStep', message: '━━━ Step 2: Drafting Agile User Stories & Acceptance Criteria ━━━' });
                        this._view?.webview.postMessage({ type: 'reqStep', message: 'Calling LLM...\n' });
                        const reqPlan = await (0, llmService_1.askQwenForRequirements)(data.text);
                        // Stream the Agile logs to the UI!
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Project:      ${reqPlan.projectName}` });
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Domain:       ${reqPlan.domain}` });
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Audience:     ${reqPlan.targetAudience}` });
                        this._view?.webview.postMessage({ type: 'reqStep', message: `Stories:      ${reqPlan.userStories.length} generated` });
                        this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Step 3: Composing Master PRD Document ━━━' });
                        // Build the FAANG-Grade Markdown PRD
                        let enrichedPrompt = `# 📋 Product Requirements Document (PRD): ${reqPlan.projectName}\n\n`;
                        enrichedPrompt += `**Domain:** ${reqPlan.domain}\n`;
                        enrichedPrompt += `**Target Audience:** ${reqPlan.targetAudience}\n`;
                        enrichedPrompt += `**Original Request:** "${data.text}"\n\n`;
                        enrichedPrompt += `## 🎯 Agile User Stories\n\n`;
                        reqPlan.userStories.forEach((us, i) => {
                            enrichedPrompt += `### ${i + 1}. Epic: ${us.epic}\n`;
                            enrichedPrompt += `**Story:** ${us.story}\n\n`;
                            enrichedPrompt += `**Acceptance Criteria:**\n`;
                            us.acceptanceCriteria.forEach((ac) => {
                                enrichedPrompt += `- [ ] ${ac}\n`;
                            });
                            enrichedPrompt += `\n`;
                        });
                        enrichedPrompt += `## 🛡️ Non-Functional Requirements (NFRs)\n`;
                        reqPlan.nonFunctionalRequirements.forEach((nfr) => {
                            enrichedPrompt += `- ${nfr}\n`;
                        });
                        enrichedPrompt += `\n## 💻 Technical Instructions for AI Coder\n- Create a clean, modular project structure\n- Implement each Epic as a separate component/module\n- Ensure all Acceptance Criteria are met before marking a task complete.\n- Use modern best practices and frameworks\n`;
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                        const reqFileUri = vscode.Uri.joinPath(nexusDir, 'requirements.md');
                        try {
                            await vscode.workspace.fs.createDirectory(nexusDir);
                        }
                        catch (e) { }
                        await vscode.workspace.fs.writeFile(reqFileUri, Buffer.from(enrichedPrompt, 'utf8'));
                        this._activeRequirements = enrichedPrompt;
                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved requirements.md` });
                        // 🔥 WE STOP HERE NOW!
                        this._view?.webview.postMessage({ type: 'requirementsGenerated', text: enrichedPrompt });
                    }
                    catch (error) {
                        this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${error.message}` });
                    }
                    break;
                }
                // 🔥 PHASE 2: Architecting System Design (Triggered by the Approve button)
                case "generateDesign": {
                    if (!workspaceFolders)
                        return;
                    this._view?.webview.postMessage({ type: 'reqStep', message: '\n━━━ Step 4: Architecting System Design ━━━' });
                    this._view?.webview.postMessage({ type: 'reqStep', message: 'Analyzing approved PRD and drafting architecture...\n' });
                    try {
                        const designDoc = await (0, llmService_1.askQwenForDesign)(data.requirements);
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const designFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'design.md');
                        await vscode.workspace.fs.writeFile(designFileUri, Buffer.from(designDoc, 'utf8'));
                        this._activeDesign = designDoc;
                        this._view?.webview.postMessage({ type: 'reqStep', message: `✅ Saved design.md` });
                        this._view?.webview.postMessage({ type: 'designGenerated', text: designDoc });
                    }
                    catch (error) {
                        this._view?.webview.postMessage({ type: 'reqStep', message: `\n❌ Error: ${error.message}` });
                    }
                    break;
                }
                // 🔥 PHASE 3: The Master Project Builder Loop
                case "generateProjectTasks": {
                    if (!workspaceFolders)
                        return;
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Drafting Master Implementation Plan..." });
                    // Initialize an empty chat bubble to hold the response
                    this._view?.webview.postMessage({ type: 'startChatStream' });
                    try {
                        const plan = await (0, llmService_1.askQwenForProjectTasks)(this._activeRequirements, this._activeDesign);
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                        // 1. Save tasks.json for system recovery
                        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(nexusDir, 'tasks.json'), Buffer.from(JSON.stringify(plan, null, 2), 'utf8'));
                        // 2. Save tasks.md for human readability!
                        let mdContent = "# Master Implementation Plan\n\n## 📁 Folder Structure\n";
                        plan.folderStructure.forEach(f => mdContent += `- \`${f}\`\n`);
                        mdContent += "\n## 🛠️ Execution Tasks\n";
                        plan.implementationTasks.forEach((t, i) => {
                            if (typeof t === 'string')
                                mdContent += `${i + 1}. [ ] ${t}\n`;
                            else
                                mdContent += `${i + 1}. [ ] **${t.step}** (File: \`${t.file}\`)\n   - *Instructions:* ${t.detailedInstructions}\n`;
                        });
                        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(nexusDir, 'tasks.md'), Buffer.from(mdContent, 'utf8'));
                        // 3. Resolve paths
                        const { finalPaths, renamingMap } = await (0, pathUtils_1.resolveCanonicalPaths)(plan.folderStructure, rootUri.fsPath);
                        plan.folderStructure = finalPaths;
                        plan.implementationTasks = plan.implementationTasks.map((task) => {
                            if (typeof task === 'string')
                                return task;
                            let updatedTask = { ...task };
                            renamingMap.forEach((realPath, plannedPath) => {
                                if (updatedTask.file === plannedPath)
                                    updatedTask.file = realPath;
                                if (updatedTask.detailedInstructions.includes(plannedPath)) {
                                    updatedTask.detailedInstructions = updatedTask.detailedInstructions.replace(plannedPath, realPath);
                                }
                            });
                            return updatedTask;
                        });
                        if (plan.folderStructure.length > 0)
                            await (0, workspaceManager_1.createWorkspaceStructure)(plan.folderStructure);
                        // 4. Push it to the UI!
                        this._view?.webview.postMessage({ type: 'chatToken', token: "I have analyzed the PRD and System Architecture. Here is the master implementation plan. You can execute these tasks one by one using the buttons below, or run them all at once.\n\n" });
                        this._view?.webview.postMessage({ type: "structureResponse", value: plan });
                        this._view?.webview.postMessage({ type: 'tasksGenerated' });
                    }
                    catch (error) {
                        vscode.window.showErrorMessage(`Failed to generate tasks: ${error.message}`);
                    }
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    break;
                }
                case "requestRevision": {
                    const feedback = await vscode.window.showInputBox({
                        prompt: `Why was the code for "${data.task}" rejected?`,
                        placeHolder: "e.g., 'Use axios instead of fetch', or 'Fix the null pointer error'"
                    });
                    if (feedback === undefined)
                        return; // User pressed Esc to cancel
                    this._view?.webview.postMessage({
                        type: 'startRevision',
                        task: data.task,
                        feedback: feedback || "The previous attempt was rejected. Try a different approach and ensure the code is completely bug-free."
                    });
                    break;
                }
                case "updateRequirements": {
                    this._activeRequirements = data.text;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const reqFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'requirements.md');
                        try {
                            await vscode.workspace.fs.writeFile(reqFileUri, Buffer.from(data.text, 'utf8'));
                        }
                        catch (e) {
                            console.warn("Failed to save requirements.md", e);
                        }
                    }
                    else if (data.text === "") {
                        this._activeRequirements = "";
                        this._activeDesign = ""; // Clear design on start over
                    }
                    break;
                }
                case "updateDesign": {
                    this._activeDesign = data.text;
                    if (workspaceFolders && data.text.trim()) {
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                        const designFileUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'design.md');
                        try {
                            await vscode.workspace.fs.writeFile(designFileUri, Buffer.from(data.text, 'utf8'));
                        }
                        catch (e) {
                            console.warn("Failed to save design.md", e);
                        }
                    }
                    break;
                }
                case "syncHistory":
                    await extension_1.globalContext.globalState.update('nexus_chat_history', data.messages);
                    await extension_1.globalContext.globalState.update('nexus_task_statuses', data.taskStatuses);
                    await extension_1.globalContext.globalState.update('nexus_task_summaries', data.taskSummaries);
                    break;
                case "clearHistory":
                    await extension_1.globalContext.globalState.update('nexus_chat_history', []);
                    await extension_1.globalContext.globalState.update('nexus_task_statuses', {});
                    await extension_1.globalContext.globalState.update('nexus_task_summaries', {});
                    break;
                case "saveApiKey":
                    await extension_1.globalContext.secrets.store('nexuscode_apikey', data.value);
                    vscode.window.showInformationMessage("NexusCode: API Key Saved Securely!");
                    webviewView.webview.postMessage({ type: 'initState', messages: chatHistory, hasKey: true });
                    break;
                case "processUserMessage": {
                    console.log("[DEBUG] 📥 Received message from UI:", data.text);
                    this._activeTaskController = new AbortController();
                    try {
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing intent..." });
                        console.log("[DEBUG] 🧠 Determining intent...");
                        const intent = await (0, llmService_1.determineIntent)(data.text);
                        console.log(`[DEBUG] 🎯 Intent determined as: [${intent.toUpperCase()}]`);
                        const fullPrompt = data.context
                            ? `--- ATTACHED CONTEXT ---\n${data.context}\n\n--- USER QUERY ---\n${data.text}`
                            : data.text;
                        if (intent === 'build') {
                            console.log("[DEBUG] 🛠️ Entering BUILD pipeline");
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting plan..." });
                            this._view?.webview.postMessage({ type: 'startChatStream' });
                            await (0, ragIndexer_1.indexWorkspace)((msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));
                            // 🔥 Fixed: using data.text instead of data.task!
                            const [lspContext, styleGuide, astContext, hybridContext] = await Promise.all([
                                (0, lspContext_1.getLspContext)(data.text),
                                (0, styleContext_1.getProjectStyleGuides)(),
                                (0, codeGraph_1.getSmartASTContext)(data.text), // 🌳 Pillar 1
                                (0, hybridSearch_1.retrieveHybridContext)(data.text, 5) // 🔍 Pillar 2
                            ]);
                            const requirementInjection = this._activeRequirements ? `\n\n--- 📋 STRICT BUSINESS REQUIREMENTS ---\nYou must follow these rules absolutely:\n${this._activeRequirements}\n-----------------------------------\n` : "";
                            const designInjection = this._activeDesign ? `\n\n--- 🏗️ SYSTEM ARCHITECTURE & DESIGN ---\nYou must follow this technical design strictly:\n${this._activeDesign}\n-----------------------------------\n` : "";
                            const finalContext = `${lspContext}\n\n${astContext}\n\n${hybridContext}\n\n${styleGuide}${requirementInjection}${designInjection}`;
                            const result = await (0, llmService_1.askQwenForStructure)(fullPrompt, finalContext);
                            this._view?.webview.postMessage({ type: 'chatToken', token: result.explanation + "\n\n" });
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
                            this._view?.webview.postMessage({ type: "structureResponse", value: result.plan });
                            console.log("[DEBUG] ✅ Build plan successfully sent to UI.");
                        }
                        else {
                            // --- CHAT & EXPLAIN PIPELINE ---
                            console.log("[DEBUG] 💬 Entering CHAT/EXPLAIN pipeline");
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Gathering context..." });
                            const workspacePath = await this.getTargetContext();
                            // 🔥 Fixed double await syntax error!
                            const ragContext = await (0, hybridSearch_1.retrieveHybridContext)(data.text, 5);
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
                            await (0, llmService_1.streamQwenChat)(fullPrompt, fullContext, (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); }, this._activeTaskController.signal);
                            console.log("[DEBUG] ✅ Chat stream completed naturally.");
                        }
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    catch (error) {
                        if (error.name === 'AbortError') {
                            console.log("[DEBUG] 🛑 Generation aborted by user.");
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "⚠️ Generation stopped." });
                            setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);
                        }
                        else {
                            console.error("[DEBUG] 💥 ERROR IN processUserMessage PIPELINE:", error);
                            vscode.window.showErrorMessage(`NexusCode Error: ${error.message}`);
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
                        vscode.window.showWarningMessage("NexusCode: Generation Stopped.");
                    }
                    break;
                }
                case "executeTask": {
                    // 🔥 CRITICAL FIX: The Hidden Meta-Payload Routing!
                    const taskQuery = data.prompt || data.task;
                    console.log(`\n\n[DEBUG-EXEC] 🚀 STARTING EXECUTION FOR TASK: "${data.task}"`);
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
                    const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const projectStructure = await (0, projectContext_1.getProjectContext)(contextRoot);
                    const lowerTask = taskQuery.toLowerCase();
                    const isReadOnly = (lowerTask.startsWith("open") || lowerTask.startsWith("locate")) && !lowerTask.includes("fix");
                    this._activeTaskController = new AbortController();
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: this._isMetaMode ? "⚠️ NexusCode Self-Evolving..." : "NexusCode is working...",
                        cancellable: true
                    }, async (progress, token) => {
                        token.onCancellationRequested(() => this._activeTaskController?.abort());
                        const MAX_RETRIES = 2;
                        let attempt = 1;
                        let success = false;
                        const taskStartTime = Date.now();
                        let streamStartTime = 0;
                        let streamEndTime = 0;
                        while (attempt <= MAX_RETRIES && !success) {
                            try {
                                if (attempt > 1) {
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'heal', description: `Retrying (Attempt ${attempt}/${MAX_RETRIES})...` });
                                }
                                // 🔥 Use taskQuery for AI operations, keep data.task for UI updates!
                                const [lspContext, styleGuide, astContext, hybridContext] = await Promise.all([
                                    (0, lspContext_1.getLspContext)(taskQuery),
                                    (0, styleContext_1.getProjectStyleGuides)(),
                                    (0, codeGraph_1.getSmartASTContext)(taskQuery), // 🌳 Pillar 1
                                    (0, hybridSearch_1.retrieveHybridContext)(taskQuery, 5) // 🔍 Pillar 2
                                ]);
                                const smartContext = await (0, llmService_1.runAgenticExploration)(taskQuery, rootUri.fsPath, (stepType, description, details) => {
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType, description, details });
                                });
                                let targetFilepath = "";
                                const explicitPathMatch = taskQuery.match(/[a-zA-Z0-9_\-\/\\]+\.[a-zA-Z0-9]+/);
                                if (isReadOnly && explicitPathMatch)
                                    targetFilepath = explicitPathMatch[0];
                                else {
                                    const targetInfo = await (0, llmService_1.askQwenForTargetFile)(taskQuery, projectStructure, this._lastActiveFile);
                                    targetFilepath = targetInfo.filepath;
                                }
                                const { finalPaths } = await (0, pathUtils_1.resolveCanonicalPaths)([targetFilepath], contextRoot);
                                const realFilepath = finalPaths[0] || targetFilepath;
                                this._lastActiveFile = realFilepath;
                                const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);
                                if (isReadOnly) {
                                    const document = await vscode.workspace.openTextDocument(fileUri);
                                    await vscode.window.showTextDocument(document, { preview: false });
                                    const duration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                                    webviewView.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'approved', summary: `📂 Opened ${realFilepath} (took ${duration}s)` });
                                    return;
                                }
                                let currentFileContent = "";
                                let fileExists = false;
                                try {
                                    const fileData = await vscode.workspace.fs.readFile(fileUri);
                                    currentFileContent = new TextDecoder().decode(fileData);
                                    fileExists = true;
                                }
                                catch { }
                                const feedbackInjection = data.feedback ?
                                    `\n\n⚠️ CRITICAL USER FEEDBACK FROM PREVIOUS REJECTION:\n"${data.feedback}"\nDo NOT repeat your previous mistakes. Incorporate this feedback perfectly.` : "";
                                const requirementInjection = this._activeRequirements ? `\n\n--- 📋 STRICT BUSINESS REQUIREMENTS ---\nYou must follow these rules absolutely:\n${this._activeRequirements}\n-----------------------------------\n` : "";
                                const designInjection = this._activeDesign ? `\n\n--- 🏗️ SYSTEM ARCHITECTURE & DESIGN ---\nYou must follow this technical design strictly:\n${this._activeDesign}\n-----------------------------------\n` : "";
                                // Combine all context pillars!
                                const promptContext = `--- AUTONOMOUSLY GATHERED CONTEXT ---\n${smartContext}\n${astContext}\n${hybridContext}\nTarget File: ${realFilepath}\nContent:\n\`\`\`\n${currentFileContent.substring(0, 15000)}\n\`\`\`\nFile Exists: ${fileExists}\n${lspContext}\n${styleGuide}${feedbackInjection}${requirementInjection}${designInjection}`;
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Speculative Execution (Shadow Compiling)...` });
                                webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'analyze', description: 'Speculative Execution', details: `Drafting ${realFilepath} in background...` });
                                let generatedCommand = "";
                                let shadowCodeBuffer = "";
                                let streamAction = 'replace';
                                let streamTarget = '';
                                streamStartTime = Date.now(); // ⏱️ START GENERATION TIMER
                                // =====================================================================
                                // 👻 PHASE 1: SHADOW GENERATION
                                // =====================================================================
                                await (0, llmService_1.streamQwenForCode)(taskQuery, [], promptContext, data.codingStyle, [], {
                                    onReasoning: async (token) => {
                                        this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: token });
                                    },
                                    onSetup: async (action, filepath, target) => {
                                        streamAction = !fileExists ? 'replace' : action;
                                        streamTarget = target || '';
                                    },
                                    onCommand: async (cmd) => {
                                        generatedCommand = cmd; // 🔥 Dedicated route! Never touches the file buffer!
                                    },
                                    onToken: async (token) => {
                                        const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                        shadowCodeBuffer += cleanToken;
                                        this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: cleanToken });
                                    }
                                }, this._activeTaskController?.signal);
                                // 🔥 Merge the AI's output into the original file using Brace-Matching!
                                const composedDraftCode = injectCodeIntoContent(currentFileContent, streamTarget, shadowCodeBuffer, streamAction);
                                // =====================================================================
                                // 🛠️ PHASE 2: SHADOW COMPILATION & INVISIBLE HEALING
                                // =====================================================================
                                const shadowFilename = `.${path.basename(realFilepath)}.nexus_shadow`;
                                const shadowUri = vscode.Uri.joinPath(rootUri, path.dirname(realFilepath), shadowFilename);
                                let finalPerfectCode = composedDraftCode;
                                try {
                                    // Write the fully merged code to the hidden shadow file
                                    await vscode.workspace.fs.writeFile(shadowUri, Buffer.from(composedDraftCode, 'utf8'));
                                    await vscode.workspace.openTextDocument(shadowUri);
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'analyze', description: 'Checking Diagnostics', details: `Compiling shadow file...` });
                                    // Wait 2 seconds for the VS Code Compiler (LSP)
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                    const diagnostics = vscode.languages.getDiagnostics(shadowUri);
                                    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
                                    // Auto-Heal if the merge broke something!
                                    if (errors.length > 0) {
                                        webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'heal', description: 'Shadow Compile Failed', details: `Found ${errors.length} issues. Auto-healing invisibly...` });
                                        const errorLog = errors.map(e => `[Line ${e.range.start.line + 1}] ${e.message}`).join('\n');
                                        const healContext = `The following compilation/syntax errors were found in your draft:\n\n${errorLog}\n\nPlease output the COMPLETELY FIXED file.`;
                                        let healedCodeBuffer = "";
                                        await (0, llmService_1.streamQwenForCode)("Fix syntax errors", [], healContext, data.codingStyle, [], {
                                            onSetup: async () => { },
                                            onToken: async (token) => {
                                                const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                                healedCodeBuffer += cleanToken;
                                                this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: cleanToken });
                                            }
                                        }, this._activeTaskController?.signal);
                                        // If it heals, we assume the healer outputted the full replaced file
                                        finalPerfectCode = healedCodeBuffer;
                                        webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'success', description: 'Shadow Heal Complete', details: `Invisible syntax fix applied.` });
                                    }
                                    else {
                                        webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'success', description: 'Shadow Compile Passed', details: `Zero syntax errors detected.` });
                                    }
                                }
                                finally {
                                    try {
                                        await vscode.workspace.fs.delete(shadowUri);
                                    }
                                    catch (e) { }
                                }
                                streamEndTime = Date.now(); // ⏱️ END GENERATION TIMER
                                // =====================================================================
                                // ✨ PHASE 3: FINAL DELIVERY (Push perfect code to active editor)
                                // =====================================================================
                                if (!fileExists) {
                                    try {
                                        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(rootUri, path.dirname(realFilepath)));
                                    }
                                    catch (e) { }
                                    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                }
                                const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);
                                diffProvider_1.originalContentProvider.setContent(originalUri, currentFileContent);
                                const document = await vscode.workspace.openTextDocument(fileUri);
                                const editor = await vscode.window.showTextDocument(document, { preview: false });
                                // Safely replace the ENTIRE editor with our perfectly spliced memory buffer
                                const lastSafeLine = Math.max(0, document.lineCount - 1);
                                const lastSafeChar = document.lineCount > 0 ? document.lineAt(lastSafeLine).text.length : 0;
                                const mergedHeader = (0, commentStyles_1.getAIHeader)(realFilepath, data.task, currentFileContent) + "\n";
                                await editor.edit(b => {
                                    b.delete(new vscode.Range(0, 0, lastSafeLine, lastSafeChar));
                                    b.insert(new vscode.Position(0, 0), mergedHeader + finalPerfectCode);
                                });
                                await document.save(); // 🔥 Force save so TS Server can scan it!
                                // =====================================================================
                                // 🔄 PHASE 4: THE TDD AUTO-LOOP (Live Post-Save Verification)
                                // =====================================================================
                                webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'analyze', description: 'TDD Post-Check', details: `Scanning editor for TypeScript errors...` });
                                // Wait 2.5 seconds for VS Code's Language Server to fully analyze the file
                                await new Promise(resolve => setTimeout(resolve, 2500));
                                const liveDiagnostics = vscode.languages.getDiagnostics(fileUri);
                                const liveErrors = liveDiagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                                // Filter out "Phantom Imports" (error 2307) for local files, because they just haven't been generated yet!
                                const realSyntaxErrors = liveErrors.filter(e => {
                                    const isPhantomImport = (e.code === 2307 || e.message.includes("Cannot find module")) && e.message.includes('./');
                                    return !isPhantomImport;
                                });
                                if (realSyntaxErrors.length > 0) {
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'heal', description: 'TDD Auto-Heal Triggered', details: `Caught ${realSyntaxErrors.length} live syntax errors! Rewriting...` });
                                    const errorLog = realSyntaxErrors.map(e => `[Line ${e.range.start.line + 1}] ${e.message}`).join('\n');
                                    let languageSpecificFixes = "";
                                    const ext = path.extname(realFilepath).toLowerCase();
                                    if (ext === '.ts' || ext === '.tsx' || ext === '.js') {
                                        languageSpecificFixes = "1. If you appended '.ts'/'.js' to an import, REMOVE IT.\n2. If you used 'require', switch to ES6 imports.";
                                    }
                                    else if (ext === '.py') {
                                        languageSpecificFixes = "1. Ensure strict PEP8 indentation.\n2. Check for missing imports or undefined variables.";
                                    }
                                    else {
                                        languageSpecificFixes = "1. Fix the syntax/compilation errors exactly as reported by the compiler.";
                                    }
                                    // 🔥 ANTI-DELETION PROTOCOL ADDED
                                    const healContext = `The code you just wrote has the following live compilation/syntax errors in the editor:\n\n${errorLog}\n\nCRITICAL FIX INSTRUCTIONS:\n${languageSpecificFixes}\n\n🔥 ANTI-DELETION PROTOCOL 🔥\nYou MUST output the ENTIRE, unmodified file content with ONLY the syntax errors fixed. DO NOT delete, summarize, or remove ANY existing middleware, routes, or business logic! Output the COMPLETELY FIXED file from start to finish.`;
                                    let healedCodeBuffer = "";
                                    await (0, llmService_1.streamQwenForCode)("Fix Live Compilation Errors", [], healContext, data.codingStyle, [], {
                                        onSetup: async () => { },
                                        onCommand: async (cmd) => {
                                            generatedCommand = cmd;
                                        },
                                        onToken: async (token) => {
                                            const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                            healedCodeBuffer += cleanToken;
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: cleanToken });
                                        }
                                    }, this._activeTaskController?.signal);
                                    await editor.edit(b => {
                                        const finalLine = Math.max(0, document.lineCount - 1);
                                        const finalChar = document.lineCount > 0 ? document.lineAt(finalLine).text.length : 0;
                                        b.delete(new vscode.Range(0, 0, finalLine, finalChar));
                                        b.insert(new vscode.Position(0, 0), mergedHeader + healedCodeBuffer);
                                    });
                                    await document.save();
                                    finalPerfectCode = healedCodeBuffer;
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'success', description: 'TDD Auto-Heal Passed', details: `Syntax errors resolved autonomously.` });
                                }
                                else {
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'success', description: 'TDD Post-Check Passed', details: `Zero syntax errors detected.` });
                                }
                                const finalSafeLine = Math.max(0, editor.document.lineCount - 1);
                                let status = this._tracker?.trackStreamedReview(editor, currentFileContent, data.task, 0, finalSafeLine) || "reviewing";
                                try {
                                    await (0, importResolver_1.resolveMissingImports)(editor);
                                }
                                catch (e) { }
                                if (generatedCommand)
                                    await this.confirmAndRunCommand(generatedCommand, rootUri.fsPath, `Running command...`);
                                const waitTime = ((streamStartTime - taskStartTime) / 1000).toFixed(1);
                                const genTime = ((streamEndTime - streamStartTime) / 1000).toFixed(1);
                                const totalTime = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                                webviewView.webview.postMessage({
                                    type: 'taskCompleted',
                                    task: data.task,
                                    status,
                                    filepath: realFilepath,
                                    summary: `Updated ${realFilepath} (Wait: ${waitTime}s | Gen: ${genTime}s | Total: ${totalTime}s)`
                                });
                                try {
                                    const nexusDir = vscode.Uri.joinPath(rootUri, 'nexuscode');
                                    const tasksMdUri = vscode.Uri.joinPath(nexusDir, 'tasks.md');
                                    let mdContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(tasksMdUri));
                                    // Check off the task whether it's bolded or plain text
                                    mdContent = mdContent.replace(`[ ] **${data.task}**`, `[x] **${data.task}**`);
                                    mdContent = mdContent.replace(`[ ] ${data.task}`, `[x] ${data.task}`);
                                    await vscode.workspace.fs.writeFile(tasksMdUri, Buffer.from(mdContent, 'utf8'));
                                }
                                catch (e) {
                                    console.warn("[DEBUG] Could not auto-update tasks.md");
                                }
                                // 🔥 ENHANCEMENT A: The Living PRD Engine (Auto-Code execution)
                                try {
                                    if (this._activeRequirements) {
                                        this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus QA: Scanning code to update Living PRD...` });
                                        const reqMdUri = vscode.Uri.joinPath(rootUri, 'nexuscode', 'requirements.md');
                                        let currentPRD = this._activeRequirements;
                                        const prdUpdates = await (0, llmService_1.askQwenToUpdatePRD)(currentPRD, data.task, realFilepath, finalPerfectCode);
                                        if (prdUpdates.length > 0) {
                                            prdUpdates.forEach(update => {
                                                // Surgically replace unchecked boxes with checked ones
                                                currentPRD = currentPRD.replace(update.original, update.updated);
                                            });
                                            await vscode.workspace.fs.writeFile(reqMdUri, Buffer.from(currentPRD, 'utf8'));
                                            this._activeRequirements = currentPRD; // Update memory
                                            // Tell UI it was successful
                                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `✅ Living PRD Updated (${prdUpdates.length} criteria met)` });
                                            setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 4000);
                                        }
                                    }
                                }
                                catch (e) {
                                    console.warn("[DEBUG] Living PRD QA check failed", e);
                                }
                                success = true; // Break the retry loop!
                            }
                            catch (error) {
                                if (error.name === 'AbortError') {
                                    webviewView.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'error', summary: `🛑 Cancelled` });
                                    break;
                                }
                                attempt++;
                                if (attempt > MAX_RETRIES) {
                                    const totalFailTime = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                                    webviewView.webview.postMessage({
                                        type: 'taskCompleted',
                                        task: data.task,
                                        status: 'error',
                                        summary: `⚠️ Failed after ${MAX_RETRIES} attempts (${totalFailTime}s)`
                                    });
                                }
                            }
                        }
                        this._activeTaskController = undefined;
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    });
                    break;
                }
                case "refreshCodeLens": {
                    vscode.commands.executeCommand('nexuscode.refreshLens');
                    break;
                }
                case "searchFiles": {
                    const files = await vscode.workspace.findFiles(`**/*${data.query}*`, '{**/node_modules/**,**/.git/**,**/dist/**}', 10);
                    const results = files.map(f => vscode.workspace.asRelativePath(f));
                    webviewView.webview.postMessage({ type: 'searchResults', results });
                    break;
                }
                case "showDiff": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const fileUri = vscode.Uri.joinPath(rootUri, data.filepath);
                    const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);
                    await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, `NexusCode Diff: ${path.basename(data.filepath)}`);
                    break;
                }
                case "readFileContext": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
                    const fileUri = vscode.Uri.joinPath(this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri, data.file);
                    try {
                        const content = await vscode.workspace.fs.readFile(fileUri);
                        const code = new TextDecoder().decode(content);
                        const ext = path.extname(data.file).substring(1);
                        webviewView.webview.postMessage({
                            type: 'addContext',
                            file: data.file,
                            code: code,
                            language: ext || 'text'
                        });
                    }
                    catch (e) {
                        console.error("Failed to read file for context:", e);
                    }
                    break;
                }
                case "executeAllTasks": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
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
                                if (token.isCancellationRequested)
                                    break;
                                const batch = data.tasks.slice(i, i + BATCH_SIZE);
                                const batchNum = Math.ceil((i + 1) / BATCH_SIZE);
                                const totalBatches = Math.ceil(data.tasks.length / BATCH_SIZE);
                                progress.report({ message: `Drafting batch ${batchNum}/${totalBatches}...` });
                                this._view?.webview.postMessage({ type: 'statusUpdate', message: `Drafting batch ${batchNum}/${totalBatches}: ${batch[0]}...` });
                                try {
                                    const batchEdits = await (0, llmService_1.askQwenForAtomicEdits)(batch, projectContext, data.codingStyle);
                                    allEdits.push(...batchEdits);
                                }
                                catch (e) { }
                            }
                            if (token.isCancellationRequested)
                                return;
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
                    if (!workspaceFolders || !data.edits)
                        return;
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
                            webviewView.webview.postMessage({ type: 'allTasksCompleted', status: 'approved' });
                            vscode.window.showInformationMessage("Atomic Transaction Committed with AI Metadata.");
                        }
                    });
                    break;
                }
                case "generateAndRunTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const activeEditor = vscode.window.activeTextEditor;
                    if (!workspaceFolders || !activeEditor)
                        return;
                    const workspacePath = workspaceFolders[0].uri.fsPath;
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode is writing and executing tests...",
                        cancellable: false
                    }, async () => {
                        try {
                            const relativeFileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                            const testPlan = await (0, llmService_1.askQwenForTests)(relativeFileName, activeEditor.document.getText());
                            if (activeEditor.document.isDirty)
                                await activeEditor.document.save();
                            if (testPlan.installCommand) {
                                const installResult = await this.confirmAndRunCommand(testPlan.installCommand, workspacePath, 'Installing dependencies...');
                                if (!installResult)
                                    return;
                            }
                            let safePath = testPlan.filepath.replace(/^[\\\/]+/, '');
                            if (safePath.toLowerCase().includes(workspacePath.toLowerCase())) {
                                safePath = safePath.substring(safePath.toLowerCase().indexOf(workspacePath.toLowerCase()) + workspacePath.length);
                            }
                            const testFileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, safePath);
                            const edit = new vscode.WorkspaceEdit();
                            edit.createFile(testFileUri, { ignoreIfExists: true });
                            edit.insert(testFileUri, new vscode.Position(0, 0), testPlan.code);
                            await vscode.workspace.applyEdit(edit);
                            const doc = await vscode.workspace.openTextDocument(testFileUri);
                            await vscode.window.showTextDocument(doc);
                            await doc.save();
                            const result = await this.confirmAndRunCommand(testPlan.testCommand, workspacePath, 'Running tests...');
                            if (!result) {
                                webviewView.webview.postMessage({ type: 'statusUpdate', message: '' });
                                return;
                            }
                            if (!result.success) {
                                webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Tests failed. Auto-healing...' });
                                try {
                                    const fixResult = await (0, llmService_1.askQwenToFixError)(result.output, relativeFileName, activeEditor.document.getText(), safePath, testPlan.code);
                                    const fileToFixUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fixResult.filepath);
                                    const fixEdit = new vscode.WorkspaceEdit();
                                    const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                                    fixEdit.replace(fileToFixUri, new vscode.Range(0, 0, docToFix.lineCount, 0), fixResult.code);
                                    await vscode.workspace.applyEdit(fixEdit);
                                    await docToFix.save();
                                    webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Re-running tests after heal...' });
                                    const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);
                                    if (retryResult?.success)
                                        vscode.window.showInformationMessage(`Auto-Heal successful! Fixed ${fixResult.filepath}`);
                                    else
                                        vscode.window.showErrorMessage("Auto-Heal attempted, but tests still failing.");
                                }
                                catch (e) {
                                    vscode.window.showErrorMessage("Auto-heal failed to parse LLM output.");
                                }
                            }
                            else {
                                vscode.window.showInformationMessage("All tests passed on the first try!");
                            }
                            webviewView.webview.postMessage({ type: 'statusUpdate', message: '' });
                        }
                        catch (error) {
                            vscode.window.showErrorMessage("Failed to generate or run tests.");
                        }
                    });
                    break;
                }
                case "requestModels": {
                    const models = await (0, llmService_1.getAvailableModels)();
                    const currentModel = vscode.workspace.getConfiguration('nexuscode').get('model');
                    webviewView.webview.postMessage({
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
            }
        });
    }
    _getHtmlForWebview(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "style.css"));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${styleUri}" rel="stylesheet"></head><body><div id="root"></div><script type="module" src="${scriptUri}"></script></body></html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
//# sourceMappingURL=SidebarProvider.js.map