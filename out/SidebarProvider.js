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
// AI Services & Tools
const llmService_1 = require("./llmService");
// Context Managers
const projectContext_1 = require("./projectContext");
const lspContext_1 = require("./context/lspContext");
const styleContext_1 = require("./context/styleContext");
const ragIndexer_1 = require("./context/ragIndexer");
// Utilities
const importResolver_1 = require("./utilities/importResolver");
const commentStyles_1 = require("./utilities/commentStyles");
const pathUtils_1 = require("./utilities/pathUtils");
const symbolManager_1 = require("./utilities/symbolManager");
const workspaceManager_1 = require("./workspaceManager");
class SidebarProvider {
    _extensionUri;
    _view;
    _tracker;
    _terminalManager;
    _metaManager;
    _lastActiveFile;
    _isMetaMode = false;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    setTerminalManager(manager) { this._terminalManager = manager; }
    setProvenanceTracker(tracker) { this._tracker = tracker; }
    setMetaManager(manager) { this._metaManager = manager; }
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
        const userChoice = await vscode.window.showWarningMessage(`🤖 NexusCode wants to execute a terminal command:\n\n\`${command}\``, { modal: true }, "Run Command", "Deny");
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
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        this._tracker?.setView(webviewView);
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "generateStructure": {
                    // 🔥 Wrap in try/catch to prevent unhandled promise rejections
                    try {
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Searching Hybrid Vector Server..." });
                        await (0, ragIndexer_1.indexWorkspace)((msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));
                        const fileTree = await (0, projectContext_1.getProjectContext)(await this.getTargetContext());
                        const ragContext = await (0, ragIndexer_1.retrieveContext)(data.value);
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting plan..." });
                        const structure = await (0, llmService_1.askQwenForStructure)(data.value, `${fileTree}\n\n${ragContext}`);
                        const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                        const { finalPaths, renamingMap } = await (0, pathUtils_1.resolveCanonicalPaths)(structure.folderStructure, rootSearchPath);
                        structure.folderStructure = finalPaths;
                        structure.implementationTasks = structure.implementationTasks.map(task => {
                            let updatedTask = task;
                            renamingMap.forEach((realPath, plannedPath) => {
                                const plannedName = path.basename(plannedPath);
                                if (updatedTask.includes(plannedPath))
                                    updatedTask = updatedTask.replace(plannedPath, realPath);
                                else if (updatedTask.includes(plannedName))
                                    updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`);
                            });
                            return updatedTask;
                        });
                        if (structure.folderStructure.length > 0) {
                            await (0, workspaceManager_1.createWorkspaceStructure)(structure.folderStructure);
                        }
                        webviewView.webview.postMessage({ type: "structureResponse", value: structure });
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    }
                    catch (error) {
                        // 🔥 Catch the error and notify the UI
                        console.error("Structure generation error:", error);
                        vscode.window.showErrorMessage(`NexusCode Error: ${error instanceof Error ? error.message : "Failed to generate structure. Is the LLM running?"}`);
                        // Tell the UI to stop spinning
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        this._view?.webview.postMessage({ type: 'taskCompleted', status: 'error' });
                    }
                    break;
                }
                case "executeTask": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders)
                        return;
                    const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const projectStructure = await (0, projectContext_1.getProjectContext)(contextRoot);
                    const lowerTask = data.task.toLowerCase();
                    const isReadOnly = (lowerTask.startsWith("open") || lowerTask.startsWith("locate")) && !lowerTask.includes("fix");
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: this._isMetaMode ? "⚠️ NexusCode Self-Evolving..." : "NexusCode is working...",
                        cancellable: false
                    }, async (progress) => {
                        try {
                            const [lspContext, styleGuide, ragContext] = await Promise.all([
                                (0, lspContext_1.getLspContext)(data.task),
                                (0, styleContext_1.getProjectStyleGuides)(),
                                (0, ragIndexer_1.retrieveContext)(data.task)
                            ]);
                            const smartContext = await (0, llmService_1.runAgenticExploration)(data.task, rootUri.fsPath, (msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));
                            progress.report({ message: "Locating target file..." });
                            let targetFilepath = "";
                            const explicitPathMatch = data.task.match(/[a-zA-Z0-9_\-\/\\]+\.[a-zA-Z0-9]+/);
                            if (isReadOnly && explicitPathMatch) {
                                targetFilepath = explicitPathMatch[0];
                            }
                            else {
                                const targetInfo = await (0, llmService_1.askQwenForTargetFile)(data.task, projectStructure, this._lastActiveFile);
                                targetFilepath = targetInfo.filepath;
                            }
                            const { finalPaths } = await (0, pathUtils_1.resolveCanonicalPaths)([targetFilepath], contextRoot);
                            const realFilepath = finalPaths[0] || targetFilepath;
                            this._lastActiveFile = realFilepath;
                            const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);
                            if (isReadOnly) {
                                const document = await vscode.workspace.openTextDocument(fileUri);
                                await vscode.window.showTextDocument(document, { preview: false });
                                webviewView.webview.postMessage({ type: 'taskCompleted', task: data.task, status: 'approved', summary: `📂 Opened ${realFilepath}` });
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
                            const contextPayload = currentFileContent.length > 20000
                                ? `[LARGE FILE - HEADERS ONLY]\n${currentFileContent.substring(0, 2000)}...`
                                : currentFileContent;
                            const promptContext = `
                                --- AUTONOMOUSLY GATHERED CONTEXT ---
                                ${smartContext}
                                ${ragContext}
                                Target File: ${realFilepath}
                                Content:\n\`\`\`\n${contextPayload}\n\`\`\`
                                File Exists: ${fileExists}
                                ${lspContext}
                                ${styleGuide}
                            `;
                            progress.report({ message: "Writing Code Live..." });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Streaming into ${realFilepath}...` });
                            let summary = `Updated ${realFilepath}`;
                            if (!fileExists) {
                                try {
                                    const parentDir = vscode.Uri.joinPath(rootUri, path.dirname(realFilepath));
                                    await vscode.workspace.fs.createDirectory(parentDir);
                                }
                                catch (e) { }
                                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                summary = `✨ Created ${realFilepath}`;
                            }
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            const editor = await vscode.window.showTextDocument(document, { preview: false });
                            let streamAction = 'replace';
                            let currentPosition = new vscode.Position(0, 0);
                            let streamStartLine = 0;
                            let fullGeneratedCode = "";
                            let generatedCommand = "";
                            const originalContentForDiff = currentFileContent;
                            await (0, llmService_1.streamQwenForCode)(data.task, [], promptContext, data.codingStyle, [], {
                                onReasoning: async (token) => {
                                    this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: token });
                                },
                                onSetup: async (action, filepath, target) => {
                                    streamAction = !fileExists ? 'replace' : action;
                                    if (streamAction === 'replace') {
                                        await editor.edit(b => b.delete(new vscode.Range(0, 0, document.lineCount, 0)));
                                        currentPosition = new vscode.Position(0, 0);
                                        streamStartLine = 0;
                                    }
                                    else if (streamAction === 'append') {
                                        currentPosition = new vscode.Position(document.lineCount, 0);
                                        await editor.edit(b => b.insert(currentPosition, "\n\n"));
                                        currentPosition = new vscode.Position(document.lineCount, 0);
                                        streamStartLine = document.lineCount - 1;
                                    }
                                    else if (streamAction === 'inject' && target) {
                                        const injectionPos = await (0, symbolManager_1.getInjectionPosition)(this._extensionUri, document, target);
                                        if (injectionPos) {
                                            currentPosition = injectionPos;
                                            await editor.edit(b => b.insert(currentPosition, "\n    "));
                                            currentPosition = new vscode.Position(injectionPos.line + 1, 4);
                                            streamStartLine = currentPosition.line;
                                        }
                                        else {
                                            streamAction = 'append';
                                            currentPosition = new vscode.Position(document.lineCount, 0);
                                            await editor.edit(b => b.insert(currentPosition, "\n\n"));
                                            currentPosition = new vscode.Position(document.lineCount, 0);
                                            streamStartLine = document.lineCount - 1;
                                        }
                                    }
                                },
                                onToken: async (token) => {
                                    if (token.includes('<command>')) {
                                        const match = token.match(/<command>(.*?)<\/command>/s);
                                        if (match)
                                            generatedCommand = match[1];
                                    }
                                    const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                    fullGeneratedCode += cleanToken;
                                    await editor.edit(b => b.insert(currentPosition, cleanToken), { undoStopBefore: false, undoStopAfter: false });
                                    const lines = cleanToken.split('\n');
                                    if (lines.length > 1) {
                                        currentPosition = new vscode.Position(currentPosition.line + lines.length - 1, lines[lines.length - 1].length);
                                    }
                                    else {
                                        currentPosition = new vscode.Position(currentPosition.line, currentPosition.character + cleanToken.length);
                                    }
                                    editor.revealRange(new vscode.Range(currentPosition, currentPosition), vscode.TextEditorRevealType.Default);
                                }
                            });
                            let status = "reviewing";
                            if (streamAction === 'replace') {
                                const mergedHeader = (0, commentStyles_1.getAIHeader)(realFilepath, data.task, originalContentForDiff);
                                await editor.edit(b => b.insert(new vscode.Position(0, 0), mergedHeader + "\n"));
                                status = this._tracker?.trackStreamedReview(editor, originalContentForDiff, data.task, 0, editor.document.lineCount) || "reviewing";
                            }
                            else {
                                const aiHeader = (0, commentStyles_1.getAIHeader)(realFilepath, data.task);
                                await editor.edit(b => b.insert(new vscode.Position(streamStartLine, 0), aiHeader));
                                status = this._tracker?.trackStreamedReview(editor, originalContentForDiff, data.task, streamStartLine, editor.document.lineCount) || "reviewing";
                            }
                            try {
                                await (0, importResolver_1.resolveMissingImports)(editor);
                            }
                            catch (e) { }
                            // 🛡️ Trigger Human-in-the-Loop guardrail if a command was generated
                            if (generatedCommand) {
                                await this.confirmAndRunCommand(generatedCommand, rootUri.fsPath, `Running command...`);
                            }
                            webviewView.webview.postMessage({ type: 'taskCompleted', task: data.task, status, summary });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                        }
                        catch (error) {
                            console.error("Execution error:", error);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                            webviewView.webview.postMessage({
                                type: 'taskCompleted', task: data.task, status: 'error',
                                summary: `⚠️ Error: ${error instanceof Error ? error.message : "Unknown error"}`
                            });
                        }
                    });
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
                case "toggleMetaMode": {
                    this.toggleMetaMode();
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