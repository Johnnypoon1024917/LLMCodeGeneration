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
exports.TerminalManager = void 0;
const vscode = __importStar(require("vscode"));
const i18n_1 = require("./i18n");
const cp = __importStar(require("child_process"));
class TerminalManager {
    outputChannel;
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("NexusCode Agent");
    }
    /**
     * Executes a shell command using cp.spawn for live streaming to the UI.
     * Strips ANSI codes for safe LLM ingestion.
     */
    async runCommandWithCapture(command, workspacePath, onStream) {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n[NexusCode] Executing: ${command}`);
        this.outputChannel.appendLine(`[NexusCode] CWD: ${workspacePath}`);
        return new Promise((resolve) => {
            const envVars = {
                ...process.env,
                PYTHONPATH: workspacePath,
                NODE_PATH: workspacePath
            };
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const args = isWin ? ['/c', command] : ['-c', command];
            // Spawn allows us to stream data live!
            const child = cp.spawn(shell, args, { cwd: workspacePath, env: envVars, shell: false });
            let fullOutput = '';
            const handleChunk = (data) => {
                const rawText = data.toString();
                this.outputChannel.append(rawText); // Send to VS Code Output tab
                // Strip ANSI Color Codes so the LLM doesn't choke on formatting garbage
                const cleanText = rawText.replace(/\x1b\[[0-9;]*m/g, '');
                fullOutput += cleanText;
                // Stream to the React UI!
                if (onStream) {
                    onStream(cleanText);
                }
            };
            child.stdout.on('data', handleChunk);
            child.stderr.on('data', handleChunk);
            child.on('error', (error) => {
                this.outputChannel.appendLine(`[NexusCode] ⚠️ Process Error: ${error.message}`);
                resolve({ success: false, output: fullOutput + `\nPROCESS ERROR: ${error.message}`, code: -1 });
            });
            child.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine(`\n[NexusCode] ✅ Command succeeded.`);
                }
                else {
                    this.outputChannel.appendLine(`\n[NexusCode] ⚠️ Command failed with code: ${code}`);
                }
                resolve({ success: code === 0, output: fullOutput, code });
            });
        });
    }
    /**
     * NEW: Self-Evolution Trigger
     * Recompiles the extension source code and reloads the VS Code window.
     */
    async rebuildAndReload(extensionRoot) {
        this.outputChannel.appendLine(`\n[NexusCode] 🔄 STARTING SELF-EVOLUTION SEQUENCE...`);
        this.outputChannel.appendLine(`[NexusCode] Step 1: Recompiling Extension...`);
        const compileResult = await this.runCommandWithCapture("npm run compile", extensionRoot);
        if (!compileResult.success) {
            vscode.window.showErrorMessage((0, i18n_1.t)("terminal.self_evolution_failed"));
            this.outputChannel.appendLine(`[NexusCode] ❌ CRITICAL: Compilation failed. Aborting reload.`);
            return;
        }
        this.outputChannel.appendLine(`[NexusCode] Step 2: Reloading Window...`);
        vscode.window.showInformationMessage((0, i18n_1.t)("terminal.extension_updated"));
        setTimeout(() => {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
        }, 1500);
    }
    dispose() {
        this.outputChannel.dispose();
    }
}
exports.TerminalManager = TerminalManager;
//# sourceMappingURL=terminalManager.js.map