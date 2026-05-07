#!/usr/bin/env node
"use strict";
// src/cli.ts
//
// NexusCode command-line interface.
//
// SCOPE — POST CLI-BRING-UP PATCH
// ============================================================
// What works:
//   - Commander-based subcommand routing (chat, ci, --help, --version)
//   - Basic readline REPL for interactive chat
//   - Config loading: flags > env > .nexus/cli.json
//   - Container plumbing: `setDeps()` is bootstrapped with CLI shims for
//     Memento/SecretStorage/Uri and a CliConfigSource. Calls to
//     `getLLMConfig()` resolve the same way they do in the IDE.
//
// What's still stubbed (work for "Session B" — streaming bring-up):
//   - `nexuscode chat -p "prompt"` and `nexuscode chat` REPL:
//     accept input and print back stub messages instead of streaming
//     real LLM responses. The plumbing is ready (config is resolvable),
//     but actually calling streamChat / handling SSE / aborts / token
//     rendering is its own design surface that deserves a dedicated
//     session.
//   - `nexuscode ci`: reads .nexus/specs/main/tasks.md and lists pending
//     tasks but cannot execute them. Wiring up runTask from
//     CLI is "Session C" work — exit codes, progress display, diff
//     handling, all need explicit decisions.
//
// All not-yet-wired code paths are marked with `// TODO(B)` or `// TODO(C)`.
// ============================================================
// ============================================================
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
const commander_1 = require("commander");
const readline = __importStar(require("readline"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const errors_1 = require("./utilities/errors");
const container_1 = require("./container");
const CliConfigSource_1 = require("./adapters/CliConfigSource");
const i18n_1 = require("./i18n");
const AuditLog_1 = require("./audit/AuditLog");
const exportCli_1 = require("./audit/exportCli");
// import { CIEnvironment } from './adapters/CIEnvironment';
// import { runTask } from './agents/Coordinator';
// ^ NOTE: importing these brings in llmService.ts which transitively
// imports vscode. The skeleton doesn't actually call them yet — see §22 B+C work.
// ───────────────────────────────────────────────────────────────────
// CLI-side dependency injection
// ───────────────────────────────────────────────────────────────────
/**
 * Bootstrap `setDeps` with a CLI-flavored implementation. Must run BEFORE
 * any code that calls `getDeps()` — including any imports that transitively
 * call `getLLMConfig`.
 *
 * Why each field:
 *   - state:     no-op Memento (CLI has no workspaceState analog yet)
 *   - secrets:   read-only shim that returns api-key from config
 *   - extensionUri: placeholder; CLI doesn't load webview resources
 *   - subscriptions: no-op array; process exit handles cleanup
 *   - config:    CliConfigSource layered over flags/env/file
 *
 * In a future session we'll likely need a real persistent store for
 * `state` (chat history, task statuses) — probably a JSON file under
 * `.nexus/cli-state.json`. For now the no-op is sufficient because the
 * CLI's stub command bodies don't actually call into LLM workflows.
 */
async function bootstrapCliDeps(workspaceRoot, flags) {
    // Initialize i18n. CLI defaults to English; future versions may read
    // a --locale flag or NEXUSCODE_LOCALE env var.
    await (0, i18n_1.initI18n)('en');
    const fileConfig = await (0, CliConfigSource_1.loadCliJson)(workspaceRoot);
    const config = new CliConfigSource_1.CliConfigSource({ flags, file: fileConfig });
    // Initialize audit log. Same shape as IDE — workspace-scoped JSONL
    // under .nexus/audit/. Hash chain init reads any existing logs.
    const audit = new AuditLog_1.AuditLog(workspaceRoot);
    await audit.init();
    (0, container_1.setDeps)({
        state: cliMemento(),
        secrets: cliSecretStorage(config),
        extensionUri: cliPlaceholderUri(workspaceRoot),
        subscriptions: [],
        config,
        audit
    });
}
/** No-op Memento — keys silently disappear. Replace with file-backed impl when CLI gains persistence. */
function cliMemento() {
    const store = new Map();
    return {
        keys: () => Array.from(store.keys()),
        get: (key, defaultValue) => {
            const v = store.get(key);
            return v !== undefined ? v : defaultValue;
        },
        update: async (key, value) => {
            if (value === undefined) {
                store.delete(key);
            }
            else {
                store.set(key, value);
            }
        }
    };
}
/**
 * Read-only SecretStorage shim. Returns the api-key from the resolved
 * config (env/flag/file). `store`/`delete` are no-ops with a warning,
 * because the CLI shouldn't be writing secrets — the user manages those
 * via env vars or vault.
 */
function cliSecretStorage(config) {
    return {
        get: async (key) => {
            // The IDE stores API keys under 'nexuscode_apikey'. Map to the
            // CLI's apiKey config so the existing getLLMConfig codepath
            // works unchanged.
            if (key === 'nexuscode_apikey') {
                return config.get('apiKey');
            }
            return undefined;
        },
        store: async (_key, _value) => {
            // Intentional no-op. CLI doesn't persist secrets — env-var input only.
        },
        delete: async (_key) => {
            // Intentional no-op.
        },
        onDidChange: () => ({ dispose: () => { } })
    };
}
/** Placeholder Uri for the CLI runtime. Webview-loading code shouldn't run here. */
function cliPlaceholderUri(workspaceRoot) {
    return { fsPath: workspaceRoot, scheme: 'file', path: workspaceRoot };
}
async function cmdChat(flags) {
    const cwd = process.cwd();
    const config = await resolveAndValidateConfig(flags, cwd);
    if (flags.prompt !== undefined) {
        await runOneShotPrompt(flags.prompt, config, cwd);
    }
    else {
        await runReplLoop(config, cwd);
    }
}
async function cmdCi(flags) {
    const cwd = process.cwd();
    const config = await resolveAndValidateConfig(flags, cwd);
    const specSlug = flags.spec ?? 'main';
    // Locate tasks.md
    const tasksPath = path.join(cwd, '.nexus', 'specs', specSlug, 'tasks.md');
    let tasksMd;
    try {
        tasksMd = await fs.readFile(tasksPath, 'utf-8');
    }
    catch {
        process.stderr.write(`Error: ${tasksPath} not found.\n`);
        process.stderr.write(`Run 'nexuscode spec init' (NOT IMPLEMENTED YET) or create it manually.\n`);
        process.exit(2);
    }
    // Find pending checkboxes
    const pending = findPendingTasks(tasksMd);
    if (pending.length === 0) {
        process.stdout.write(`No pending tasks in ${tasksPath}. Nothing to do.\n`);
        process.exit(0);
    }
    process.stdout.write(`Found ${pending.length} pending task(s) in ${specSlug}/tasks.md\n`);
    // TODO(C): Run each task through runTask.
    //
    // The blocker after §23 hybrid landed:
    //   runTask → eventually getLLMConfig() in
    //   llmService.ts, which still reads vscode.workspace.getConfiguration
    //   directly. The hybrid Container introduced in §23 made `state`,
    //   `secrets`, and `extensionUri` swappable, but `vscode.workspace`
    //   wasn't part of the deps interface (it's a top-level API, not
    //   extension-context-scoped). Unblock plan:
    //     1. Add a `ConfigSource` interface to ExtensionDeps that exposes
    //        the read methods getLLMConfig actually uses (`get<string>`)
    //     2. Provide a CliConfigSource here that reads env + .nexus/cli.json
    //     3. Refactor getLLMConfig to take its config from deps.config
    //
    // Until then, we list the tasks and exit with code 100 ("not yet
    // implemented") so CI scripts can detect this as a known-stub state
    // rather than a real failure.
    for (const task of pending) {
        process.stdout.write(`  • ${task.description}\n`);
    }
    process.stdout.write(`\nCLI execution is not yet wired up to the LLM (blocked on streaming bring-up (Session B)).\n`);
    process.stdout.write(`Use the IDE for now. Config that would have been used:\n`);
    process.stdout.write(`  endpoint: ${config.endpoint ?? '(unset)'}\n`);
    process.stdout.write(`  model:    ${config.model ?? '(unset)'}\n`);
    process.stdout.write(`  apiKey:   ${config.apiKey ? '(set)' : '(unset)'}\n`);
    process.exit(100);
}
function findPendingTasks(md) {
    const out = [];
    const lines = md.split('\n');
    // Match `- [ ] Description` or `1. [ ] Description` etc.
    const re = /^\s*(?:\d+\.\s+|[-*]\s+)?\[ \]\s*(?:\*\*([^*]+?)\*\*|([^(\n]+?))(?:\s*\(File:.*)?$/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const m = line.match(re);
        if (m) {
            const desc = (m[1] ?? m[2] ?? '').trim();
            if (desc) {
                out.push({ description: desc, line: i + 1 });
            }
        }
    }
    return out;
}
async function resolveAndValidateConfig(flags, cwd) {
    // Build the flags dict in CliConfigSource's expected shape (uses flag-key
    // names like "endpoint", not config-namespace names like "apiEndpoint").
    const flagDict = {};
    if (flags.endpoint !== undefined)
        flagDict['endpoint'] = flags.endpoint;
    if (flags.model !== undefined)
        flagDict['model'] = flags.model;
    if (flags.apiKey !== undefined)
        flagDict['apiKey'] = flags.apiKey;
    if (flags.maxTokens !== undefined) {
        const parsed = Number.parseInt(flags.maxTokens, 10);
        if (!Number.isNaN(parsed)) {
            flagDict['maxTokens'] = parsed;
        }
    }
    // Bootstrap the container with the resolved CliConfigSource. This must
    // run BEFORE any code calls getDeps() — including transitively via
    // getLLMConfig(). Each subcommand calls this once.
    await bootstrapCliDeps(cwd, flagDict);
    // Read the resolved values back out for display purposes. The actual
    // LLM-call path will call getLLMConfig() which reads from the same
    // ConfigSource.
    const fileConfig = await (0, CliConfigSource_1.loadCliJson)(cwd);
    const source = new CliConfigSource_1.CliConfigSource({ flags: flagDict, file: fileConfig });
    return {
        endpoint: source.get('apiEndpoint'),
        model: source.get('model'),
        apiKey: source.get('apiKey'),
        maxTokens: source.get('maxTokens')
    };
}
async function runOneShotPrompt(prompt, config, _cwd) {
    process.stdout.write(`> ${prompt}\n`);
    // TODO(B): Stream the LLM response.
    //
    // The intended behavior:
    //   const env = new CIEnvironment();
    //   const stream = await streamChat(prompt, /* gathered context */, [], onToken);
    //   await stream;
    //
    // Blocked because streamChat → getLLMConfig → vscode.workspace, and
    // we don't have the workspace API. See §23 for the unblock plan.
    process.stdout.write(`\n[CLI is not yet wired up to the LLM — blocked on streaming bring-up (Session B).]\n`);
    process.stdout.write(`Config that would have been used:\n`);
    process.stdout.write(`  endpoint: ${config.endpoint ?? '(unset)'}\n`);
    process.stdout.write(`  model:    ${config.model ?? '(unset)'}\n`);
    process.exit(100);
}
async function runReplLoop(config, cwd) {
    process.stdout.write(`NexusCode CLI — interactive chat (type 'exit' or Ctrl+D to quit)\n`);
    process.stdout.write(`Workspace: ${cwd}\n`);
    process.stdout.write(`Endpoint:  ${config.endpoint ?? '(unset — chat will not work yet)'}\n`);
    process.stdout.write(`Model:     ${config.model ?? '(unset)'}\n\n`);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'nexus> '
    });
    rl.prompt();
    rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/quit') {
            rl.close();
            return;
        }
        if (trimmed === '') {
            rl.prompt();
            return;
        }
        // TODO(B): Stream the actual LLM response here.
        // For now, echo a placeholder so the REPL is visibly alive.
        process.stdout.write(`[stub] would prompt LLM with: "${trimmed}"\n`);
        process.stdout.write(`[stub] LLM connection blocked on streaming bring-up (Session B) (streaming not yet wired).\n\n`);
        rl.prompt();
    });
    rl.on('close', () => {
        process.stdout.write(`\nExiting.\n`);
        process.exit(0);
    });
}
// ───────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────
async function main() {
    const program = new commander_1.Command();
    program
        .name('nexuscode')
        .description('NexusCode CLI — agentic coding from your terminal')
        .version('0.1.0');
    // Shared options — declared per-subcommand because commander's option
    // inheritance is finicky and we want each subcommand's --help to be
    // self-contained.
    const sharedOpts = (cmd) => cmd
        .option('-e, --endpoint <url>', 'LLM endpoint URL (override env / file)')
        .option('-m, --model <name>', 'Model name (override env / file)')
        .option('-k, --api-key <key>', 'API key (override env / file; prefer env for CI)')
        .option('--max-tokens <n>', 'Max tokens per response');
    sharedOpts(program
        .command('chat')
        .description('Start an interactive chat session, or send a one-shot prompt')
        .option('-p, --prompt <text>', 'Send a one-shot prompt and exit (non-interactive)'))
        .action(async (flags) => {
        await cmdChat(flags);
    });
    sharedOpts(program
        .command('ci')
        .description('Run pending tasks from .nexus/specs/<spec>/tasks.md (CI mode)')
        .option('-s, --spec <slug>', 'Spec slug to execute (default "main")'))
        .action(async (flags) => {
        await cmdCi(flags);
    });
    // ── audit subcommand group ────────────────────────────────────
    //
    // `nexuscode audit export` and `nexuscode audit verify`. Both bootstrap
    // the deps container (so AuditLog is available) and read existing logs.
    // Neither modifies log files.
    const auditCmd = program
        .command('audit')
        .description('Inspect or export the audit log');
    auditCmd
        .command('export')
        .description('Export audit records as JSONL or CSV')
        .option('-f, --format <jsonl|csv>', 'Output format (default jsonl)', 'jsonl')
        .option('--since <iso-date>', 'Include records on or after this ISO date (e.g. 2026-04-01)')
        .option('--until <iso-date>', 'Include records on or before this ISO date (e.g. 2026-04-30)')
        .option('-o, --output <path>', 'Write to file instead of stdout')
        .action(async (flags) => {
        await bootstrapCliDeps(process.cwd(), {});
        await (0, exportCli_1.runExport)(flags);
    });
    auditCmd
        .command('verify')
        .description('Verify the audit log hash chain integrity')
        .action(async () => {
        await bootstrapCliDeps(process.cwd(), {});
        await (0, exportCli_1.runVerify)();
    });
    // Default: if invoked with no args, show help.
    if (process.argv.length <= 2) {
        program.outputHelp();
        process.exit(0);
    }
    try {
        await program.parseAsync(process.argv);
    }
    catch (e) {
        process.stderr.write(`\nFatal: ${(0, errors_1.errorMessage)(e)}\n`);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=cli.js.map