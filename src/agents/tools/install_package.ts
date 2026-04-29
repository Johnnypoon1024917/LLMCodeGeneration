// src/agents/tools/install_package.ts
//
// Install a package with npm/pip/cargo. Q1=1C catalog item.
//
// Detection: package.json present → npm. requirements.txt or
// pyproject.toml → pip. Cargo.toml → cargo. Falls back to 'unknown'
// which surfaces an error asking the LLM to use bash_exec.

import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool, type ToolExecutor } from '../toolRegistry';
import { runCommand, bashOutputPayload, formatLlmContent } from './_execHelper';

const definition = {
    type: 'function' as const,
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

async function fileExists(workspaceRoot: string, name: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path.join(workspaceRoot, name)));
        return true;
    } catch {
        return false;
    }
}

async function detectPackageManager(workspaceRoot: string): Promise<'npm' | 'pip' | 'cargo' | null> {
    if (await fileExists(workspaceRoot, 'package.json')) return 'npm';
    if (await fileExists(workspaceRoot, 'Cargo.toml')) return 'cargo';
    if (await fileExists(workspaceRoot, 'requirements.txt')) return 'pip';
    if (await fileExists(workspaceRoot, 'pyproject.toml')) return 'pip';
    return null;
}

const executor: ToolExecutor = async (args, ctx) => {
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

    let command: string;
    if (manager === 'npm') {
        command = dev ? `npm install --save-dev ${packageName}` : `npm install ${packageName}`;
    } else if (manager === 'pip') {
        command = `pip install ${packageName}`;
    } else {
        // cargo
        command = `cargo add ${packageName}`;
    }

    const result = await runCommand(command, ctx, { timeoutMs: 5 * 60 * 1000 });

    return {
        llmContent: formatLlmContent(command, result),
        uiPayload: bashOutputPayload(result)
    };
};

registerTool(definition, executor);