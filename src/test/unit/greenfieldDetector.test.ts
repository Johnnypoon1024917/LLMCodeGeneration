// src/test/unit/greenfieldDetector.test.ts
//
// Tests for the V2.1 greenfield-detection logic. Pure module, no
// fs/vscode dependencies — caller passes pre-computed workspace
// inventory. We exercise:
//
//   - Decision-tree branches (project marker overrides everything,
//     anaphoric refs override empty workspace, etc.)
//   - Confidence levels (high vs medium vs low)
//   - Stack-hint extraction across all five built-in stacks
//   - Edge cases around "empty enough" workspace counting
//
// These tests pin down the heuristic so we can tune it later without
// silent behavior drift. When we add stacks in V2.1.2+, add tests
// here for the new stack hints.

import { describe, it, expect } from '@jest/globals';
import { detectGreenfield, PROJECT_MARKER_FILES } from '../../scaffold/greenfieldDetector';

describe('detectGreenfield — decision tree', () => {
    it('returns NOT greenfield when package.json exists, regardless of prompt', () => {
        const result = detectGreenfield({
            prompt: 'build me a new Node CLI',
            topLevelFilenames: ['package.json', 'README.md'],
            totalFileCount: 50,
        });
        expect(result.isGreenfield).toBe(false);
        expect(result.confidence).toBe('low');
        expect(result.signals.hasProjectMarker).toBe(true);
    });

    it('returns NOT greenfield for any project marker file', () => {
        // Pyproject.toml, Cargo.toml, go.mod, pom.xml — sample.
        for (const marker of ['pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Gemfile']) {
            const result = detectGreenfield({
                prompt: 'create a new project from scratch',
                topLevelFilenames: [marker],
                totalFileCount: 10,
            });
            expect(result.isGreenfield).toBe(false);
            expect(result.signals.hasProjectMarker).toBe(true);
        }
    });

    it('handles wildcard markers (.csproj, .sln) correctly', () => {
        const result = detectGreenfield({
            prompt: 'build a new app',
            topLevelFilenames: ['MyApp.csproj', 'README.md'],
            totalFileCount: 15,
        });
        expect(result.isGreenfield).toBe(false);
        expect(result.signals.hasProjectMarker).toBe(true);
    });

    it('returns NOT greenfield when prompt has anaphoric reference, even in empty workspace', () => {
        const result = detectGreenfield({
            prompt: 'add a logging module to this codebase',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.isGreenfield).toBe(false);
        expect(result.signals.promptHasAnaphoricRef).toBe(true);
    });

    it('catches multiple anaphoric phrasings', () => {
        const phrases = [
            'add a feature to this codebase',
            'extend the existing code',
            'modify this project',
            'refactor the auth module',
            'fix this bug in the parser',
        ];
        for (const p of phrases) {
            const result = detectGreenfield({
                prompt: p,
                topLevelFilenames: [],
                totalFileCount: 0,
            });
            expect(result.isGreenfield).toBe(false);
        }
    });

    it('returns HIGH confidence greenfield for empty workspace + greenfield verb', () => {
        const result = detectGreenfield({
            prompt: 'build me a TypeScript CLI',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.isGreenfield).toBe(true);
        expect(result.confidence).toBe('high');
        expect(result.signals.workspaceEmpty).toBe(true);
        expect(result.signals.promptHasGreenfieldVerb).toBe(true);
    });

    it('catches multiple greenfield-verb phrasings', () => {
        const prompts = [
            'build a new API',
            'create a Python CLI',
            'scaffold a React app',
            'make me a REST service',
            'set up a new project',
            'start a new repo from scratch',
        ];
        for (const p of prompts) {
            const result = detectGreenfield({
                prompt: p,
                topLevelFilenames: [],
                totalFileCount: 0,
            });
            expect(result.isGreenfield).toBe(true);
            expect(result.confidence).toBe('high');
        }
    });

    it('returns MEDIUM confidence greenfield for empty workspace + no verb match', () => {
        // User opens an empty folder and types something vague — we
        // ask anyway but default the dropdown to "Skip".
        const result = detectGreenfield({
            prompt: 'I need help with my homework',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.isGreenfield).toBe(true);
        expect(result.confidence).toBe('medium');
    });

    it('returns LOW confidence (NOT greenfield) for non-empty workspace without project marker', () => {
        // 100 random files but no canonical marker — could be docs,
        // a scratch folder, or a sub-project. Don't scaffold.
        const result = detectGreenfield({
            prompt: 'build a new CLI',
            topLevelFilenames: Array.from({ length: 100 }, (_, i) => `file${i}.txt`),
            totalFileCount: 100,
        });
        expect(result.isGreenfield).toBe(false);
        expect(result.confidence).toBe('low');
    });

    it('treats README + LICENSE + .gitignore as still empty enough', () => {
        // 3-file workspace with no project marker should pass the
        // "empty enough" threshold. Real users do this — clone an
        // empty repo with just LICENSE and start from there.
        const result = detectGreenfield({
            prompt: 'build a new service',
            topLevelFilenames: ['README.md', 'LICENSE', '.gitignore'],
            totalFileCount: 3,
        });
        expect(result.isGreenfield).toBe(true);
        expect(result.signals.workspaceEmpty).toBe(true);
    });
});

describe('detectGreenfield — stack hints', () => {
    it('extracts node-ts-cli for TypeScript CLI prompts', () => {
        const result = detectGreenfield({
            prompt: 'build me a TypeScript CLI tool',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.stackHint).toBe('node-ts-cli');
    });

    it('extracts node-ts-api for TypeScript API prompts', () => {
        const result = detectGreenfield({
            prompt: 'create a Node API server with Express',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.stackHint).toBe('node-ts-api');
    });

    it('extracts python-cli for plain Python prompts', () => {
        const result = detectGreenfield({
            prompt: 'scaffold a Python script',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.stackHint).toBe('python-cli');
    });

    it('extracts python-fastapi for FastAPI prompts', () => {
        const result = detectGreenfield({
            prompt: 'build me a FastAPI service',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.stackHint).toBe('python-fastapi');
    });

    it('extracts react-vite for React prompts', () => {
        const result = detectGreenfield({
            prompt: 'create a React app with Vite',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.stackHint).toBe('react-vite');
    });

    it('returns no stackHint for unknown stacks', () => {
        // Rust isn't a first-class template in V2.1.1; the LLM-fallback
        // path (V2.1.3) handles it. Detector returns no hint.
        const result = detectGreenfield({
            prompt: 'build a Rust CLI',
            topLevelFilenames: [],
            totalFileCount: 0,
        });
        expect(result.stackHint).toBeUndefined();
        // Still detected as greenfield — just no template pre-selection.
        expect(result.isGreenfield).toBe(true);
    });

    it('still emits stackHint even when hasProjectMarker (for future LLM context)', () => {
        // A user with package.json saying "build me a new TypeScript
        // CLI" is NOT greenfield, but we still surface the stack hint
        // — downstream code might use it as a "they want a CLI in
        // this monorepo" signal. The isGreenfield flag is the gate
        // for actual scaffolding behavior.
        const result = detectGreenfield({
            prompt: 'build me a new TypeScript CLI tool',
            topLevelFilenames: ['package.json'],
            totalFileCount: 30,
        });
        expect(result.isGreenfield).toBe(false);
        expect(result.stackHint).toBe('node-ts-cli');
    });
});

describe('PROJECT_MARKER_FILES — sanity', () => {
    it('contains all five first-class template ecosystems', () => {
        // V2.1.2 ships templates for: Node TS, Python, React+Vite.
        // The marker list must cover at least these ecosystems' canonical
        // project files so we don't false-positive scaffold over a real project.
        const markersStr = PROJECT_MARKER_FILES.join(' ');
        expect(markersStr).toContain('package.json');     // Node
        expect(markersStr).toContain('pyproject.toml');   // Python
        expect(markersStr).toContain('Cargo.toml');       // Rust (LLM-fallback)
        expect(markersStr).toContain('go.mod');           // Go (LLM-fallback)
        expect(markersStr).toContain('pom.xml');          // Java (LLM-fallback)
    });

    it('contains no duplicates', () => {
        const set = new Set(PROJECT_MARKER_FILES);
        expect(set.size).toBe(PROJECT_MARKER_FILES.length);
    });
});