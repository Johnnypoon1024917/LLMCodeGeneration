// src/fixtures/loader.ts
//
// Loads fixture.yaml files into typed Fixture objects.
//
// Lives in src/fixtures/ rather than scripts/ because:
//   1. It's TypeScript, gets compiled with the host
//   2. The runner imports it from out/fixtures/ at vscode-test time
//   3. Tests can import it for unit-testing fixture format validation
//      without depending on the runner

import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Fixture types ──────────────────────────────────────────────────

/** Top-level fixture loaded from fixture.yaml. */
export interface Fixture {
    id: string;
    title: string;
    tier: 'easy' | 'medium' | 'hard';
    requirement: string;
    rubric: RubricCheck[];
    hasReference: boolean;
    modes: FixtureMode[];
    budgetSeconds: number;
    /** Absolute path to the directory containing fixture.yaml. Useful
     *  for resolving reference/ paths. */
    sourceDir: string;
}

export type FixtureMode = 'interactive' | 'autopilot';

/** Discriminated union of rubric check kinds. The runner exhaustively
 *  matches against `kind` and dispatches to the matching evaluator. */
export type RubricCheck =
    | FileExistsCheck
    | CommandCheck
    | CommandOutputContainsCheck
    | IntegrationCheck
    | SemanticCheck;

export interface FileExistsCheck {
    kind: 'file_exists';
    description: string;
    path: string;
}

export interface CommandCheck {
    kind: 'command';
    description: string;
    cmd: string;
    timeoutMs?: number;
    /** Expected exit code; default 0 (success). */
    expectExitCode?: number;
}

export interface CommandOutputContainsCheck {
    kind: 'command_output_contains';
    description: string;
    cmd: string;
    /** Optional 1-indexed line number to check. If omitted, the substring
     *  must appear anywhere in stdout. */
    expectLine?: number;
    expectText: string;
    timeoutMs?: number;
}

export interface IntegrationCheck {
    kind: 'integration';
    description: string;
    setup?: string;
    request: {
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
        path: string;
        body?: unknown;
        headers?: Record<string, string>;
    };
    expect: {
        status: number;
        bodyIncludes?: string[];
        bodyMatchesRegex?: string;
    };
    teardown?: string;
}

export interface SemanticCheck {
    kind: 'semantic';
    description: string;
    /** Plain-English rubric the LLM grader evaluates against the
     *  generated code. */
    rubric: string;
}

// ─── Loader ─────────────────────────────────────────────────────────

/** Discover all fixture.yaml files under fixtures/. Returns absolute paths
 *  to fixture directories (not the .yaml files themselves). */
export async function discoverFixtures(fixturesRoot: string): Promise<string[]> {
    const found: string[] = [];
    for (const tier of ['easy', 'medium', 'hard']) {
        const tierDir = path.join(fixturesRoot, tier);
        let entries: string[];
        try {
            entries = await fs.readdir(tierDir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const fixtureDir = path.join(tierDir, entry);
            const stat = await fs.stat(fixtureDir).catch(() => null);
            if (!stat || !stat.isDirectory()) {
                continue;
            }
            const yamlPath = path.join(fixtureDir, 'fixture.yaml');
            const yamlStat = await fs.stat(yamlPath).catch(() => null);
            if (yamlStat && yamlStat.isFile()) {
                found.push(fixtureDir);
            }
        }
    }
    return found.sort();
}

/** Load and validate a single fixture from its directory. Throws on
 *  malformed YAML or missing required fields. */
export async function loadFixture(fixtureDir: string): Promise<Fixture> {
    const yamlPath = path.join(fixtureDir, 'fixture.yaml');
    const text = await fs.readFile(yamlPath, 'utf-8');

    // Defer js-yaml import to runtime so this module loads fine in
    // environments that don't have it (compile-time tools, etc.).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    const raw = yaml.load(text) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object') {
        throw new Error(`${yamlPath}: not a YAML mapping`);
    }
    const id = expectString(raw, 'id', yamlPath);
    const title = expectString(raw, 'title', yamlPath);
    const tier = expectEnum(raw, 'tier', ['easy', 'medium', 'hard'] as const, yamlPath);
    const requirement = expectString(raw, 'requirement', yamlPath);
    const rubric = expectRubric(raw['rubric'], yamlPath);
    const hasReference = typeof raw['has_reference'] === 'boolean' ? raw['has_reference'] : false;
    const modes = expectModes(raw['modes'], yamlPath);
    const budgetSeconds = typeof raw['budget_seconds'] === 'number' ? raw['budget_seconds'] : 600;

    return {
        id,
        title,
        tier,
        requirement,
        rubric,
        hasReference,
        modes,
        budgetSeconds,
        sourceDir: fixtureDir
    };
}

// ─── Validators (defensive, with clear error messages) ──────────────

function expectString(obj: Record<string, unknown>, key: string, ctx: string): string {
    const v = obj[key];
    if (typeof v !== 'string' || !v.trim()) {
        throw new Error(`${ctx}: '${key}' must be a non-empty string`);
    }
    return v;
}

function expectEnum<T extends readonly string[]>(
    obj: Record<string, unknown>,
    key: string,
    allowed: T,
    ctx: string
): T[number] {
    const v = obj[key];
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
        throw new Error(`${ctx}: '${key}' must be one of ${allowed.join('|')}`);
    }
    return v as T[number];
}

function expectModes(raw: unknown, ctx: string): FixtureMode[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`${ctx}: 'modes' must be a non-empty array`);
    }
    const out: FixtureMode[] = [];
    for (const m of raw) {
        if (m !== 'interactive' && m !== 'autopilot') {
            throw new Error(`${ctx}: unknown mode '${m}'`);
        }
        out.push(m);
    }
    return out;
}

function expectRubric(raw: unknown, ctx: string): RubricCheck[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`${ctx}: 'rubric' must be a non-empty array`);
    }
    return raw.map((entry, i) => parseCheck(entry, `${ctx}.rubric[${i}]`));
}

function parseCheck(raw: unknown, ctx: string): RubricCheck {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`${ctx}: not a mapping`);
    }
    const obj = raw as Record<string, unknown>;
    const kind = expectString(obj, 'kind', ctx);
    const description = expectString(obj, 'description', ctx);
    switch (kind) {
        case 'file_exists':
            return { kind, description, path: expectString(obj, 'path', ctx) };
        case 'command':
            return {
                kind,
                description,
                cmd: expectString(obj, 'cmd', ctx),
                ...(typeof obj['timeout_ms'] === 'number' ? { timeoutMs: obj['timeout_ms'] } : {}),
                ...(typeof obj['expect_exit_code'] === 'number' ? { expectExitCode: obj['expect_exit_code'] } : {})
            };
        case 'command_output_contains':
            return {
                kind,
                description,
                cmd: expectString(obj, 'cmd', ctx),
                expectText: expectString(obj, 'expect_text', ctx),
                ...(typeof obj['expect_line'] === 'number' ? { expectLine: obj['expect_line'] } : {}),
                ...(typeof obj['timeout_ms'] === 'number' ? { timeoutMs: obj['timeout_ms'] } : {})
            };
        case 'integration': {
            const req = obj['request'];
            const exp = obj['expect'];
            if (!req || typeof req !== 'object' || !exp || typeof exp !== 'object') {
                throw new Error(`${ctx}: integration check requires 'request' and 'expect' mappings`);
            }
            const reqObj = req as Record<string, unknown>;
            const expObj = exp as Record<string, unknown>;
            const method = expectEnum(reqObj, 'method', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const, `${ctx}.request`);
            return {
                kind,
                description,
                ...(typeof obj['setup'] === 'string' ? { setup: obj['setup'] } : {}),
                ...(typeof obj['teardown'] === 'string' ? { teardown: obj['teardown'] } : {}),
                request: {
                    method,
                    path: expectString(reqObj, 'path', `${ctx}.request`),
                    ...(reqObj['body'] !== undefined ? { body: reqObj['body'] } : {}),
                    ...(reqObj['headers'] && typeof reqObj['headers'] === 'object'
                        ? { headers: reqObj['headers'] as Record<string, string> }
                        : {})
                },
                expect: {
                    status: typeof expObj['status'] === 'number' ? expObj['status'] : 200,
                    ...(Array.isArray(expObj['body_includes']) ? { bodyIncludes: expObj['body_includes'] as string[] } : {}),
                    ...(typeof expObj['body_matches_regex'] === 'string'
                        ? { bodyMatchesRegex: expObj['body_matches_regex'] }
                        : {})
                }
            };
        }
        case 'semantic':
            return { kind, description, rubric: expectString(obj, 'rubric', ctx) };
        default:
            throw new Error(`${ctx}: unknown check kind '${kind}'`);
    }
}
