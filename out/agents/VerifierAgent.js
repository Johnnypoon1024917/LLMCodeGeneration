"use strict";
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
exports.VerifierAgent = void 0;
exports.runVerifierCommand = runVerifierCommand;
exports.findProjectTsconfig = findProjectTsconfig;
exports.parseTscOutput = parseTscOutput;
exports.isErrorRelevant = isErrorRelevant;
exports.partitionErrors = partitionErrors;
exports.extractMissingModules = extractMissingModules;
exports.formatErrorsForCritique = formatErrorsForCritique;
exports.classifyTscError = classifyTscError;
// src/agents/VerifierAgent.ts
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const llmService_1 = require("../llmService");
const errors_1 = require("../utilities/errors");
const searchReplace_1 = require("../utilities/searchReplace");
const container_1 = require("../container");
/**
 * Wrap an `env.runCommand` invocation with lifecycle events. When the
 * caller provides `emitter` + `taskId`, `toolCallStarted` /
 * `toolCallCompleted` events fire so the webview's rich-card UI
 * renders the run as a `bash_output`-payload card (same component
 * used for the model-emitted `bash_exec` tool).
 *
 * When `emitter` is absent, the helper just runs the command — used
 * by headless CLI invocations and tests where rich cards don't apply.
 *
 * Source tag is `verifier-internal` (reserved in toolProtocol.ts).
 * The webview can theme verifier cards differently from coder cards
 * if it wants.
 *
 * `label` is the human-readable name surfaced as the card title
 * (e.g., "tsc compile", "npm install", "TDD run"). Distinct from the
 * full command, which goes in the arguments field for expanded view.
 *
 * Re-throws on failure (preserving the original error for the
 * verifier's existing catch-and-restore logic). The completion event
 * is emitted with status='error' before re-throw.
 */
async function runVerifierCommand(opts) {
    const callId = `verifier-${crypto.randomUUID()}`;
    const startTime = Date.now();
    const eventOk = opts.emitter && opts.taskId;
    if (eventOk) {
        opts.emitter.emit({
            type: 'toolCallStarted',
            taskId: opts.taskId,
            callId,
            source: 'verifier-internal',
            timestamp: startTime,
            name: opts.label,
            arguments: { command: opts.cmd, cwd: opts.workspaceRoot },
        });
    }
    try {
        const result = await opts.env.runCommand(opts.cmd, opts.workspaceRoot);
        const durationMs = Date.now() - startTime;
        if (eventOk) {
            const dispatchResult = {
                llmContent: '',
                uiPayload: {
                    kind: 'bash_output',
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: 0,
                    durationMs,
                },
            };
            opts.emitter.emit({
                type: 'toolCallCompleted',
                taskId: opts.taskId,
                callId,
                source: 'verifier-internal',
                timestamp: Date.now(),
                status: 'success',
                result: dispatchResult,
                durationMs,
            });
        }
        return result;
    }
    catch (err) {
        const durationMs = Date.now() - startTime;
        // execErrorOutput pulls out stderr-then-stdout-then-message
        // from the error. We split that into separate fields when the
        // error object has them; otherwise pack the consolidated
        // string into stderr (the field a UI is most likely to
        // surface for failures).
        const stdoutFromErr = (err && typeof err === 'object' && typeof err.stdout === 'string')
            ? err.stdout
            : '';
        const stderrFromErr = (err && typeof err === 'object' && typeof err.stderr === 'string')
            ? err.stderr
            : (0, errors_1.execErrorOutput)(err);
        if (eventOk) {
            const dispatchResult = {
                llmContent: '',
                uiPayload: {
                    kind: 'bash_output',
                    stdout: stdoutFromErr,
                    stderr: stderrFromErr,
                    exitCode: 1,
                    durationMs,
                },
            };
            opts.emitter.emit({
                type: 'toolCallCompleted',
                taskId: opts.taskId,
                callId,
                source: 'verifier-internal',
                timestamp: Date.now(),
                status: 'error',
                result: dispatchResult,
                durationMs,
            });
        }
        // Re-throw so the verifier's existing catch-and-restore path
        // keeps working unchanged.
        throw err;
    }
}
/**
 * Walk up from `startDir` looking for `tsconfig.json`. Stops at
 * `workspaceRoot` (won't escape the project). Returns the tsconfig's
 * absolute path or null when not found.
 *
 * Why walk up: monorepo / nested-project layouts can have tsconfig.json
 * in a subdirectory rather than at workspace root. Starting from the
 * touched file's directory lets us pick up the nearest applicable
 * config.
 */
async function findProjectTsconfig(env, startDir, workspaceRoot) {
    // Normalize both paths so comparison is reliable across platforms.
    const normStart = path.resolve(startDir);
    const normRoot = path.resolve(workspaceRoot);
    let dir = normStart;
    // Hard ceiling on traversal depth in case of pathological input
    // (start dir is somehow outside workspaceRoot, or the loop's
    // termination condition fails for any reason).
    for (let i = 0; i < 64; i++) {
        const candidate = path.join(dir, 'tsconfig.json');
        try {
            await env.readFile(candidate);
            // readFile succeeded → tsconfig exists.
            return candidate;
        }
        catch {
            // Doesn't exist at this level; continue up.
        }
        // Stop when we've reached workspaceRoot or above.
        if (dir === normRoot) {
            return null;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null; // reached filesystem root
        dir = parent;
    }
    return null;
}
/**
 * Parse tsc's textual output into structured errors. tsc's default
 * line format (without `--pretty`):
 *
 *   path/to/file.ts(LINE,COL): error TSCODE: message
 *
 * Some lines have continuation context (no `error TSCODE` prefix). We
 * skip those — they're indented continuation of a prior error and the
 * `raw` field on the parent error preserves them indirectly via the
 * full-output split.
 *
 * Returns a list of structured errors, in the order they appeared.
 * Robust to leading/trailing whitespace and Windows line endings.
 */
function parseTscOutput(rawOutput) {
    // Anchor: file path (any chars except parens), then `(N,N): error TSDDDD: rest`.
    // tsc paths can contain spaces on Windows so we accept any non-paren chars.
    const pattern = /^([^(]+)\((\d+),(\d+)\): error TS(\d+): (.+)$/;
    const errors = [];
    const lines = rawOutput.split(/\r?\n/);
    for (const line of lines) {
        const m = pattern.exec(line.trim());
        if (!m) {
            continue;
        }
        errors.push({
            file: m[1].trim(),
            line: parseInt(m[2], 10),
            column: parseInt(m[3], 10),
            code: m[4],
            message: m[5].trim(),
            raw: line,
        });
    }
    return errors;
}
/**
 * Decide whether a parsed error is relevant to the Coder's changes.
 *
 * Definitely relevant: error is IN one of the touched files.
 *
 * Likely relevant: error is in some other file but its message
 * mentions a module path that resolves to one of the touched files.
 * Catches the case where Coder modified `utils.ts` and broke a
 * downstream caller in `Foo.tsx`.
 *
 * Otherwise: not relevant. Pre-existing project brokenness.
 *
 * Path comparison uses both basename matching (cheap, covers the
 * common case) and a normalized-suffix check (handles relative paths
 * tsc emits vs absolute paths the caller has).
 */
function isErrorRelevant(err, touchedFiles) {
    if (touchedFiles.length === 0)
        return true; // No filter → all relevant.
    const errFileNorm = err.file.replace(/\\/g, '/').toLowerCase();
    const errBase = path.basename(err.file).toLowerCase();
    for (const touched of touchedFiles) {
        const touchedNorm = touched.replace(/\\/g, '/').toLowerCase();
        const touchedBase = path.basename(touched).toLowerCase();
        // Definitely relevant: exact basename match AND path suffix
        // alignment. Basename alone catches almost every case but
        // could false-match `foo.ts` in different directories; the
        // suffix check is the disambiguator.
        if (errBase === touchedBase) {
            // Exact base match. Now check suffix (works for both
            // relative-from-cwd and absolute paths).
            if (errFileNorm.endsWith(touchedNorm) || touchedNorm.endsWith(errFileNorm)) {
                return true;
            }
            // Even without suffix alignment, if the path tail is just
            // the basename, treat as relevant — common when tsc emits
            // bare basenames for files not under the project root.
            if (errFileNorm === errBase) {
                return true;
            }
        }
        // Likely relevant: error message mentions a module path that
        // looks like the touched file. Catches `Cannot find name 'foo'`
        // -> 'foo' was exported from a touched file. We only do a
        // lightweight basename-without-extension match here; deeper
        // module-resolution would require parsing tsconfig paths and
        // is out of scope.
        const touchedSymbol = touchedBase.replace(/\.[^.]+$/, ''); // strip ext
        if (touchedSymbol.length >= 3 && err.message.includes(touchedSymbol)) {
            return true;
        }
    }
    return false;
}
/**
 * Split parsed errors into two buckets: relevant (errors caused by or
 * downstream of Coder's changes) and unrelated (pre-existing project
 * issues). Caller decides what to surface where.
 */
function partitionErrors(errors, touchedFiles) {
    const relevant = [];
    const unrelated = [];
    for (const e of errors) {
        if (isErrorRelevant(e, touchedFiles)) {
            relevant.push(e);
        }
        else {
            unrelated.push(e);
        }
    }
    return { relevant, unrelated };
}
/**
 * Extract missing-module names from parsed errors, filtered to errors
 * IN touched files only. Returns the unique module names (excluding
 * relative imports — those would be local files, not npm packages).
 *
 * The filter on touched files matters because under project-mode, tsc
 * sees the whole project. Without filtering, the verifier would try
 * to install packages for pre-existing broken imports in untouched
 * files — "fixing" things the model didn't break.
 */
function extractMissingModules(errors, touchedFiles, missingPkgRegex) {
    const out = new Set();
    for (const err of errors) {
        // Restrict to errors physically located in touched files —
        // the "definitely relevant" subset. Errors from unrelated
        // files referencing missing modules are NOT our problem to
        // fix even if they're related to our changes; they're the
        // project's pre-existing brokenness.
        if (!isErrorInTouchedFile(err, touchedFiles)) {
            continue;
        }
        // Run the install regex against the message text.
        const r = new RegExp(missingPkgRegex.source, missingPkgRegex.flags);
        const m = r.exec(err.message);
        if (!m || m[1] === undefined) {
            continue;
        }
        const moduleName = m[1].trim();
        if (moduleName.startsWith('.') || moduleName.startsWith('/')) {
            continue;
        }
        out.add(moduleName);
    }
    return Array.from(out);
}
/**
 * Strict in-file check (no message-content fuzzy matching). Used by
 * install-retry to be conservative about which modules to install.
 */
function isErrorInTouchedFile(err, touchedFiles) {
    const errFileNorm = err.file.replace(/\\/g, '/').toLowerCase();
    const errBase = path.basename(err.file).toLowerCase();
    for (const touched of touchedFiles) {
        const touchedNorm = touched.replace(/\\/g, '/').toLowerCase();
        const touchedBase = path.basename(touched).toLowerCase();
        if (errBase === touchedBase &&
            (errFileNorm.endsWith(touchedNorm) ||
                touchedNorm.endsWith(errFileNorm) ||
                errFileNorm === errBase)) {
            return true;
        }
    }
    return false;
}
/**
 * Format a list of parsed errors as a human-readable critique block
 * suitable for feeding back to the Coder's next attempt.
 */
function formatErrorsForCritique(errors) {
    if (errors.length === 0) {
        return "";
    }
    return errors.map(e => e.raw).join('\n');
}
/**
 * Build the project-mode tsc command string. Uses `--pretty false` to
 * suppress ANSI color codes that would break the output parser, and
 * `--incremental` so repeated runs (during install-retry loop) reuse
 * the type cache.
 */
function buildProjectModeCompileCmd(tsconfigPath) {
    // The double-quoting of the tsconfig path matches the existing
    // single-file command shape (which also quotes the file).
    return `npx -p typescript tsc -p "${tsconfigPath}" --noEmit --pretty false --incremental`;
}
function getLanguageCommands(filepath) {
    const ext = path.extname(filepath).toLowerCase();
    switch (ext) {
        case '.ts':
            return {
                compileCmd: `npx -p typescript tsc --noEmit --esModuleInterop --skipLibCheck "${filepath}"`,
                installCmd: (pkgs) => {
                    const pkgList = pkgs.join(' ');
                    const typesList = pkgs.map(p => `@types/${p}`).join(' ');
                    return `npm install ${pkgList} --no-audit --no-fund && npm install -D ${typesList} --no-audit --no-fund`;
                },
                missingPkgRegex: /Cannot find module '([^']+)'/
            };
        case '.tsx':
            // Hotfix (post-2B): .tsx files need --jsx react-jsx so tsc
            // recognizes JSX syntax. Without this flag tsc emits
            // TS17004 "Cannot use JSX unless the '--jsx' flag is
            // provided" for every JSX element, even when the file is
            // otherwise valid.
            //
            // Why react-jsx (the modern automatic runtime) over the
            // classic 'react' value:
            //   - react-jsx works with React 17+ (the standard since
            //     late 2020); doesn't require an `import React from
            //     'react'` to be in scope for JSX
            //   - react-jsx is what create-react-app, Next.js, Vite,
            //     and modern tsconfig templates default to
            //   - Falling back to 'react' classic would require every
            //     file to have the React import, breaking valid modern
            //     code
            //
            // Trade-off: projects on React 16 (or projects using the
            // classic runtime explicitly) might want --jsx react. The
            // verifier compiles single files in isolation without
            // reading the user's tsconfig.json, so we can't pick the
            // user's setting. react-jsx is the better default; if a
            // user project needs the classic runtime we can revisit
            // by either reading tsconfig or adding a config override.
            return {
                compileCmd: `npx -p typescript tsc --noEmit --esModuleInterop --skipLibCheck --jsx react-jsx "${filepath}"`,
                installCmd: (pkgs) => {
                    const pkgList = pkgs.join(' ');
                    const typesList = pkgs.map(p => `@types/${p}`).join(' ');
                    return `npm install ${pkgList} --no-audit --no-fund && npm install -D ${typesList} --no-audit --no-fund`;
                },
                missingPkgRegex: /Cannot find module '([^']+)'/
            };
        case '.js':
        case '.jsx':
            return {
                compileCmd: `node -c "${filepath}"`,
                installCmd: (pkgs) => `npm install ${pkgs.join(' ')} --no-audit --no-fund`,
                missingPkgRegex: /Cannot find module '([^']+)'/
            };
        case '.py':
            return {
                compileCmd: `python -m py_compile "${filepath}"`,
                installCmd: (pkgs) => `pip install ${pkgs.join(' ')}`,
                missingPkgRegex: /ModuleNotFoundError: No module named '([^']+)'/
            };
        case '.go':
            return {
                compileCmd: `go build -o /dev/null "${filepath}"`,
                installCmd: (pkgs) => `go get ${pkgs.join(' ')}`,
                missingPkgRegex: /cannot find package "([^"]+)"/
            };
        case '.java':
            return {
                compileCmd: `javac "${filepath}"`,
                installCmd: null,
                missingPkgRegex: /package ([^\s]+) does not exist/
            };
        default:
            return { compileCmd: null, installCmd: null, missingPkgRegex: null };
    }
}
/**
 * P1.1: classify a parsed tsc error into structured `VerifierFailure`,
 * detecting unambiguous-typo patterns for single-shot self-heal.
 *
 * The set of "unambiguous" patterns is deliberately small: we'd rather
 * miss a self-heal opportunity than wrongly flag a hard problem as
 * easily-fixable. Adding patterns here is OK; removing them is a
 * regression risk because the metric counts on consistent definition.
 *
 * Patterns currently flagged as unambiguous_typo:
 *   - TS2304: "Cannot find name 'foo'" — usually a typo or missing import
 *   - TS2305: "Module 'X' has no exported member 'Y'" — typo on import
 *   - TS2307: "Cannot find module 'X'" — missing dependency or wrong path
 *   - TS2552: "Cannot find name 'foo'. Did you mean 'Foo'?" — explicit typo
 *
 * NOT flagged as unambiguous (these are real errors that need thought):
 *   - TS2322: type assignment errors — implies design-level mismatch
 *   - TS2345: argument type errors — same
 *   - TS2554: wrong number of arguments — could be either typo or design
 *
 * Exported for unit testing and so other agents (a future SmartCoder
 * with its own retry policy) can reuse the same classification.
 */
function classifyTscError(err, workspaceRoot) {
    const UNAMBIGUOUS_CODES = new Set(['2304', '2305', '2307', '2552']);
    const severity = UNAMBIGUOUS_CODES.has(err.code) ? 'unambiguous_typo' : 'error';
    // Normalize the file path to be relative to workspace when possible.
    // tsc emits paths that may be absolute or relative depending on
    // tsconfig and cwd; the Coder's retry context is easier to read
    // when paths are workspace-relative.
    //
    // Always use forward slashes in the result. tsc itself emits paths
    // with forward slashes regardless of platform; this keeps the
    // verifier's output consistent on Windows (where path.relative
    // returns backslash separators) and POSIX.
    let file = err.file;
    if (file && path.isAbsolute(file)) {
        const rel = path.relative(workspaceRoot, file);
        if (rel && !rel.startsWith('..')) {
            file = rel.replace(/\\/g, '/');
        }
    }
    return {
        kind: 'compile',
        file,
        line: err.line,
        column: err.column,
        code: err.code,
        message: err.message,
        severity
    };
}
/**
 * Procedural verifier. Compile + test + LLM PRD review. Returns
 * a {@link VerificationResult}.
 *
 * Wraps the same logic the legacy `runVerificationAgent` ran — only
 * the call signature has changed. Body preserved verbatim.
 */
class VerifierAgent {
    static async run(opts) {
        // Destructure preserves the inner variable names used throughout
        // the body — keeps the C-6 diff localized to the call signature.
        const { env, techSpec, draftDiff, workspaceRoot, testCommand, log: logCallback, emitter, taskId, } = opts;
        logCallback(`Verifier: Starting real-world verification for ${draftDiff.filepath}...`, "tool", "Applying patch to sandbox.");
        const absolutePath = path.join(workspaceRoot, draftDiff.filepath);
        let originalContent = "";
        let fileExisted = true;
        try {
            originalContent = await env.readFile(absolutePath);
        }
        catch (e) {
            fileExisted = false;
        }
        try {
            let newContent = originalContent;
            // Component 2B-3c (post-2B audit): when draftDiff carries
            // `finalContent`, the file on disk is ALREADY in its target
            // state (CoderAgent's tool calls wrote it directly). The
            // verifier must NOT re-apply or re-derive a patch — doing so
            // would either (a) overwrite correct code with a junk
            // reconstruction parsed from chat narrative, or (b) re-write
            // the same content uselessly.
            //
            // Under the tool-call path the verifier acts as a pure verifier:
            //   - newContent = draftDiff.finalContent (used for the LLM
            //     PRD review at the end; no disk write needed because the
            //     file already matches)
            //   - Compile/test the file as it sits on disk
            //   - On compile/test FAILURE: restore originalContent (which,
            //     because CoderAgent wrote post-mod before returning,
            //     IS the post-mod content the model produced — restoring
            //     to that is a no-op but also doesn't make things worse;
            //     the next CoderAgent attempt will pre-mod-restore)
            //   - On final success: skip the restore-to-original step.
            //     The file IS the desired final state. SidebarProvider's
            //     apply path will write the same content again, which is
            //     redundant but harmless.
            //
            // Legacy callers (planner narrative output, anything that
            // produces a CodeDiff without finalContent) fall through to
            // the SEARCH/REPLACE / markdown-extraction reconstruction
            // path below, exactly as before.
            const isOptionC = draftDiff.finalContent !== undefined;
            if (isOptionC) {
                newContent = draftDiff.finalContent ?? "";
                // No env.writeFile — file is already correct on disk.
                // Skip the parseBlocks / applyBlock / markdown extraction
                // path entirely.
            }
            else {
                const fullOutput = (draftDiff.fullOutputBuffer || "").replace(/\r\n/g, '\n');
                // Parse with the hardened module — handles marker fuzzing and rejects
                // empty blocks. We keep "last block wins" semantics for compatibility
                // with the Coordinator stream protocol (model may emit multiple drafts).
                let parsedBlocks = [];
                try {
                    parsedBlocks = (0, searchReplace_1.parseBlocks)(fullOutput).blocks;
                }
                catch (e) {
                    return { passed: false, critique: `Patch parser failed: ${(0, errors_1.errorMessage)(e)}. Re-emit the SEARCH/REPLACE block.` };
                }
                if (parsedBlocks.length > 0) {
                    const lastBlock = parsedBlocks[parsedBlocks.length - 1];
                    // Strip stray markdown fences from the parsed block contents
                    // (model sometimes wraps the SEARCH body in ```ts ... ```).
                    const cleanBlock = {
                        search: lastBlock.search.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim(),
                        replace: lastBlock.replace.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim(),
                        blockOffset: lastBlock.blockOffset
                    };
                    try {
                        newContent = (0, searchReplace_1.applyBlock)(originalContent, cleanBlock);
                    }
                    catch (e) {
                        // The hardened applyBlock provides much better diagnostics —
                        // surface them to the model so its retry has actionable info.
                        const apply = e;
                        const candidates = apply.candidates && apply.candidates.length > 0
                            ? `\n\nClosest matches in the file:\n${apply.candidates.join('\n')}`
                            : '';
                        return {
                            passed: false,
                            critique: `SEARCH block did not match the file. ${(0, errors_1.errorMessage)(e)}${candidates}\n\n` +
                                `Your Search Block:\n${cleanBlock.search}`
                        };
                    }
                }
                else {
                    const markdownMatch = fullOutput.match(/```[a-z]*\n([\s\S]*?)```/i);
                    if (markdownMatch && markdownMatch[1] !== undefined) {
                        newContent = markdownMatch[1].trim();
                    }
                    else {
                        newContent = fullOutput.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
                    }
                }
                await env.writeFile(absolutePath, newContent);
            }
            // Emit audit record for the write. Fire-and-forget so we don't
            // delay verification. SHA-256 of new content lets compliance
            // verify what was actually written.
            const fileBytes = Buffer.byteLength(newContent, 'utf-8');
            const fileHash = crypto.createHash('sha256').update(newContent).digest('hex');
            void (0, container_1.getDeps)().audit.logFileWrite({
                filepath: draftDiff.filepath,
                fileHash,
                bytes: fileBytes,
                operation: fileExisted ? 'modify' : 'create'
            });
            const { compileCmd, installCmd, missingPkgRegex } = getLanguageCommands(absolutePath);
            let compiled = false;
            let compilerOutput = "";
            let retryCount = 0;
            const MAX_INSTALL_RETRIES = 2;
            // ─── Project-mode compile attempt (preferred path) ──────
            // Try to find a tsconfig.json by walking up from the
            // touched file's directory. If found, run `tsc -p <config>
            // --noEmit` against the whole project — catches cross-
            // file errors that single-file mode misses entirely.
            //
            // On any failure of project-mode (no tsconfig, tsc throws
            // unparseable output, parse errors, retry budget reached
            // without install-fix candidates), fall through to the
            // legacy single-file path. The fallback log line is at
            // info level so debug sessions can see when project-mode
            // didn't apply.
            const touchedFiles = [draftDiff.filepath];
            let projectModeAttempted = false;
            let projectModeSucceeded = false;
            if (compileCmd) {
                const tsconfigPath = await findProjectTsconfig(env, path.dirname(absolutePath), workspaceRoot);
                if (tsconfigPath) {
                    projectModeAttempted = true;
                    logCallback(`Verifier: Compiling project (tsconfig: ${path.relative(workspaceRoot, tsconfigPath) || tsconfigPath})...`, "tool", buildProjectModeCompileCmd(tsconfigPath));
                    while (!projectModeSucceeded && retryCount <= MAX_INSTALL_RETRIES) {
                        try {
                            await runVerifierCommand({
                                env,
                                cmd: buildProjectModeCompileCmd(tsconfigPath),
                                workspaceRoot,
                                label: 'tsc compile (project mode)',
                                ...(emitter ? { emitter } : {}),
                                ...(taskId ? { taskId } : {}),
                            });
                            projectModeSucceeded = true;
                            compiled = true;
                        }
                        catch (error) {
                            const rawOutput = (0, errors_1.execErrorOutput)(error);
                            // Sanity check: tsc emitting its version banner
                            // or "COMMON COMMANDS" usage means the command
                            // didn't run as expected. Bail out of project-
                            // mode entirely and let the fallback handle it.
                            if (rawOutput.includes("COMMON COMMANDS") || rawOutput.includes("Version ")) {
                                logCallback(`Verifier: project-mode tsc emitted unexpected output, falling back to single-file mode.`, "info", rawOutput.slice(0, 200));
                                break;
                            }
                            const parsedErrors = parseTscOutput(rawOutput);
                            // If parsing produced nothing but tsc threw,
                            // we can't reason about what failed — fall
                            // back to single-file mode.
                            if (parsedErrors.length === 0) {
                                logCallback(`Verifier: project-mode tsc output unparseable, falling back to single-file mode.`, "info");
                                break;
                            }
                            const { relevant, unrelated } = partitionErrors(parsedErrors, touchedFiles);
                            // Pre-existing project errors are always
                            // logged at info level (so the user can spot
                            // them in debug) but NOT pushed to the Coder.
                            if (unrelated.length > 0) {
                                logCallback(`Verifier: project has ${unrelated.length} pre-existing TS error(s) outside Coder's changes (not surfaced to retry).`, "info");
                            }
                            // No relevant errors → Coder's changes are
                            // clean. Treat as success even though tsc
                            // exited non-zero.
                            if (relevant.length === 0) {
                                projectModeSucceeded = true;
                                compiled = true;
                                continue;
                            }
                            // Install-retry path: extract missing modules
                            // from errors IN touched files only (strict
                            // subset of "relevant"). We don't try to
                            // install modules referenced in other files
                            // even if those errors are likely-relevant
                            // via fuzzy matching — that'd risk "fixing"
                            // pre-existing brokenness.
                            if (missingPkgRegex && installCmd && retryCount < MAX_INSTALL_RETRIES) {
                                const missingModules = extractMissingModules(parsedErrors, touchedFiles, missingPkgRegex);
                                if (missingModules.length > 0) {
                                    const installStr = installCmd(missingModules);
                                    logCallback(`Verifier: 📦 Batch installing ${missingModules.length} missing dependencies (project mode): [${missingModules.join(', ')}]...`, "tool", installStr);
                                    try {
                                        await runVerifierCommand({
                                            env,
                                            cmd: installStr,
                                            workspaceRoot,
                                            label: `npm install (${missingModules.length} packages)`,
                                            ...(emitter ? { emitter } : {}),
                                            ...(taskId ? { taskId } : {}),
                                        });
                                        retryCount++;
                                        continue; // retry compile
                                    }
                                    catch (installErr) {
                                        // Install itself failed —
                                        // surface the install error AND
                                        // the relevant-only critique.
                                        compilerOutput =
                                            `Failed to batch install [${missingModules.join(', ')}]: ${(0, errors_1.errorMessage)(installErr)}\n\n` +
                                                `Compiler Errors (in your changes):\n${formatErrorsForCritique(relevant)}`;
                                        // Mark as project-mode-resolved
                                        // (don't fall back) — we have a
                                        // complete diagnosis, just a
                                        // failing one.
                                        projectModeAttempted = true;
                                        break;
                                    }
                                }
                            }
                            // No install candidates and errors remain.
                            // Build the critique from RELEVANT errors
                            // only — pre-existing project issues stay
                            // out of the Coder's retry context.
                            compilerOutput = formatErrorsForCritique(relevant);
                            // Mark project-mode as the resolution path
                            // (no fallback) — we have a clean,
                            // scoped diagnosis.
                            projectModeAttempted = true;
                            break;
                        }
                    }
                }
            }
            // ─── Single-file fallback (legacy path) ─────────────────
            // Runs when:
            //   - Language has no compile command (non-TS files).
            //   - No tsconfig.json found (project doesn't use TS
            //     project structure).
            //   - Project-mode tsc emitted unparseable output.
            //
            // Behavior unchanged from pre-C-7 code — same single-file
            // tsc invocation, same error filtering, same install-retry
            // semantics. Tests in the legacy path still pass.
            const shouldRunFallback = compileCmd
                && !projectModeSucceeded
                && !projectModeAttempted; // attempted-and-resolved means we have a diagnosis already
            if (shouldRunFallback) {
                if (projectModeAttempted) {
                    // This shouldn't be reachable given the guard above
                    // but keep a defensive log line in case the flag
                    // semantics drift in future maintenance.
                    logCallback(`Verifier: project-mode attempted but inconclusive; running single-file compile.`, "info");
                }
                logCallback(`Verifier: Compiling file...`, "tool", compileCmd);
                while (!compiled && retryCount <= MAX_INSTALL_RETRIES) {
                    try {
                        await runVerifierCommand({
                            env,
                            cmd: compileCmd,
                            workspaceRoot,
                            label: 'tsc compile',
                            ...(emitter ? { emitter } : {}),
                            ...(taskId ? { taskId } : {}),
                        });
                        compiled = true;
                    }
                    catch (error) {
                        compilerOutput = (0, errors_1.execErrorOutput)(error);
                        if (compilerOutput.includes("COMMON COMMANDS") || compilerOutput.includes("Version ")) {
                            throw new Error(`Compiler failed to target the file. Output: ${compilerOutput}`);
                        }
                        const targetFileName = path.basename(absolutePath);
                        const errorLines = compilerOutput.split('\n').filter(line => {
                            // 🚀 THE TEMPORAL IMPORT FIX: Ignore missing LOCAL files (starting with . or /)
                            if (line.match(/Cannot find module '[\.\/]/) || line.match(/File '.*' is not a module/)) {
                                return false;
                            }
                            const hasTargetFile = line.includes(targetFileName);
                            const hasMissingModule = missingPkgRegex ? new RegExp(missingPkgRegex.source, missingPkgRegex.flags).test(line) : false;
                            return hasTargetFile || hasMissingModule;
                        });
                        const filteredOutput = errorLines.join('\n').trim();
                        const outputHasMissingModule = missingPkgRegex ? new RegExp(missingPkgRegex.source, missingPkgRegex.flags).test(filteredOutput) : false;
                        if (!filteredOutput.includes(targetFileName) && !outputHasMissingModule) {
                            compiled = true;
                            continue;
                        }
                        let installedSomething = false;
                        if (missingPkgRegex && installCmd && retryCount < MAX_INSTALL_RETRIES) {
                            const globalRegex = new RegExp(missingPkgRegex.source, missingPkgRegex.flags.includes('g') ? missingPkgRegex.flags : missingPkgRegex.flags + 'g');
                            const matches = [...compilerOutput.matchAll(globalRegex)];
                            const missingPackages = new Set();
                            for (const match of matches) {
                                if (match[1] === undefined) {
                                    continue;
                                }
                                const moduleName = match[1].trim();
                                if (!moduleName.startsWith('.') && !moduleName.startsWith('/')) {
                                    missingPackages.add(moduleName);
                                }
                            }
                            if (missingPackages.size > 0) {
                                const packageArray = Array.from(missingPackages);
                                const installStr = installCmd(packageArray);
                                logCallback(`Verifier: 📦 Batch installing ${packageArray.length} missing dependencies: [${packageArray.join(', ')}]...`, "tool", installStr);
                                try {
                                    await runVerifierCommand({
                                        env,
                                        cmd: installStr,
                                        workspaceRoot,
                                        label: `npm install (${packageArray.length} packages)`,
                                        ...(emitter ? { emitter } : {}),
                                        ...(taskId ? { taskId } : {}),
                                    });
                                    installedSomething = true;
                                    retryCount++;
                                }
                                catch (installErr) {
                                    compilerOutput = `Failed to batch install [${packageArray.join(', ')}]: ${(0, errors_1.errorMessage)(installErr)}\n\nCompiler Error:\n${filteredOutput}`;
                                }
                            }
                        }
                        if (installedSomething) {
                            continue;
                        }
                        else {
                            compilerOutput = filteredOutput;
                            break;
                        }
                    }
                }
            }
            if (compileCmd && !compiled) {
                // Component 2B-3c: under the tool-call path, the file on
                // disk is already what CoderAgent produced. CoderAgent
                // will pre-mod-restore at the start of the NEXT attempt.
                // Coordinator handles restoration on max-retry-failure.
                // Skipping here avoids a redundant no-op write
                // (originalContent IS post-mod when finalContent is set).
                if (!isOptionC) {
                    if (fileExisted) {
                        await env.writeFile(absolutePath, originalContent);
                    }
                    else {
                        await env.deleteFile(absolutePath);
                    }
                }
                // P1.1: parse the compiler output into structured
                // failures for the Coordinator's retry loop. The
                // critique blob is kept for backwards compat (and as
                // a fallback when parsing produces zero results, e.g.
                // a non-tsc compiler with output we don't recognize).
                const parsedErrors = parseTscOutput(compilerOutput);
                const structuredFailures = parsedErrors.map((err) => classifyTscError(err, workspaceRoot));
                return {
                    passed: false,
                    critique: `🚨 COMPILER ERROR DETECTED 🚨\n\n${compilerOutput}\n\nYou MUST fix these exact errors in your next attempt.`,
                    ...(structuredFailures.length > 0 ? { failures: structuredFailures } : {})
                };
            }
            if (testCommand) {
                logCallback(`Verifier: Code compiled. Running TDD Suite...`, "tool", testCommand);
                try {
                    await runVerifierCommand({
                        env,
                        cmd: testCommand,
                        workspaceRoot,
                        label: 'TDD test run',
                        ...(emitter ? { emitter } : {}),
                        ...(taskId ? { taskId } : {}),
                    });
                    logCallback(`Verifier: 🧪 All TDD tests passed!`, "success");
                }
                catch (testErr) {
                    const failureLog = (0, errors_1.execErrorOutput)(testErr);
                    // Component 2B-3c: see compile-failure branch for rationale.
                    if (!isOptionC) {
                        if (fileExisted) {
                            await env.writeFile(absolutePath, originalContent);
                        }
                        else {
                            await env.deleteFile(absolutePath);
                        }
                    }
                    // P1.1: surface a single structured test-failure.
                    // Per-test extraction across runners (Jest, Vitest,
                    // Mocha, pytest) is its own piece of work and not
                    // in P1.1 scope — for now we attach one failure
                    // summarizing the entire test run so the Coordinator's
                    // structured retry path doesn't fall back to prose.
                    const testFailure = {
                        kind: 'test',
                        file: draftDiff.filepath || null,
                        message: failureLog.slice(0, 2000), // cap to keep prompt size sane
                        severity: 'error'
                    };
                    return {
                        passed: false,
                        critique: `🚨 TDD TEST FAILURE 🚨\n\nYour code compiled, but it FAILED the PRD Business Rules.\n\nTest Output:\n${failureLog}\n\nYou MUST rewrite the logic to make the tests pass.`,
                        failures: [testFailure]
                    };
                }
            }
            logCallback(`Verifier: Running logical PRD review...`, "analyze", "Checking against business rules.");
            const llmVerification = await (0, llmService_1.verifyAgainstSpec)(techSpec, "Review the technical spec.", newContent);
            // Component 2B-3c: under Option C the file IS the desired final
            // state — no sandbox to clean up. SidebarProvider's apply path
            // writes the same content again (harmless redundancy). Under
            // legacy flow the verifier always works in a sandbox, so it
            // restores here so SidebarProvider can do the real apply.
            if (!isOptionC) {
                if (fileExisted) {
                    await env.writeFile(absolutePath, originalContent);
                }
                else {
                    await env.deleteFile(absolutePath);
                }
            }
            return { passed: llmVerification.verified, critique: llmVerification.reasoning, usage: llmVerification.usage };
        }
        catch (err) {
            // Component 2B-3c: catastrophic-error path. Under Option C the
            // file is whatever swarmDraftCode left on disk. We don't try
            // to restore here — Coordinator handles cleanup on max-retry
            // failure. Under legacy flow we still restore.
            // We can't reliably know `isOptionC` from inside the catch block
            // because the flag is scoped above; but draftDiff.finalContent
            // is the source of truth, check that instead.
            if (draftDiff.finalContent === undefined) {
                if (fileExisted) {
                    await env.writeFile(absolutePath, originalContent);
                }
                else {
                    await env.deleteFile(absolutePath);
                }
            }
            return { passed: false, critique: `Catastrophic Patch Error: ${(0, errors_1.errorMessage)(err)}` };
        }
    }
}
exports.VerifierAgent = VerifierAgent;
//# sourceMappingURL=VerifierAgent.js.map