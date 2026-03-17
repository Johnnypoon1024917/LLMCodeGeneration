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
exports.MetaContextManager = void 0;
// src/metaContextManager.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
class MetaContextManager {
    extensionUri;
    backupUri;
    constructor(context) {
        this.extensionUri = context.extensionUri;
    }
    /**
     * Creates a safety snapshot of the 'src' directory.
     * Call this BEFORE letting the AI edit the extension's own code.
     */
    async createBackup() {
        try {
            const srcUri = vscode.Uri.joinPath(this.extensionUri, 'src');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.backupUri = vscode.Uri.joinPath(this.extensionUri, `src_backup_${timestamp}`);
            // Copy src -> src_backup_...
            await vscode.workspace.fs.copy(srcUri, this.backupUri, { overwrite: true });
            console.log(`[MetaManager] Backup created at: ${this.backupUri.fsPath}`);
            return true;
        }
        catch (error) {
            vscode.window.showErrorMessage(`CRITICAL: Failed to create backup. Self-evolution aborted.`);
            console.error(error);
            return false;
        }
    }
    /**
     * Restores the 'src' directory from the last backup.
     * Call this if 'npm run compile' fails.
     */
    async restoreBackup() {
        if (!this.backupUri) {
            vscode.window.showErrorMessage("No backup found to restore!");
            return;
        }
        try {
            const srcUri = vscode.Uri.joinPath(this.extensionUri, 'src');
            // 1. Delete the broken 'src'
            await vscode.workspace.fs.delete(srcUri, { recursive: true, useTrash: false });
            // 2. Copy backup -> src
            await vscode.workspace.fs.copy(this.backupUri, srcUri, { overwrite: true });
            vscode.window.showInformationMessage("Safety Guardrail: Source code restored from backup.");
        }
        catch (error) {
            vscode.window.showErrorMessage("CRITICAL: Restore failed. You may need to manually fix the source.");
            console.error(error);
        }
    }
    /**
     * Switches the "Project Context" to point to the Extension itself.
     */
    async getSelfContext() {
        const srcUri = vscode.Uri.joinPath(this.extensionUri, 'src');
        // Read directory structure of the extension itself
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(srcUri, '**/*.ts'), '**/node_modules/**');
        const fileList = files.map(f => path.relative(this.extensionUri.fsPath, f.fsPath)).join('\n');
        return `EXTENSION SOURCE STRUCTURE:\n${fileList}`;
    }
}
exports.MetaContextManager = MetaContextManager;
//# sourceMappingURL=metaContextManager.ts.js.map