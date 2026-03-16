// src/SidebarProvider.ts
import * as vscode from "vscode";
import * as path from 'path';

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
    getAvailableModels // 🔥 ADD THIS HERE
} from "./llmService";

// Context Managers
import { getProjectContext } from "./projectContext";
import { getLspContext } from './context/lspContext';
import { getProjectStyleGuides } from './context/styleContext';
import { indexWorkspace, retrieveContext } from './context/ragIndexer';

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

export class SidebarProvider implements vscode.WebviewViewProvider {
    public _view?: vscode.WebviewView;
    private _tracker?: ProvenanceTracker;
    private _terminalManager?: TerminalManager;
    private _metaManager?: MetaContextManager;
    
    private _lastActiveFile?: string;
    private _isMetaMode: boolean = false;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public setTerminalManager(manager: TerminalManager) { this._terminalManager = manager; }
    public setProvenanceTracker(tracker: ProvenanceTracker) { this._tracker = tracker; }
    public setMetaManager(manager: MetaContextManager) { this._metaManager = manager; }

    public toggleMetaMode() {
        this._isMetaMode = !this._isMetaMode;
        const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
        vscode.window.showWarningMessage(`Switched to: ${mode}`);
        this._view?.webview.postMessage({ type: 'metaModeChanged', value: this._isMetaMode });
    }

    private async getTargetContext(): Promise<string> {
        if (this._isMetaMode) return this._extensionUri.fsPath;
        return vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
    }

    // --- 🛡️ ENTERPRISE GUARDRAIL: Human-in-the-Loop Command Execution ---
    private async confirmAndRunCommand(command: string, workspacePath: string, progressMessage: string): Promise<{success: boolean, output: string} | undefined> {
        const userChoice = await vscode.window.showWarningMessage(
            `🤖 NexusCode wants to execute a terminal command:\n\n\`${command}\``,
            { modal: true },
            "Run Command", 
            "Deny"
        );

        if (userChoice === "Run Command") {
            this._view?.webview.postMessage({ type: 'statusUpdate', message: progressMessage });
            return await this._terminalManager?.runCommandWithCapture(command, workspacePath);
        } else {
            vscode.window.showInformationMessage("Command execution cancelled by user.");
            return undefined; 
        }
    }

    public async handlePostApproval(uri: vscode.Uri) {
        if (!this._isMetaMode) return;

        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) await document.save();

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

    public resolveWebviewView(webviewView: vscode.WebviewView) {
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
                        
                        await indexWorkspace((msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));
                        const fileTree = await getProjectContext(await this.getTargetContext());
                        const ragContext = await retrieveContext(data.value); 
                        
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting plan..." });
                        const structure = await askQwenForStructure(data.value, `${fileTree}\n\n${ragContext}`);

                        const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                        const { finalPaths, renamingMap } = await resolveCanonicalPaths(structure.folderStructure, rootSearchPath);
                        structure.folderStructure = finalPaths;

                        structure.implementationTasks = structure.implementationTasks.map(task => {
                            let updatedTask = task;
                            renamingMap.forEach((realPath, plannedPath) => {
                                const plannedName = path.basename(plannedPath);
                                if (updatedTask.includes(plannedPath)) updatedTask = updatedTask.replace(plannedPath, realPath);
                                else if (updatedTask.includes(plannedName)) updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`);
                            });
                            return updatedTask;
                        });

                        if (structure.folderStructure.length > 0) {
                            await createWorkspaceStructure(structure.folderStructure);
                        }

                        webviewView.webview.postMessage({ type: "structureResponse", value: structure });
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    } catch (error) {
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
                    if (!workspaceFolders) return;
                    
                    const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const projectStructure = await getProjectContext(contextRoot);

                    const lowerTask = data.task.toLowerCase();
                    const isReadOnly = (lowerTask.startsWith("open") || lowerTask.startsWith("locate")) && !lowerTask.includes("fix");

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: this._isMetaMode ? "⚠️ NexusCode Self-Evolving..." : "NexusCode is working...",
                        cancellable: false
                    }, async (progress) => {
                        try {
                            progress.report({ message: "Gathering Intelligence..." });
                            
                            const [lspContext, styleGuide, ragContext] = await Promise.all([
                                getLspContext(data.task),
                                getProjectStyleGuides(),
                                retrieveContext(data.task)
                            ]);

                            const smartContext = await runAgenticExploration(
                                data.task, rootUri.fsPath, 
                                (msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg })
                            );

                            progress.report({ message: "Locating target file..." });
                            let targetFilepath = "";
                            const explicitPathMatch = data.task.match(/[a-zA-Z0-9_\-\/\\]+\.[a-zA-Z0-9]+/);

                            if (isReadOnly && explicitPathMatch) {
                                targetFilepath = explicitPathMatch[0];
                            } else {
                                const targetInfo = await askQwenForTargetFile(data.task, projectStructure, this._lastActiveFile);
                                targetFilepath = targetInfo.filepath;
                            }

                            const { finalPaths } = await resolveCanonicalPaths([targetFilepath], contextRoot);
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
                            } catch { }

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
                                } catch (e) {}
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

                            await streamQwenForCode(
                                data.task, [], promptContext, data.codingStyle, [],
                                {
                                    onSetup: async (action: string, filepath: string, target?: string) => {
                                        streamAction = !fileExists ? 'replace' : action;
                                        
                                        if (streamAction === 'replace') {
                                            await editor.edit(b => b.delete(new vscode.Range(0, 0, document.lineCount, 0)));
                                            currentPosition = new vscode.Position(0, 0);
                                            streamStartLine = 0; 
                                        } else if (streamAction === 'append') {
                                            currentPosition = new vscode.Position(document.lineCount, 0);
                                            await editor.edit(b => b.insert(currentPosition, "\n\n"));
                                            currentPosition = new vscode.Position(document.lineCount, 0);
                                            streamStartLine = document.lineCount - 1; 
                                        } else if (streamAction === 'inject' && target) {
                                            const injectionPos = await getInjectionPosition(this._extensionUri, document, target);
                                            if (injectionPos) {
                                                currentPosition = injectionPos;
                                                await editor.edit(b => b.insert(currentPosition, "\n    "));
                                                currentPosition = new vscode.Position(injectionPos.line + 1, 4);
                                                streamStartLine = currentPosition.line;
                                            } else {
                                                streamAction = 'append';
                                                currentPosition = new vscode.Position(document.lineCount, 0);
                                                await editor.edit(b => b.insert(currentPosition, "\n\n"));
                                                currentPosition = new vscode.Position(document.lineCount, 0);
                                                streamStartLine = document.lineCount - 1;
                                            }
                                        }
                                    },
                                    onToken: async (token: string) => {
                                        if (token.includes('<command>')) {
                                            const match = token.match(/<command>(.*?)<\/command>/s);
                                            if (match) generatedCommand = match[1];
                                        }

                                        const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                        fullGeneratedCode += cleanToken;

                                        await editor.edit(b => b.insert(currentPosition, cleanToken), { undoStopBefore: false, undoStopAfter: false }); 
                                        
                                        const lines = cleanToken.split('\n');
                                        if (lines.length > 1) {
                                            currentPosition = new vscode.Position(currentPosition.line + lines.length - 1, lines[lines.length - 1].length);
                                        } else {
                                            currentPosition = new vscode.Position(currentPosition.line, currentPosition.character + cleanToken.length);
                                        }
                                        editor.revealRange(new vscode.Range(currentPosition, currentPosition), vscode.TextEditorRevealType.Default);
                                    }
                                }
                            );

                            let status = "reviewing";
                            if (streamAction === 'replace') {
                                const mergedHeader = getAIHeader(realFilepath, data.task, originalContentForDiff);
                                await editor.edit(b => b.insert(new vscode.Position(0, 0), mergedHeader + "\n"));
                                status = this._tracker?.trackStreamedReview(editor, originalContentForDiff, data.task, 0, editor.document.lineCount) || "reviewing";
                            } else {
                                const aiHeader = getAIHeader(realFilepath, data.task);
                                await editor.edit(b => b.insert(new vscode.Position(streamStartLine, 0), aiHeader));
                                status = this._tracker?.trackStreamedReview(editor, originalContentForDiff, data.task, streamStartLine, editor.document.lineCount) || "reviewing";
                            }

                            try { await resolveMissingImports(editor); } catch (e) { }

                            // 🛡️ Trigger Human-in-the-Loop guardrail if a command was generated
                            if (generatedCommand) {
                                await this.confirmAndRunCommand(generatedCommand, rootUri.fsPath, `Running command...`);
                            }

                            webviewView.webview.postMessage({ type: 'taskCompleted', task: data.task, status, summary });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });

                        } catch (error) {
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
                    if (!workspaceFolders) return;

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
                                if (token.isCancellationRequested) break;
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

                            if (token.isCancellationRequested) return;

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
                    if (!workspaceFolders || !data.edits) return;

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

                            webviewView.webview.postMessage({ type: 'allTasksCompleted', status: 'approved' });
                            vscode.window.showInformationMessage("Atomic Transaction Committed with AI Metadata.");
                        }
                    });
                    break;
                }

                case "generateAndRunTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const activeEditor = vscode.window.activeTextEditor;
                    if (!workspaceFolders || !activeEditor) return;
                    
                    const workspacePath = workspaceFolders[0].uri.fsPath;

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode is writing and executing tests...",
                        cancellable: false
                    }, async () => {
                        try {
                            const relativeFileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                            const testPlan = await askQwenForTests(relativeFileName, activeEditor.document.getText());
                            if (activeEditor.document.isDirty) await activeEditor.document.save();

                            if (testPlan.installCommand) {
                                const installResult = await this.confirmAndRunCommand(testPlan.installCommand, workspacePath, 'Installing dependencies...');
                                if (!installResult) return; 
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
                                    const fixResult = await askQwenToFixError(
                                        result.output, relativeFileName, activeEditor.document.getText(), safePath, testPlan.code
                                    );

                                    const fileToFixUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fixResult.filepath);
                                    const fixEdit = new vscode.WorkspaceEdit();
                                    const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                                    fixEdit.replace(fileToFixUri, new vscode.Range(0, 0, docToFix.lineCount, 0), fixResult.code);
                                    
                                    await vscode.workspace.applyEdit(fixEdit);
                                    await docToFix.save();

                                    webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Re-running tests after heal...' });
                                    const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);

                                    if (retryResult?.success) vscode.window.showInformationMessage(`Auto-Heal successful! Fixed ${fixResult.filepath}`);
                                    else vscode.window.showErrorMessage("Auto-Heal attempted, but tests still failing.");
                                    
                                } catch (e) {
                                    vscode.window.showErrorMessage("Auto-heal failed to parse LLM output.");
                                }
                            } else {
                                vscode.window.showInformationMessage("All tests passed on the first try!");
                            }
                            webviewView.webview.postMessage({ type: 'statusUpdate', message: '' });

                        } catch (error) {
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
                    const models = await getAvailableModels();
                    const currentModel = vscode.workspace.getConfiguration('nexuscode').get<string>('model');
                    
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

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "style.css"));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${styleUri}" rel="stylesheet"></head><body><div id="root"></div><script type="module" src="${scriptUri}"></script></body></html>`;
    }
}