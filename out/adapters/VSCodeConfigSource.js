"use strict";
// src/adapters/VSCodeConfigSource.ts
//
// `ConfigSource` implementation backed by `vscode.workspace.getConfiguration`.
// Used by the Extension Host. Constructed in `extension.ts:activate()` and
// passed into `setDeps`.
//
// Why this lives in its own file (separate from container.ts):
//   container.ts is imported by both runtimes — Extension Host and CLI.
//   If it had `import * as vscode from 'vscode'` at runtime, the CLI would
//   crash on startup with "Cannot find module 'vscode'" because vscode is
//   only available inside the Extension Host. Splitting the vscode-coupled
//   adapter out lets container.ts use `import type` for vscode (compile-time
//   only) and stay runtime-portable.
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
exports.VSCodeConfigSource = void 0;
const vscode = __importStar(require("vscode"));
class VSCodeConfigSource {
    namespace;
    constructor(namespace) {
        this.namespace = namespace;
    }
    get(key, defaultValue) {
        const cfg = vscode.workspace.getConfiguration(this.namespace);
        if (defaultValue !== undefined) {
            return cfg.get(key, defaultValue);
        }
        return cfg.get(key);
    }
    async update(key, value) {
        const cfg = vscode.workspace.getConfiguration(this.namespace);
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }
}
exports.VSCodeConfigSource = VSCodeConfigSource;
//# sourceMappingURL=VSCodeConfigSource.js.map