"use strict";
// src/agents/tools/_contextExclusions.ts
//
// V2.2 hotfix #6: shared exclusion rules for read_file / list_directory.
// Without these, the agent reads things like package-lock.json (often
// 100KB+), tsconfig.tsbuildinfo (build cache), or node_modules listings
// (thousands of entries) — and the resulting tool-call results bloat
// the message history until the next request hits the model's context
// limit. Production logs showed Qwen 27B (32K context) failing with
// "input_tokens=28673" mid-task, with the overflow attributable to
// these junk files in the tool history.
//
// What's excluded vs allowed:
//   - DENY: known-junk artifacts (build cache, lockfiles, logs, minified)
//           and infrastructure dirs (node_modules, .git, dist, .next, etc).
//   - ALLOW: source code, configs the agent legitimately needs
//           (package.json YES, package-lock.json NO; tsconfig.json YES,
//           tsconfig.tsbuildinfo NO).
//
// Two layers of defense: we deny via path-prefix match (cheapest, catches
// the obvious cases) and via filename match (catches scattered files).
//
// This is NOT a security boundary — _pathGuard handles workspace-escape
// prevention. This is purely a context-bloat reduction layer.
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
exports.MAX_LLM_FILE_BYTES = void 0;
exports.checkExclusion = checkExclusion;
exports.shouldExcludeFromListing = shouldExcludeFromListing;
exports.truncateForLlm = truncateForLlm;
const path = __importStar(require("path"));
/**
 * Directory prefixes that should never be read or listed. Matched
 * against the relative path normalized to forward slashes. Prefix-only:
 * "node_modules/foo/bar" matches "node_modules/" but "src/node_modules/"
 * does not (rare but legitimate — e.g., inside a vendored monorepo).
 *
 * Why prefix-only and not "anywhere": catching `**\/node_modules` is
 * usually right, but some monorepos legitimately have nested module
 * directories the agent might care about. Stay conservative — only
 * deny at the workspace root.
 */
const DENIED_DIRECTORY_PREFIXES = [
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    'out/',
    '.next/',
    '.nuxt/',
    '.cache/',
    '.parcel-cache/',
    '.turbo/',
    'coverage/',
    'target/', // Rust / Java build output
    '.gradle/',
    '__pycache__/',
    '.pytest_cache/',
    '.venv/',
    'venv/',
    '.tox/',
    '.idea/',
    '.vscode/', // user's own VS Code settings; extension shouldn't peek
];
/**
 * Filename patterns that should never be read. Matched against the
 * BASENAME of the file (path.basename), case-insensitive.
 *
 * Most of these are caches, lockfiles, or logs that the agent should
 * never need to consult — and that, if read, blow out the context
 * window. The lockfile case is subtle: lockfiles are large but agents
 * sometimes legitimately want to know "what version of X is locked."
 * For that we expose package.json (which lists declared dependencies)
 * and trust the agent doesn't need the full resolution graph.
 */
const DENIED_FILENAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.lock',
    'cargo.lock',
    'gemfile.lock',
    'poetry.lock',
    'pipfile.lock',
    '.ds_store',
    'thumbs.db',
]);
/**
 * Filename suffixes (extensions or trailing patterns) that should
 * never be read. Matched against the lowercased path. Useful for
 * patterns like `.tsbuildinfo` which can appear anywhere with any
 * basename prefix (e.g., `tsconfig.tsbuildinfo`, `app.tsbuildinfo`).
 */
const DENIED_SUFFIXES = [
    '.tsbuildinfo',
    '.log', // build logs, npm-debug.log, etc.
    '.lock', // generic lockfile suffix not caught above
    '.min.js',
    '.min.css',
    '.map', // source maps — large, rarely useful for agent
    '.pyc',
    '.pyo',
    '.class',
    '.o',
    '.obj',
];
/** Normalize Windows backslashes to forward slashes for matching. */
function normalizePath(p) {
    return p.replace(/\\/g, '/');
}
/**
 * Returns a human-friendly reason if the given relative path should be
 * excluded from agent reads/lists, or null if it's allowed. The caller
 * should pass through the reason to the LLM as part of the error
 * message — agents typically self-correct when given a specific
 * "use X instead" hint.
 */
function checkExclusion(relativePath) {
    const norm = normalizePath(relativePath).toLowerCase();
    const base = path.basename(norm);
    // Directory prefix check
    for (const prefix of DENIED_DIRECTORY_PREFIXES) {
        if (norm === prefix.slice(0, -1) || norm.startsWith(prefix)) {
            return `'${relativePath}' is in an excluded directory (${prefix.slice(0, -1)}). These directories contain build artifacts, dependencies, or version-control internals that shouldn't appear in the agent's context.`;
        }
    }
    // Filename check
    if (DENIED_FILENAMES.has(base)) {
        const hint = base === 'package-lock.json' || base.endsWith('.lock')
            ? ' Read `package.json` for declared dependencies instead.'
            : '';
        return `'${relativePath}' is excluded from agent reads (filename: ${base}).${hint}`;
    }
    // Suffix check
    for (const suffix of DENIED_SUFFIXES) {
        if (norm.endsWith(suffix)) {
            return `'${relativePath}' is excluded from agent reads (suffix: ${suffix}). This file is typically a build artifact or cache.`;
        }
    }
    return null;
}
/**
 * Filter a list of directory entries (from list_directory) to remove
 * the excluded ones. Used by list_directory to keep its output focused
 * on things the agent should care about.
 *
 * Note: this filters by basename only, since list_directory entries
 * don't carry their full path. That's slightly less precise than
 * checkExclusion (which can use full path for prefix matching), but
 * sufficient for filtering out the most common bloat sources at
 * directory listing time.
 */
function shouldExcludeFromListing(name) {
    const lower = name.toLowerCase();
    if (DENIED_FILENAMES.has(lower)) {
        return true;
    }
    for (const suffix of DENIED_SUFFIXES) {
        if (lower.endsWith(suffix)) {
            return true;
        }
    }
    // Match dir basenames (without trailing slash) against the deny list.
    for (const prefix of DENIED_DIRECTORY_PREFIXES) {
        const dirBase = prefix.slice(0, -1);
        if (lower === dirBase) {
            return true;
        }
    }
    return false;
}
/**
 * Maximum file content size returned to the LLM, in bytes. Files larger
 * than this are truncated and the LLM gets a notice. The UI still
 * receives the full content so the user can inspect what was actually
 * on disk.
 *
 * 30KB is roughly 7,500 tokens (at ~4 chars/token) — enough to read
 * a sizable source file but small enough that even three full reads
 * don't blow the 32K context. Tunable via the read_file tool's
 * implementation.
 */
exports.MAX_LLM_FILE_BYTES = 30_000;
/**
 * Truncate file content for LLM consumption if it exceeds the cap.
 * Returns either the original content or a truncated version with a
 * tail note explaining what happened. The user-facing UI payload
 * gets the original; only the LLM-bound copy is truncated.
 */
function truncateForLlm(content, filepath) {
    const size = Buffer.byteLength(content, 'utf8');
    if (size <= exports.MAX_LLM_FILE_BYTES) {
        return content;
    }
    // Take the first 30KB of bytes, decode safely. We use the raw
    // string slice rather than Buffer.slice to keep the result valid
    // UTF-8 — JavaScript strings are UTF-16, and code points above
    // U+FFFF are 2 chars each, but slicing on char index never produces
    // a half-character. Some bytes are lost from the budget, but
    // worst case ~3 bytes off our 30KB target.
    const head = content.slice(0, exports.MAX_LLM_FILE_BYTES);
    const omittedBytes = size - Buffer.byteLength(head, 'utf8');
    return `${head}\n\n[... file truncated for LLM context: ${omittedBytes} more bytes omitted from '${filepath}'. The user can see the full file in the UI panel. If you genuinely need to see more, ask the user or read a smaller targeted section. ...]`;
}
//# sourceMappingURL=_contextExclusions.js.map