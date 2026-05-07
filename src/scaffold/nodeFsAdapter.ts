// src/scaffold/nodeFsAdapter.ts
//
// Production filesystem adapter for the V2.1.2 scaffold applier.
// Thin wrapper over node `fs` that satisfies the ScaffoldFs interface
// from scaffoldApplier.ts. Tests inject their own (in-memory) adapter;
// this is what production code uses.
//
// All paths are absolute. Caller is responsible for resolving relative
// paths to absolute before calling. The adapter doesn't do any
// validation beyond what node `fs` does.
//
// Encoding: utf-8 only. Templates are text files (package.json,
// tsconfig.json, .ts/.py/.go source, etc.) — binary support would
// require a separate code path and isn't needed for V2.1.

import * as fs from 'fs';
import * as path from 'path';
import type { ScaffoldFs } from './scaffoldApplier';

export const nodeFsAdapter: ScaffoldFs = {
    readFile(absPath: string): string | null {
        try {
            return fs.readFileSync(absPath, 'utf-8');
        } catch (e) {
            // ENOENT → file doesn't exist, return null cleanly.
            // Other errors (permission, etc.) propagate so callers
            // see them rather than silently treating them as "no file".
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw e;
        }
    },

    writeFile(absPath: string, content: string): void {
        const dir = path.dirname(absPath);
        // Create parent dirs if missing. fs.mkdirSync with recursive
        // is safe to call when dir already exists.
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
    },

    isDirectory(absPath: string): boolean {
        try {
            return fs.statSync(absPath).isDirectory();
        } catch {
            return false;
        }
    },

    listFilesRecursive(absPath: string): string[] {
        if (!this.isDirectory(absPath)) { return []; }
        const result: string[] = [];
        const walk = (currentAbs: string, relativeFromRoot: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(currentAbs, { withFileTypes: true });
            } catch (e) {
                // Directory unreadable — skip silently. Logging would
                // be noisy for permission denials on dirs we don't
                // care about.
                return;
            }
            for (const entry of entries) {
                const childAbs = path.join(currentAbs, entry.name);
                const childRel = relativeFromRoot
                    ? path.join(relativeFromRoot, entry.name)
                    : entry.name;
                if (entry.isDirectory()) {
                    walk(childAbs, childRel);
                } else if (entry.isFile()) {
                    // Normalize to forward slashes so cross-platform
                    // tests don't have to special-case Windows.
                    result.push(childRel.replace(/\\/g, '/'));
                }
            }
        };
        walk(absPath, '');
        return result.sort();
    },
};