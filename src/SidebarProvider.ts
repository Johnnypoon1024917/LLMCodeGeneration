// src/SidebarProvider.ts
import * as vscode from "vscode";
import * as path from 'path';
import { globalContext } from './extension';
import { originalContentProvider } from './diffProvider';
import { getSmartASTContext } from './context/codeGraph';

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
    streamQwenChat
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

function injectCodeIntoContent(originalContent: string, target: string, newCode: string, action: string): string {
    if (action === 'replace') return newCode;
    if (action === 'append') return originalContent + "\n\n" + newCode;

    // For 'inject', we must find the target and surgically replace it
    if (!target) return originalContent + "\n\n" + newCode; // Fallback

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
            if (char === '{') { braces++; foundBrace = true; }
            if (char === '}') { braces--; }
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

export class SidebarProvider implements vscode.WebviewViewProvider {
    public _view?: vscode.WebviewView;
    private _tracker?: ProvenanceTracker;
    private _terminalManager?: TerminalManager;
    private _metaManager?: MetaContextManager;
    private _activeTaskController?: AbortController;

    private _lastActiveFile?: string;
    private _isMetaMode: boolean = false;

    constructor(private readonly _extensionUri: vscode.Uri) { }

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
            this._view.webview.postMessage({ 
                type: 'injectTerminalTask', 
                task: prompt 
            });
        }
    }


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
    private async confirmAndRunCommand(command: string, workspacePath: string, progressMessage: string): Promise<{ success: boolean, output: string } | undefined> {
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

    public async resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        this._tracker?.setView(webviewView);
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 🔥 ENTERPRISE UPGRADE: Load Session and Auth State
        const chatHistory = globalContext.globalState.get<any[]>('nexus_chat_history') || [];
        const taskStatuses = globalContext.globalState.get<any>('nexus_task_statuses') || {};
        const taskSummaries = globalContext.globalState.get<any>('nexus_task_summaries') || {};
        const hasApiKey = !!(await globalContext.secrets.get('nexuscode_apikey'));

        // Send initial state to React
        webviewView.webview.postMessage({
            type: 'initState',
            messages: chatHistory,
            taskStatuses: taskStatuses,
            taskSummaries: taskSummaries,
            hasKey: hasApiKey
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "requestRevision": {
                    const feedback = await vscode.window.showInputBox({
                        prompt: `Why was the code for "${data.task}" rejected?`,
                        placeHolder: "e.g., 'Use axios instead of fetch', or 'Fix the null pointer error'"
                    });

                    if (feedback === undefined) return; // User pressed Esc to cancel

                    // Tell React to reset the UI and restart the task with the new feedback
                    this._view?.webview.postMessage({
                        type: 'startRevision',
                        task: data.task,
                        feedback: feedback || "The previous attempt was rejected. Try a different approach and ensure the code is completely bug-free."
                    });
                    break;
                }

                case "syncHistory":
                    await globalContext.globalState.update('nexus_chat_history', data.messages);
                    await globalContext.globalState.update('nexus_task_statuses', data.taskStatuses);
                    await globalContext.globalState.update('nexus_task_summaries', data.taskSummaries);
                    break;

                case "clearHistory":
                    await globalContext.globalState.update('nexus_chat_history', []);
                    await globalContext.globalState.update('nexus_task_statuses', {});
                    await globalContext.globalState.update('nexus_task_summaries', {});
                    break;

                case "saveApiKey":
                    await globalContext.secrets.store('nexuscode_apikey', data.value);
                    vscode.window.showInformationMessage("NexusCode: API Key Saved Securely!");
                    webviewView.webview.postMessage({ type: 'initState', messages: chatHistory, hasKey: true });
                    break;

                case "processUserMessage": {
                    console.log("[DEBUG] 📥 Received message from UI:", data.text);
                    this._activeTaskController = new AbortController();
                    try {
                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Analyzing intent..." });

                        console.log("[DEBUG] 🧠 Determining intent...");
                        const intent = await determineIntent(data.text);
                        console.log(`[DEBUG] 🎯 Intent determined as: [${intent.toUpperCase()}]`);

                        // Combine text and context for the LLM
                        const fullPrompt = data.context
                            ? `--- ATTACHED CONTEXT ---\n${data.context}\n\n--- USER QUERY ---\n${data.text}`
                            : data.text;

                        if (intent === 'build') {
                            console.log("[DEBUG] 🛠️ Entering BUILD pipeline");
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting plan..." });

                            // 🔥 Initialize chat bubble for the pre-explanation
                            this._view?.webview.postMessage({ type: 'startChatStream' });

                            await indexWorkspace((msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }));


                            const [lspContext, styleGuide, astContext, hybridContext] = await Promise.all([
                                getLspContext(data.task),
                                getProjectStyleGuides(),
                                getSmartASTContext(data.task),       // 🌳 Pillar 1
                                retrieveHybridContext(data.task, 5)  // 🔍 Pillar 2
                            ]);

                            const finalContext = `${lspContext}\n\n${astContext}\n\n${hybridContext}\n\n${styleGuide}`;

                            const result = await askQwenForStructure(fullPrompt, finalContext);

                            // Stream the explanation to the UI
                            this._view?.webview.postMessage({ type: 'chatToken', token: result.explanation + "\n\n" });

                            const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                            const { finalPaths, renamingMap } = await resolveCanonicalPaths(result.plan.folderStructure, rootSearchPath);
                            result.plan.folderStructure = finalPaths;

                            result.plan.implementationTasks = result.plan.implementationTasks.map(task => {
                                let updatedTask = task;
                                renamingMap.forEach((realPath, plannedPath) => {
                                    const plannedName = path.basename(plannedPath);
                                    if (updatedTask.includes(plannedPath)) updatedTask = updatedTask.replace(plannedPath, realPath);
                                    else if (updatedTask.includes(plannedName)) updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`);
                                });
                                return updatedTask;
                            });

                            if (result.plan.folderStructure.length > 0) await createWorkspaceStructure(result.plan.folderStructure);

                            this._view?.webview.postMessage({ type: "structureResponse", value: result.plan });
                            console.log("[DEBUG] ✅ Build plan successfully sent to UI.");

                        } else {
                            // --- CHAT & EXPLAIN PIPELINE ---
                            console.log("[DEBUG] 💬 Entering CHAT/EXPLAIN pipeline");
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Gathering context..." });

                            const workspacePath = await this.getTargetContext();
                            const ragContext = await await retrieveHybridContext(data.text, 5);

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
                                (token) => { this._view?.webview.postMessage({ type: 'chatToken', token: token }); },
                                this._activeTaskController.signal
                            );
                            console.log("[DEBUG] ✅ Chat stream completed naturally.");
                        }

                        this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    } catch (error: any) {
                        if (error.name === 'AbortError') {
                            console.log("[DEBUG] 🛑 Generation aborted by user.");
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "⚠️ Generation stopped." });
                            setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);
                        } else {
                            console.error("[DEBUG] 💥 ERROR IN processUserMessage PIPELINE:", error);
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

                        // 🔥 AUTO-CLEAR STATUS AFTER 3 SECONDS
                        setTimeout(() => this._view?.webview.postMessage({ type: 'statusUpdate', message: "" }), 3000);

                        vscode.window.showWarningMessage("NexusCode: Generation Stopped.");
                    }
                    break;
                }
                case "executeTask": {
                    console.log(`\n\n[DEBUG-EXEC] 🚀 STARTING EXECUTION FOR TASK: "${data.task}"`);
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;

                    const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                    const projectStructure = await getProjectContext(contextRoot);

                    const lowerTask = data.task.toLowerCase();
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

                                // 🔥 Kiro-Level 3-Pillar Context Engine
                                const [lspContext, styleGuide, astContext, hybridContext] = await Promise.all([
                                    getLspContext(data.task),
                                    getProjectStyleGuides(),
                                    getSmartASTContext(data.task),       // 🌳 Pillar 1
                                    retrieveHybridContext(data.task, 5)  // 🔍 Pillar 2
                                ]);

                                const smartContext = await runAgenticExploration(data.task, rootUri.fsPath, (stepType, description, details) => {
                                    webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType, description, details });
                                });

                                let targetFilepath = "";
                                const explicitPathMatch = data.task.match(/[a-zA-Z0-9_\-\/\\]+\.[a-zA-Z0-9]+/);

                                if (isReadOnly && explicitPathMatch) targetFilepath = explicitPathMatch[0];
                                else {
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
                                } catch { }
                                const feedbackInjection = data.feedback ? 
                                    `\n\n⚠️ CRITICAL USER FEEDBACK FROM PREVIOUS REJECTION:\n"${data.feedback}"\nDo NOT repeat your previous mistakes. Incorporate this feedback perfectly.` : "";

                                // Combine all context pillars!
                                const promptContext = `--- AUTONOMOUSLY GATHERED CONTEXT ---\n${smartContext}\n${astContext}\n${hybridContext}\nTarget File: ${realFilepath}\nContent:\n\`\`\`\n${currentFileContent.substring(0, 15000)}\n\`\`\`\nFile Exists: ${fileExists}\n${lspContext}\n${styleGuide}`;

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
                                await streamQwenForCode(
                                    data.task, [], promptContext, data.codingStyle, [],
                                    {
                                        onReasoning: async (token: string) => {
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: token });
                                        },
                                        onSetup: async (action: string, filepath: string, target?: string) => {
                                            streamAction = !fileExists ? 'replace' : action;
                                            streamTarget = target || '';
                                        },
                                        onToken: async (token: string) => {
                                            if (token.includes('<command>')) {
                                                const match = token.match(/<command>(.*?)<\/command>/s);
                                                if (match) generatedCommand = match[1];
                                            }
                                            const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                            shadowCodeBuffer += cleanToken;

                                            // Stream the code into the Reasoning panel so the user can watch it write invisibly
                                            this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: cleanToken });
                                        }
                                    },
                                    this._activeTaskController?.signal
                                );

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
                                        await streamQwenForCode("Fix syntax errors", [], healContext, data.codingStyle, [], {
                                            onSetup: async () => { },
                                            onToken: async (token: string) => {
                                                const cleanToken = token.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/<\/code>/g, '').replace(/<\/code/g, '');
                                                healedCodeBuffer += cleanToken;
                                                this._view?.webview.postMessage({ type: 'streamReasoning', task: data.task, token: cleanToken });
                                            }
                                        }, this._activeTaskController?.signal);

                                        // If it heals, we assume the healer outputted the full replaced file
                                        finalPerfectCode = healedCodeBuffer;
                                        webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'success', description: 'Shadow Heal Complete', details: `Invisible syntax fix applied.` });
                                    } else {
                                        webviewView.webview.postMessage({ type: 'agentStep', task: data.task, stepType: 'success', description: 'Shadow Compile Passed', details: `Zero syntax errors detected.` });
                                    }
                                } finally {
                                    try { await vscode.workspace.fs.delete(shadowUri); } catch (e) { }
                                }

                                streamEndTime = Date.now(); // ⏱️ END GENERATION TIMER

                                // =====================================================================
                                // ✨ PHASE 3: FINAL DELIVERY (Push perfect code to active editor)
                                // =====================================================================
                                if (!fileExists) {
                                    try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(rootUri, path.dirname(realFilepath))); } catch (e) { }
                                    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                }

                                const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);
                                originalContentProvider.setContent(originalUri, currentFileContent);

                                const document = await vscode.workspace.openTextDocument(fileUri);
                                const editor = await vscode.window.showTextDocument(document, { preview: false });

                                // Safely replace the ENTIRE editor with our perfectly spliced memory buffer
                                const lastSafeLine = Math.max(0, document.lineCount - 1);
                                const lastSafeChar = document.lineCount > 0 ? document.lineAt(lastSafeLine).text.length : 0;

                                const mergedHeader = getAIHeader(realFilepath, data.task, currentFileContent) + "\n";

                                await editor.edit(b => {
                                    b.delete(new vscode.Range(0, 0, lastSafeLine, lastSafeChar));
                                    b.insert(new vscode.Position(0, 0), mergedHeader + finalPerfectCode);
                                });

                                const finalSafeLine = Math.max(0, editor.document.lineCount - 1);
                                let status = this._tracker?.trackStreamedReview(editor, currentFileContent, data.task, 0, finalSafeLine) || "reviewing";

                                try { await resolveMissingImports(editor); } catch (e) { }

                                if (generatedCommand) await this.confirmAndRunCommand(generatedCommand, rootUri.fsPath, `Running command...`);

                                // 🔥 Telemetry Calculation & Formatting
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

                                success = true; // Break the retry loop!

                            } catch (error: any) {
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
                    // Search workspace matching the query, ignore node_modules, max 10 results
                    const files = await vscode.workspace.findFiles(`**/*${data.query}*`, '{**/node_modules/**,**/.git/**,**/dist/**}', 10);
                    const results = files.map(f => vscode.workspace.asRelativePath(f));
                    webviewView.webview.postMessage({ type: 'searchResults', results });
                    break;
                }

                case "showDiff": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;
                    const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;

                    const fileUri = vscode.Uri.joinPath(rootUri, data.filepath);
                    const originalUri = vscode.Uri.parse(`nexus-original:${fileUri.path}`);

                    await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, `NexusCode Diff: ${path.basename(data.filepath)}`);
                    break;
                }

                case "readFileContext": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;

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
                    } catch (e) {
                        console.error("Failed to read file for context:", e);
                    }
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