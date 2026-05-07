// src/test/unit/specManagerMultiFeature.test.ts
//
// V2.1.2 spec-fix-4: tests for SpecManager's multi-feature additions.
// The data model already supported per-feature directories; this test
// suite pins the new public helpers (listFeatures, featureExists,
// slugifyName) that the webview switcher depends on.

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// VS Code mock — the same shape we use elsewhere in the suite. We only
// need the fs.readDirectory + fs.stat + workspace.fs methods, plus the
// Uri.joinPath helper.
jest.mock('vscode', () => {
    type Entry = [string, number];
    const FILE_SYSTEM = new Map<string, Entry[]>();
    const FILE_CONTENT = new Map<string, string>();

    const FileType = { File: 1, Directory: 2 };

    return {
        FileType,
        Uri: {
            joinPath: (base: any, ...parts: string[]) => ({
                fsPath: [base.fsPath, ...parts].join('/'),
                path: [base.path, ...parts].join('/'),
            }),
            file: (p: string) => ({ fsPath: p, path: p }),
        },
        workspace: {
            fs: {
                readDirectory: async (uri: any) => {
                    const entries = FILE_SYSTEM.get(uri.fsPath);
                    if (!entries) { throw new Error('ENOENT'); }
                    return entries;
                },
                stat: async (uri: any) => {
                    const entries = FILE_SYSTEM.get(uri.fsPath);
                    if (entries) { return { type: FileType.Directory }; }
                    if (FILE_CONTENT.has(uri.fsPath)) { return { type: FileType.File }; }
                    throw new Error('ENOENT');
                },
                createDirectory: async (uri: any) => {
                    if (!FILE_SYSTEM.has(uri.fsPath)) {
                        FILE_SYSTEM.set(uri.fsPath, []);
                    }
                },
                readFile: async (uri: any) => {
                    const content = FILE_CONTENT.get(uri.fsPath);
                    if (content === undefined) { throw new Error('ENOENT'); }
                    return Buffer.from(content, 'utf8');
                },
                writeFile: async (uri: any, buf: Buffer) => {
                    FILE_CONTENT.set(uri.fsPath, buf.toString('utf8'));
                },
                delete: async (uri: any) => {
                    FILE_CONTENT.delete(uri.fsPath);
                },
            },
        },
        // Test helpers — exposed via the mock so beforeEach can reset state
        __FILE_SYSTEM: FILE_SYSTEM,
        __FILE_CONTENT: FILE_CONTENT,
    };
});

import * as vscode from 'vscode';
import { SpecManager, DEFAULT_FEATURE } from '../../specs/SpecManager';

const mockVscode = vscode as any;

function setupSpecsDir(workspacePath: string, features: string[]) {
    const specsPath = `${workspacePath}/.nexus/specs`;
    mockVscode.__FILE_SYSTEM.set(specsPath, features.map((f: string) => [f, 2]));
    for (const f of features) {
        mockVscode.__FILE_SYSTEM.set(`${specsPath}/${f}`, []);
    }
}

describe('SpecManager multi-feature helpers', () => {
    let sm: SpecManager;

    beforeEach(() => {
        mockVscode.__FILE_SYSTEM.clear();
        mockVscode.__FILE_CONTENT.clear();
        sm = new SpecManager(vscode.Uri.file('/workspace'));
    });

    describe('slugifyName', () => {
        it('lowercases and dashes spaces', () => {
            expect(sm.slugifyName('Checkout Flow')).toBe('checkout-flow');
        });

        it('strips special characters', () => {
            expect(sm.slugifyName('User Auth (v2)!')).toBe('user-auth-v2');
        });

        it('strips leading/trailing dashes', () => {
            expect(sm.slugifyName('---banner---')).toBe('banner');
        });

        it('returns DEFAULT_FEATURE when input slugifies to empty', () => {
            expect(sm.slugifyName('!!!')).toBe(DEFAULT_FEATURE);
            expect(sm.slugifyName('')).toBe(DEFAULT_FEATURE);
        });
    });

    describe('featureExists', () => {
        it('returns true for existing feature directory', async () => {
            setupSpecsDir('/workspace', ['main', 'checkout']);
            expect(await sm.featureExists('checkout')).toBe(true);
            expect(await sm.featureExists('main')).toBe(true);
        });

        it('returns false for non-existent feature', async () => {
            setupSpecsDir('/workspace', ['main']);
            expect(await sm.featureExists('nonexistent')).toBe(false);
        });

        it('returns false when specs/ directory does not exist', async () => {
            // No setupSpecsDir — specs/ doesn't exist
            expect(await sm.featureExists('main')).toBe(false);
        });

        it('slugifies the input before checking', async () => {
            setupSpecsDir('/workspace', ['checkout-flow']);
            // User types "Checkout Flow!" — should match the existing slug
            expect(await sm.featureExists('Checkout Flow!')).toBe(true);
        });
    });

    describe('listFeatures', () => {
        it('returns empty array when specs/ does not exist', async () => {
            expect(await sm.listFeatures()).toEqual([]);
        });

        it('returns all feature directories', async () => {
            setupSpecsDir('/workspace', ['main', 'checkout', 'banner']);
            const features = await sm.listFeatures();
            expect(features).toHaveLength(3);
            expect(features.map(f => f.slug).sort()).toEqual(['banner', 'checkout', 'main']);
        });

        it('puts main first in the sort order', async () => {
            setupSpecsDir('/workspace', ['banner', 'main', 'checkout']);
            const features = await sm.listFeatures();
            expect(features[0]?.slug).toBe('main');
            // Rest should be alphabetical
            expect(features[1]?.slug).toBe('banner');
            expect(features[2]?.slug).toBe('checkout');
        });

        it('sorts alphabetically when main is absent', async () => {
            setupSpecsDir('/workspace', ['checkout', 'banner']);
            const features = await sm.listFeatures();
            expect(features.map(f => f.slug)).toEqual(['banner', 'checkout']);
        });

        it('includes phaseState for each feature', async () => {
            setupSpecsDir('/workspace', ['main']);
            const features = await sm.listFeatures();
            expect(features[0]?.phaseState).toBeDefined();
            // Default phaseState has all phases as not_started
            expect(features[0]?.phaseState.requirements).toBe('not_started');
        });

        it('skips non-directory entries', async () => {
            const specsPath = '/workspace/.nexus/specs';
            mockVscode.__FILE_SYSTEM.set(specsPath, [
                ['main', 2 /* Directory */],
                ['README.md', 1 /* File — should be skipped */],
                ['checkout', 2],
            ]);
            mockVscode.__FILE_SYSTEM.set(`${specsPath}/main`, []);
            mockVscode.__FILE_SYSTEM.set(`${specsPath}/checkout`, []);

            const features = await sm.listFeatures();
            expect(features.map(f => f.slug)).toEqual(['main', 'checkout']);
        });
    });
});