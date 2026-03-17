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
const cp = __importStar(require("child_process"));
class TerminalManager {
    outputChannel;
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("NexusCode Agent");
    }
    /**
     * Executes a shell command in the specified directory and captures the output.
     * @param command The shell command to run (e.g., 'npm install').
     * @param workspacePath The working directory for the command.
     */
    async runCommandWithCapture(command, workspacePath) {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n[NexusCode] Executing: ${command}`);
        this.outputChannel.appendLine(`[NexusCode] CWD: ${workspacePath}`);
        return new Promise((resolve) => {
            // FIX: Inject the workspace path into the execution environment
            // This ensures tools like 'python' or 'node' can find local modules
            const envVars = {
                ...process.env,
                PYTHONPATH: workspacePath,
                NODE_PATH: workspacePath
            };
            cp.exec(command, { cwd: workspacePath, env: envVars }, (error, stdout, stderr) => {
                const fullOutput = `${stdout}\n${stderr}`.trim();
                if (fullOutput) {
                    this.outputChannel.appendLine(fullOutput);
                }
                if (error) {
                    this.outputChannel.appendLine(`[NexusCode] ⚠️ Command failed with error code: ${error.code}`);
                    resolve({ success: false, output: fullOutput || error.message });
                }
                else {
                    this.outputChannel.appendLine(`[NexusCode] ✅ Command succeeded.`);
                    resolve({ success: true, output: fullOutput });
                }
            });
        });
    }
    /**
     * NEW: Self-Evolution Trigger
     * Recompiles the extension source code and reloads the VS Code window.
     * Use this when the Agent edits its own source code.
     * @param extensionRoot The root directory of the extension (usually context.extensionUri.fsPath)
     */
    async rebuildAndReload(extensionRoot) {
        this.outputChannel.appendLine(`\n[NexusCode] 🔄 STARTING SELF-EVOLUTION SEQUENCE...`);
        // 1. Install dependencies (just in case new packages were added)
        // this.outputChannel.appendLine(`[NexusCode] Step 1: Installing dependencies...`);
        // await this.runCommandWithCapture("npm install", extensionRoot);
        // 2. Compile the TypeScript source
        this.outputChannel.appendLine(`[NexusCode] Step 1: Recompiling Extension...`);
        const compileResult = await this.runCommandWithCapture("npm run compile", extensionRoot);
        if (!compileResult.success) {
            vscode.window.showErrorMessage("Self-Evolution Failed: Compilation Error. Check Output for details.");
            this.outputChannel.appendLine(`[NexusCode] ❌ CRITICAL: Compilation failed. Aborting reload.`);
            return;
        }
        // 3. Reload the Window
        this.outputChannel.appendLine(`[NexusCode] Step 2: Reloading Window...`);
        vscode.window.showInformationMessage("Extension updated successfully. Reloading...");
        // Give the user a moment to see the message
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