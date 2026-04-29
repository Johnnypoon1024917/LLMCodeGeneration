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

import * as vscode from 'vscode';
import { ConfigSource } from '../container';

export class VSCodeConfigSource implements ConfigSource {
    constructor(private readonly namespace: string) {}

    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const cfg = vscode.workspace.getConfiguration(this.namespace);
        if (defaultValue !== undefined) {
            return cfg.get<T>(key, defaultValue);
        }
        return cfg.get<T>(key);
    }

    async update(key: string, value: unknown): Promise<void> {
        const cfg = vscode.workspace.getConfiguration(this.namespace);
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }
}