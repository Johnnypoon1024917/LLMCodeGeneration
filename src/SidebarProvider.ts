import * as vscode from "vscode";
import { askQwenForStructure, askQwenForCode, askQwenToFixError, askQwenForTests, askQwenForTargetFile, askQwenForAtomicEdits, AtomicEdit, streamQwenForCode, runAgenticExploration } from "./llmService";
import { ProvenanceTracker } from "./provenanceTracker";
import { createWorkspaceStructure } from "./workspaceManager";
import { TerminalManager } from './terminalManager';
import { getRepoContent, getProjectContext } from "./projectContext";
import { getLspContext } from './context/lspContext';
import { getProjectStyleGuides } from './context/styleContext';
import { resolveMissingImports } from './utilities/importResolver';
import { getAIHeader } from './utilities/commentStyles';
import { resolveCanonicalPaths } from './utilities/pathUtils';
import { getInjectionPosition } from './utilities/symbolManager';
import { MetaContextManager } from "./metaContextManager";

import * as path from 'path';

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;
    _doc?: vscode.TextDocument;
    _tracker?: ProvenanceTracker;
    private _terminalManager?: TerminalManager;
    private _lastActiveFile?: string;
    private _isMetaMode: boolean = false;
    private _metaManager?: MetaContextManager;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public setTerminalManager(manager: TerminalManager) {
        this._terminalManager = manager;
    }

    public setProvenanceTracker(tracker: ProvenanceTracker) {
        this._tracker = tracker;
    }

    public setMetaManager(manager: MetaContextManager) {
        this._metaManager = manager;
    }

    public toggleMetaMode() {
        this._isMetaMode = !this._isMetaMode;
        const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
        vscode.window.showWarningMessage(`Switched to: ${mode}`);

        this._view?.webview.postMessage({ type: 'metaModeChanged', value: this._isMetaMode });
    }

    // src/SidebarProvider.ts (Add this method inside the class)

    public async handlePostApproval(uri: vscode.Uri) {
        if (!this._isMetaMode) return;

        // 1. Force save the document ONLY after human approval
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) {
            await document.save();
        }

        const filepath = uri.fsPath;

        // 2. Check if we edited the frontend (React) or backend (Extension)
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
            // Normal Extension Backend Compile
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

    // Update getProjectContext to look at ITSELF
    private async getTargetContext(): Promise<string> {
        if (this._isMetaMode) {
            // Point to the extension's own source code on disk!
            return this._extensionUri.fsPath;
        } else {
            // Normal user project
            return vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        this._tracker?.setView(webviewView);
        webviewView.webview.options = { enableScripts: true };

        // Point this to where your React app compiles
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen for messages from the React UI
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "generateStructure": {
                    // 1. SCAN THE REPO (The "Read All Code" Step)
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Scanning entire repository..." });

                    // This now returns the full ASCII tree
                    const fileTree = await getProjectContext();
                    const codeContext = await getRepoContent(40000);
                    const fullContext = `${fileTree}\n\n${codeContext}`;

                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "Nexus: Architecting..." });
                    const structure = await askQwenForStructure(data.value, fullContext);

                    // --- DEBUGGING START ---
                    console.log("AI Returned Structure:", JSON.stringify(structure));
                    // --- DEBUGGING END ---

                    // 3. Smart Deduplication (Safety Net)
                    // We keep this as a backup in case the LLM misses something in the tree
                    const rootSearchPath = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                    const { finalPaths, renamingMap } = await resolveCanonicalPaths(structure.folderStructure, rootSearchPath);
                    structure.folderStructure = finalPaths;

                    // 4. Update Task List with Real Names
                    structure.implementationTasks = structure.implementationTasks.map(task => {
                        let updatedTask = task;
                        renamingMap.forEach((realPath, plannedPath) => {
                            const plannedName = path.basename(plannedPath);

                            // Replace full path or just filename
                            if (updatedTask.includes(plannedPath)) {
                                updatedTask = updatedTask.replace(plannedPath, realPath);
                            } else if (updatedTask.includes(plannedName)) {
                                updatedTask = updatedTask.replace(plannedName, `${plannedName} (found at ${realPath})`);
                            }
                        });
                        return updatedTask;
                    });

                    // 5. Create Structure & Respond
                    if (structure.folderStructure.length > 0) {
                        await createWorkspaceStructure(structure.folderStructure);
                    }

                    webviewView.webview.postMessage({
                        type: "structureResponse",
                        value: structure
                    });

                    // Clear status
                    this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                    break;
                }

                case "executeTask": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                    const projectStructure = await getProjectContext(contextRoot);
                    const repoCode = await getRepoContent(15000, contextRoot);

                    if (!workspaceFolders) return;

                    const lowerTask = data.task.toLowerCase();
                    const isReadOnly = (
                        lowerTask.startsWith("open") ||
                        lowerTask.startsWith("locate") ||
                        lowerTask.startsWith("find") ||
                        lowerTask.includes("just open")
                    ) && !(
                        lowerTask.includes("change") ||
                        lowerTask.includes("update") ||
                        lowerTask.includes("edit") ||
                        lowerTask.includes("fix") ||
                        lowerTask.includes("add") ||
                        lowerTask.includes("remove")
                    );

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: this._isMetaMode ? "⚠️ NexusCode Self-Evolving..." : "NexusCode is working...",
                        cancellable: false
                    }, async (progress) => {
                        try {
                            // =========================================================
                            // STEP 1: GATHER INTELLIGENCE
                            // =========================================================
                            progress.report({ message: "Gathering Intelligence..." });
                            const [lspContext, styleGuide] = await Promise.all([
                                getLspContext(data.task),
                                getProjectStyleGuides()
                            ]);

                            // 🔥 NEW: Let the AI explore the codebase autonomously before writing!
                            const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;
                            const smartContext = await runAgenticExploration(
                                data.task,
                                rootUri.fsPath,
                                (msg) => this._view?.webview.postMessage({ type: 'statusUpdate', message: msg }) // Live UI updates!
                            );

                            // =========================================================
                            // STEP 2: TARGET FILE SELECTION
                            // =========================================================
                            progress.report({ message: "Locating target file..." });
                            let targetFilepath = "";
                            const explicitPathMatch = data.task.match(/[a-zA-Z0-9_\-\/\\]+\.[a-zA-Z0-9]+/);

                            if (isReadOnly && explicitPathMatch) {
                                targetFilepath = explicitPathMatch[0];
                                console.log(`[Fast-Path] Extracted path directly: ${targetFilepath}`);
                            } else {
                                const targetInfo = await askQwenForTargetFile(
                                    data.task,
                                    projectStructure,
                                    this._lastActiveFile
                                );
                                targetFilepath = targetInfo.filepath;
                            }

                            const { finalPaths } = await resolveCanonicalPaths([targetFilepath], contextRoot);
                            const realFilepath = finalPaths[0] || targetFilepath;

                            this._lastActiveFile = realFilepath;

                            // =========================================================
                            // STEP 3: PREPARE FILE CONTEXT
                            // =========================================================
                            const fileUri = vscode.Uri.joinPath(rootUri, realFilepath);

                            if (isReadOnly) {
                                const document = await vscode.workspace.openTextDocument(fileUri);
                                await vscode.window.showTextDocument(document, { preview: false });

                                webviewView.webview.postMessage({
                                    type: 'taskCompleted',
                                    task: data.task,
                                    status: 'approved',
                                    summary: `📂 Opened ${realFilepath}`
                                });
                                return;
                            }

                            let currentFileContent = "";
                            let fileExists = false;

                            try {
                                const fileData = await vscode.workspace.fs.readFile(fileUri);
                                currentFileContent = new TextDecoder().decode(fileData);
                                fileExists = true;
                            } catch {
                                currentFileContent = "";
                            }

                            const contextPayload = currentFileContent.length > 20000
                                ? `[LARGE FILE - HEADERS ONLY]\n${currentFileContent.substring(0, 2000)}...`
                                : currentFileContent;

                            const promptContext = `
                --- AUTONOMOUSLY GATHERED CONTEXT ---
                ${smartContext}
                Target File: ${realFilepath}
                Content:\n\`\`\`\n${contextPayload}\n\`\`\`
                File Exists: ${fileExists}
                ${lspContext}
                ${styleGuide}
            `;

                            // =========================================================
                            // STEP 4 & 5: LIVE STREAMING GENERATION
                            // =========================================================
                            progress.report({ message: "Writing Code Live..." });
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: `Nexus: Streaming into ${realFilepath}...` });

                            // Create file if it doesn't exist so we can stream into it
                            let summary = `Updated ${realFilepath}`;
                            if (!fileExists) {
                                try {
                                    const parentDir = vscode.Uri.joinPath(rootUri, path.dirname(realFilepath));
                                    await vscode.workspace.fs.createDirectory(parentDir);
                                } catch (e) { /* ignore if exists */ }
                                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                summary = `✨ Created ${realFilepath}`;
                            }

                            const document = await vscode.workspace.openTextDocument(fileUri);
                            const editor = await vscode.window.showTextDocument(document, { preview: false });

                            const availableFiles = projectStructure.split('\n')
                                .filter(line => line.includes('── '))
                                .map(line => line.split('── ')[1].trim());

                            let streamAction = !fileExists ? 'replace' : 'replace';
                            let fullGeneratedCode = "";
                            let currentPosition = new vscode.Position(0, 0);

                            // Trigger the new Streaming API

                            const originalContentForDiff = currentFileContent;
                            let streamStartLine = 0;

                            await streamQwenForCode(
                                data.task,
                                availableFiles,
                                promptContext,
                                data.codingStyle,
                                [],
                                // 🔥 FIX: Wrapped inside a callbacks object and added explicit types!
                                {
                                    // CALLBACK 1: Editor Setup (Triggers when <action> tag arrives)
                                    onSetup: async (action: string, filepath: string, target?: string) => {
                                        streamAction = !fileExists ? 'replace' : action;

                                        if (streamAction === 'replace') {
                                            await editor.edit(editBuilder => {
                                                const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
                                                editBuilder.delete(fullRange);
                                            });
                                            currentPosition = new vscode.Position(0, 0);
                                            streamStartLine = 0; // 🔥 Track line

                                        } else if (streamAction === 'append') {
                                            currentPosition = new vscode.Position(document.lineCount, 0);
                                            await editor.edit(b => b.insert(currentPosition, "\n"));
                                            currentPosition = new vscode.Position(document.lineCount, 0);
                                            streamStartLine = document.lineCount - 1; // 🔥 Track line

                                        } else if (streamAction === 'inject' && target) {
                                            // AST / Brace counting for Live Injection
                                            const injectionPos = await getInjectionPosition(this._extensionUri, document, target);
                                            if (injectionPos) {
                                                // Set the virtual cursor to the calculated AST position
                                                currentPosition = injectionPos;

                                                // Add indentation formatting before streaming begins
                                                await editor.edit(b => b.insert(currentPosition, "\n    "));

                                                // Move cursor down to the newly created blank line
                                                currentPosition = new vscode.Position(injectionPos.line + 1, 4);
                                                streamStartLine = currentPosition.line;
                                            } else {
                                                // Fallback: If AST couldn't find the target, gracefully downgrade to append
                                                console.warn(`[AST] Target '${target}' not found. Falling back to append.`);
                                                streamAction = 'append';
                                                currentPosition = new vscode.Position(document.lineCount, 0);
                                                await editor.edit(b => b.insert(currentPosition, "\n\n"));
                                                currentPosition = new vscode.Position(document.lineCount, 0);
                                                streamStartLine = document.lineCount - 1;
                                            }
                                        }
                                    },
                                    // CALLBACK 2: Ghost Typing (Triggers for every word the AI generates)
                                    onToken: async (token: string) => {
                                        const cleanToken = token
                                            .replace(/```[a-zA-Z]*\n?/g, '')
                                            .replace(/```/g, '')
                                            .replace(/<\/code>/g, '')
                                            .replace(/<\/code/g, '');
                                        fullGeneratedCode += cleanToken;

                                        await editor.edit(editBuilder => {
                                            editBuilder.insert(currentPosition, cleanToken);
                                        }, { undoStopBefore: false, undoStopAfter: false });

                                        // Move the virtual cursor forward
                                        const lines = cleanToken.split('\n');
                                        if (lines.length > 1) {
                                            currentPosition = new vscode.Position(currentPosition.line + lines.length - 1, lines[lines.length - 1].length);
                                        } else {
                                            currentPosition = new vscode.Position(currentPosition.line, currentPosition.character + cleanToken.length);
                                        }

                                        // Keep the viewport centered on the newly typed text
                                        editor.revealRange(new vscode.Range(currentPosition, currentPosition), vscode.TextEditorRevealType.Default);
                                    }
                                }
                            );

                            // =========================================================
                            // STEP 6: FINALIZE REVIEW STATUS
                            // =========================================================
                            let status = "reviewing";

                            // Re-apply Headers and Tracking based on the action
                            if (streamAction === 'replace') {
                                const text = document.getText();
                                // Find the header the AI accidentally streamed
                                const aiBlockRegex = /^\s*(\/\*\*?[\s\S]*?✨ AI Generated Content[\s\S]*?\*\/|# ✨ AI Generated Content[\s\S]*?# --- End AI ---)\n*/;
                                const match = text.match(aiBlockRegex);

                                const mergedHeader = getAIHeader(realFilepath, data.task, originalContentForDiff);

                                await editor.edit(b => {
                                    if (match && match.index !== undefined) {
                                        // Replace the hallucinated header with our perfectly merged one
                                        const startPos = document.positionAt(match.index);
                                        const endPos = document.positionAt(match.index + match[0].length);
                                        b.replace(new vscode.Range(startPos, endPos), mergedHeader + "\n");
                                    } else {
                                        // Insert at the very top if no header was streamed
                                        b.insert(new vscode.Position(0, 0), mergedHeader + "\n");
                                    }
                                });

                                // Hand the BEFORE and AFTER states to the Diff Tracker
                                status = this._tracker?.trackStreamedReview(
                                    editor,
                                    originalContentForDiff,
                                    data.task,
                                    0,
                                    editor.document.lineCount
                                ) || "reviewing";

                            } else {
                                // Insert the header right above the appended/injected code
                                const aiHeader = getAIHeader(realFilepath, data.task);
                                await editor.edit(b => b.insert(new vscode.Position(streamStartLine, 0), aiHeader));

                                status = this._tracker?.trackStreamedReview(
                                    editor,
                                    originalContentForDiff,
                                    data.task,
                                    streamStartLine,
                                    editor.document.lineCount
                                ) || "reviewing";
                            }

                            try {
                                await resolveMissingImports(editor);
                            } catch (importErr) {
                                console.warn("Import resolution skipped due to read error:", importErr);
                            }

                            webviewView.webview.postMessage({
                                type: 'taskCompleted',
                                task: data.task,
                                status: status,
                                summary: summary
                            });

                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });

                        } catch (error) {
                            console.error("Execution error:", error);
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "" });
                            webviewView.webview.postMessage({
                                type: 'taskCompleted',
                                task: data.task,
                                status: 'error',
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
                            // 1. GATHER ALL EDITS (Draft Phase)
                            progress.report({ message: "Analyzing Project Context..." });
                            const contextRoot = this._isMetaMode ? this._extensionUri.fsPath : undefined;
                            const projectContext = await getProjectContext(contextRoot);

                            // =========================================================
                            // FIX 2: BATCH PROCESSING (Chunking)
                            // Sending 100 tasks to the LLM at once causes it to fail/hallucinate.
                            // We split them into batches of 5 to ensure high-quality code for every file.
                            // =========================================================
                            const allEdits: AtomicEdit[] = [];
                            const BATCH_SIZE = 5;
                            const tasks = data.tasks;

                            for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
                                if (token.isCancellationRequested) break;

                                const batch = tasks.slice(i, i + BATCH_SIZE);
                                const batchNum = Math.ceil((i + 1) / BATCH_SIZE);
                                const totalBatches = Math.ceil(tasks.length / BATCH_SIZE);

                                progress.report({ message: `Drafting batch ${batchNum}/${totalBatches} (${batch.length} files)...` });

                                // Send status update to UI
                                this._view?.webview.postMessage({
                                    type: 'statusUpdate',
                                    message: `Drafting batch ${batchNum}/${totalBatches}: ${batch[0]}...`
                                });

                                try {
                                    // Ask LLM for just this small batch
                                    const batchEdits = await askQwenForAtomicEdits(batch, projectContext, data.codingStyle);
                                    allEdits.push(...batchEdits);
                                } catch (e) {
                                    console.error(`Batch ${batchNum} failed:`, e);
                                    // Continue to next batch instead of crashing entirely
                                }
                            }

                            if (token.isCancellationRequested) return;

                            // Final UI Update
                            this._view?.webview.postMessage({ type: 'statusUpdate', message: "Compiling Final Review..." });

                            // Send ALL accumulated edits to the UI for review
                            this._view?.webview.postMessage({
                                type: 'reviewEdits',
                                edits: allEdits,
                                tasks: data.tasks
                            });

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
                    }, async (progress) => {
                        const workspaceEdit = new vscode.WorkspaceEdit();
                        const timestamp = new Date().toLocaleString();
                        const rootUri = this._isMetaMode ? this._extensionUri : workspaceFolders[0].uri;

                        for (const edit of data.edits) {
                            const fileUri = vscode.Uri.joinPath(rootUri, edit.filepath);

                            // Generate the AI metadata header
                            const aiHeader = getAIHeader(edit.filepath, "Atomic Implementation");
                            const finalCode = aiHeader + edit.code;

                            try {
                                await vscode.workspace.fs.stat(fileUri);
                            } catch {
                                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                            }

                            const document = await vscode.workspace.openTextDocument(fileUri);

                            // Replace the whole file with the new code + AI header
                            const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
                            workspaceEdit.replace(fileUri, fullRange, finalCode);
                        }

                        const success = await vscode.workspace.applyEdit(workspaceEdit);
                        if (success) {
                            const dirtyDocs = vscode.workspace.textDocuments.filter(d => d.isDirty);
                            for (const doc of dirtyDocs) {
                                await doc.save();
                            }

                            webviewView.webview.postMessage({ type: 'allTasksCompleted', status: 'approved' });
                            vscode.window.showInformationMessage("Atomic Transaction Committed with AI Metadata.");
                        }
                    });
                    break;
                }

                case "generateAndRunTests": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;
                    const workspacePath = workspaceFolders[0].uri.fsPath;
                    const activeEditor = vscode.window.activeTextEditor;
                    if (!activeEditor) return;

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "NexusCode is writing and executing tests...",
                        cancellable: false
                    }, async () => {
                        try {
                            const fileName = activeEditor.document.fileName;
                            const fileContent = activeEditor.document.getText();

                            // 1. Get Test Plan from Qwen
                            const relativeFileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                            const testPlan = await askQwenForTests(relativeFileName, fileContent);

                            if (activeEditor.document.isDirty) {
                                await activeEditor.document.save();
                            }



                            // 2. Install Dependencies Automatically
                            if (testPlan.installCommand) {
                                webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Installing dependencies...' });
                                await this._terminalManager?.runCommandWithCapture(testPlan.installCommand, workspacePath);
                            }

                            // ==========================================
                            // FIX: SANITIZE THE PATH
                            // ==========================================
                            let safePath = testPlan.filepath;

                            // If Qwen accidentally returned an absolute path, strip out the workspace root
                            if (safePath.toLowerCase().includes(workspacePath.toLowerCase())) {
                                safePath = safePath.substring(safePath.toLowerCase().indexOf(workspacePath.toLowerCase()) + workspacePath.length);
                            }
                            // Remove any leading slashes or backslashes so joinPath works correctly
                            safePath = safePath.replace(/^[\\\/]+/, '');
                            // ==========================================

                            // 3. Create the Test File
                            const testFileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, safePath);
                            const edit = new vscode.WorkspaceEdit();
                            edit.createFile(testFileUri, { ignoreIfExists: true });
                            edit.insert(testFileUri, new vscode.Position(0, 0), testPlan.code);
                            await vscode.workspace.applyEdit(edit);

                            const doc = await vscode.workspace.openTextDocument(testFileUri);
                            await vscode.window.showTextDocument(doc);

                            await doc.save();

                            // 4. Run the Test
                            webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Running tests...' });
                            const result = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);

                            // 5. AUTO-HEALING LOOP
                            // src/SidebarProvider.ts (Inside generateAndRunTests, replace step 5/6 AUTO-HEALING LOOP)

                            // 6. AUTO-HEALING LOOP
                            if (result && !result.success) {
                                webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Tests failed. Auto-healing...' });

                                try {
                                    // Pass BOTH the source and the test context to the healer
                                    const fixResult = await askQwenToFixError(
                                        result.output,
                                        relativeFileName,
                                        activeEditor.document.getText(),
                                        safePath,
                                        testPlan.code
                                    );

                                    // Figure out which file Qwen wants to fix
                                    const fileToFixUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fixResult.filepath);

                                    // Apply the fix directly to that specific file
                                    const fixEdit = new vscode.WorkspaceEdit();
                                    const docToFix = await vscode.workspace.openTextDocument(fileToFixUri);
                                    const fullRange = new vscode.Range(0, 0, docToFix.lineCount, 0);
                                    fixEdit.replace(fileToFixUri, fullRange, fixResult.code);
                                    await vscode.workspace.applyEdit(fixEdit);

                                    // Save the fixed file to disk
                                    await docToFix.save();

                                    webviewView.webview.postMessage({ type: 'statusUpdate', message: 'Re-running tests after heal...' });
                                    const retryResult = await this._terminalManager?.runCommandWithCapture(testPlan.testCommand, workspacePath);

                                    if (retryResult && retryResult.success) {
                                        vscode.window.showInformationMessage(`Auto-Heal successful! Fixed ${fixResult.filepath}`);
                                    } else {
                                        vscode.window.showErrorMessage("Auto-Heal attempted, but tests still failing. Manual review required.");
                                    }
                                } catch (e) {
                                    console.error("Auto-heal failed:", e);
                                    vscode.window.showErrorMessage("Auto-heal failed to parse LLM output.");
                                }
                            } else {
                                vscode.window.showInformationMessage("All tests passed on the first try!");
                            }

                            webviewView.webview.postMessage({ type: 'statusUpdate', message: '' }); // Clear status

                        } catch (error) {
                            console.error("Test generation error:", error);
                            vscode.window.showErrorMessage("Failed to generate or run tests.");
                        }
                    });
                    break;
                }

                case "toggleMetaMode": {
                    this._isMetaMode = data.value;
                    const mode = this._isMetaMode ? "⚠️ SELF-EVOLUTION MODE" : "User Project Mode";
                    vscode.window.showWarningMessage(`Switched to: ${mode}`);
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