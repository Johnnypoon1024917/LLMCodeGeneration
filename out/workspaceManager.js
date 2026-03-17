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
exports.createWorkspaceStructure = createWorkspaceStructure;
// src/workspaceManager.ts
const vscode = __importStar(require("vscode"));
async function createWorkspaceStructure(folderStructure) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage("Please open a workspace folder first.");
        return;
    }
    const rootUri = workspaceFolders[0].uri;
    for (const filePath of folderStructure) {
        try {
            const fileUri = vscode.Uri.joinPath(rootUri, filePath);
            // =========================================================
            // FIX: CHECK EXISTENCE BEFORE WRITING
            // =========================================================
            try {
                // If this succeeds, the file exists -> DO NOT TOUCH IT
                await vscode.workspace.fs.stat(fileUri);
                // console.log(`Skipping existing file: ${filePath}`);
                continue;
            }
            catch {
                // If stat throws, the file does NOT exist -> Safe to create
                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
            }
        }
        catch (error) {
            console.error(`Failed to scaffold ${filePath}:`, error);
        }
    }
}
//# sourceMappingURL=workspaceManager.js.map