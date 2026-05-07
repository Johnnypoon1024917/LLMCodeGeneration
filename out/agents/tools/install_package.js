"use strict";
// src/agents/tools/install_package.ts
//
// Install a package with npm/pip/cargo. Q1=1C catalog item.
//
// Detection: package.json present → npm. requirements.txt or
// pyproject.toml → pip. Cargo.toml → cargo. Falls back to 'unknown'
// which surfaces an error asking the LLM to use bash_exec.
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
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const toolRegistry_1 = require("../toolRegistry");
const _execHelper_1 = require("./_execHelper");
const definition = {
    type: 'function',
    function: {
        name: 'install_package',
        description: "Install a package using the project's package manager (npm, pip, or cargo). Auto-detects the manager from project files. Use 'bash_exec' if you need a specific manager or version.",
        parameters: {
            type: 'object',
            properties: {
                packageName: { type: 'string', description: "The package name (e.g., 'lodash', 'requests', 'serde')" },
                dev: { type: 'boolean', description: "Install as a development dependency (npm only). Defaults to false." }
            },
            required: ['packageName']
        }
    }
};
async function fileExists(workspaceRoot, name) {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path.join(workspaceRoot, name)));
        return true;
    }
    catch {
        return false;
    }
}
async function detectPackageManager(workspaceRoot) {
    if (await fileExists(workspaceRoot, 'package.json')) {
        return 'npm';
    }
    if (await fileExists(workspaceRoot, 'Cargo.toml')) {
        return 'cargo';
    }
    if (await fileExists(workspaceRoot, 'requirements.txt')) {
        return 'pip';
    }
    if (await fileExists(workspaceRoot, 'pyproject.toml')) {
        return 'pip';
    }
    return null;
}
const executor = async (args, ctx) => {
    const packageName = String(args['packageName'] ?? '');
    const dev = args['dev'] === true;
    if (!packageName) {
        return {
            llmContent: "Error: 'packageName' argument is required.",
            uiPayload: { kind: 'error', message: "'packageName' argument is required." }
        };
    }
    // Reject names that look like they'd inject shell args. The LLM
    // shouldn't emit these, but a hostile system_prompt might.
    if (/[\s;&|`$()<>"']/.test(packageName)) {
        const msg = `Invalid package name: '${packageName}' contains shell-special characters.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    const manager = await detectPackageManager(ctx.workspaceRoot);
    if (!manager) {
        const msg = `Could not detect package manager (no package.json / Cargo.toml / requirements.txt / pyproject.toml found). Use 'bash_exec' to install manually.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    let command;
    if (manager === 'npm') {
        command = dev ? `npm install --save-dev ${packageName}` : `npm install ${packageName}`;
    }
    else if (manager === 'pip') {
        command = `pip install ${packageName}`;
    }
    else {
        // cargo
        command = `cargo add ${packageName}`;
    }
    const result = await (0, _execHelper_1.runCommand)(command, ctx, { timeoutMs: 5 * 60 * 1000 });
    return {
        llmContent: (0, _execHelper_1.formatLlmContent)(command, result),
        uiPayload: (0, _execHelper_1.bashOutputPayload)(result)
    };
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=install_package.js.map