"use strict";
// src/fixtures/loader.ts
//
// Loads fixture.yaml files into typed Fixture objects.
//
// Lives in src/fixtures/ rather than scripts/ because:
//   1. It's TypeScript, gets compiled with the host
//   2. The runner imports it from out/fixtures/ at vscode-test time
//   3. Tests can import it for unit-testing fixture format validation
//      without depending on the runner
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
exports.discoverFixtures = discoverFixtures;
exports.loadFixture = loadFixture;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
// ─── Loader ─────────────────────────────────────────────────────────
/** Discover all fixture.yaml files under fixtures/. Returns absolute paths
 *  to fixture directories (not the .yaml files themselves). */
async function discoverFixtures(fixturesRoot) {
    const found = [];
    for (const tier of ['easy', 'medium', 'hard']) {
        const tierDir = path.join(fixturesRoot, tier);
        let entries;
        try {
            entries = await fs.readdir(tierDir);
        }
        catch {
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
async function loadFixture(fixtureDir) {
    const yamlPath = path.join(fixtureDir, 'fixture.yaml');
    const text = await fs.readFile(yamlPath, 'utf-8');
    // Defer js-yaml import to runtime so this module loads fine in
    // environments that don't have it (compile-time tools, etc.).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    const raw = yaml.load(text);
    if (!raw || typeof raw !== 'object') {
        throw new Error(`${yamlPath}: not a YAML mapping`);
    }
    const id = expectString(raw, 'id', yamlPath);
    const title = expectString(raw, 'title', yamlPath);
    const tier = expectEnum(raw, 'tier', ['easy', 'medium', 'hard'], yamlPath);
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
function expectString(obj, key, ctx) {
    const v = obj[key];
    if (typeof v !== 'string' || !v.trim()) {
        throw new Error(`${ctx}: '${key}' must be a non-empty string`);
    }
    return v;
}
function expectEnum(obj, key, allowed, ctx) {
    const v = obj[key];
    if (typeof v !== 'string' || !allowed.includes(v)) {
        throw new Error(`${ctx}: '${key}' must be one of ${allowed.join('|')}`);
    }
    return v;
}
function expectModes(raw, ctx) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`${ctx}: 'modes' must be a non-empty array`);
    }
    const out = [];
    for (const m of raw) {
        if (m !== 'interactive' && m !== 'autopilot') {
            throw new Error(`${ctx}: unknown mode '${m}'`);
        }
        out.push(m);
    }
    return out;
}
function expectRubric(raw, ctx) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`${ctx}: 'rubric' must be a non-empty array`);
    }
    return raw.map((entry, i) => parseCheck(entry, `${ctx}.rubric[${i}]`));
}
function parseCheck(raw, ctx) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`${ctx}: not a mapping`);
    }
    const obj = raw;
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
            const reqObj = req;
            const expObj = exp;
            const method = expectEnum(reqObj, 'method', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], `${ctx}.request`);
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
                        ? { headers: reqObj['headers'] }
                        : {})
                },
                expect: {
                    status: typeof expObj['status'] === 'number' ? expObj['status'] : 200,
                    ...(Array.isArray(expObj['body_includes']) ? { bodyIncludes: expObj['body_includes'] } : {}),
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
//# sourceMappingURL=loader.js.map