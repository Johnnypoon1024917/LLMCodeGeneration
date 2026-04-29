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
exports.AILensProvider = void 0;
// src/AILensProvider.ts
const vscode = __importStar(require("vscode"));
class AILensProvider {
    _onDidChangeCodeLenses = new vscode.EventEmitter();
    onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    pendingEdits = [];
    _refreshTimeout;
    constructor() {
        //  FIX 1: Listen for text changes to fix shifted or disappearing lenses
        vscode.workspace.onDidChangeTextDocument((e) => {
            const hasEditsInDoc = this.pendingEdits.some(edit => edit.uri.toString() === e.document.uri.toString());
            if (hasEditsInDoc) {
                // Debounce the refresh to prevent UI flickering during rapid typing
                if (this._refreshTimeout)
                    clearTimeout(this._refreshTimeout);
                this._refreshTimeout = setTimeout(() => {
                    this.refresh();
                }, 300);
            }
        });
    }
    refresh() {
        this._onDidChangeCodeLenses.fire();
    }
    addEdit(edit) {
        // Remove existing edit for this task to prevent duplicate buttons
        this.pendingEdits = this.pendingEdits.filter(e => e.taskId !== edit.taskId);
        this.pendingEdits.push(edit);
        this.refresh();
    }
    clearEdit(taskId) {
        this.pendingEdits = this.pendingEdits.filter(e => e.taskId !== taskId);
        this.refresh();
    }
    provideCodeLenses(document, _token) {
        const lenses = [];
        const docEdits = this.pendingEdits.filter(e => e.uri.toString() === document.uri.toString());
        for (const edit of docEdits) {
            // Check if the tracked range is still mathematically valid in the document
            if (edit.range.start.line < document.lineCount) {
                lenses.push(new vscode.CodeLens(edit.range, {
                    title: "✅ Accept Changes",
                    tooltip: "Approve and finalize these AI edits",
                    command: "nexuscode.acceptEdit",
                    arguments: [edit.taskId, document.uri]
                }));
                lenses.push(new vscode.CodeLens(edit.range, {
                    title: "❌ Reject",
                    tooltip: "Revert this file to its original state",
                    command: "nexuscode.rejectEdit",
                    arguments: [edit.taskId, document.uri]
                }));
                lenses.push(new vscode.CodeLens(edit.range, {
                    title: "🔍 View Diff",
                    tooltip: "See exactly what the AI changed",
                    command: "nexuscode.viewDiff",
                    arguments: [edit.taskId, document.uri]
                }));
            }
        }
        return lenses;
    }
}
exports.AILensProvider = AILensProvider;
//# sourceMappingURL=AILensProvider.js.map