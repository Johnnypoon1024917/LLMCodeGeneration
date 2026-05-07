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
exports.EmptyCompletionError = exports.CHAT_CONTEXT_CHAR_BUDGET = exports.DEFAULT_ENDPOINT = void 0;
exports.resilientFetch = resilientFetch;
exports.getLLMConfig = getLLMConfig;
exports.getThinkingProfile = getThinkingProfile;
exports.authHeaders = authHeaders;
exports.safeParseJSON = safeParseJSON;
exports.determineIntent = determineIntent;
exports.truncateContextForChat = truncateContextForChat;
exports.streamChat = streamChat;
exports.generateRequirements = generateRequirements;
exports.validateTasksPlan = validateTasksPlan;
exports.generatePlan = generatePlan;
exports.inferTargetFile = inferTargetFile;
exports.generateTests = generateTests;
exports.healError = healError;
exports.generateAtomicEdits = generateAtomicEdits;
exports.getAvailableModels = getAvailableModels;
exports.stripThinkingPreamble = stripThinkingPreamble;
exports.generateDesign = generateDesign;
exports.generateTasks = generateTasks;
exports.verifyAgainstSpec = verifyAgainstSpec;
exports.updateLivingPRD = updateLivingPRD;
exports.reviewCodeCompleteness = reviewCodeCompleteness;
exports.healGlobalBuild = healGlobalBuild;
exports.askSecurityMonitorVerbose = askSecurityMonitorVerbose;
exports.askSecurityMonitor = askSecurityMonitor;
exports.generateAdversarialTest = generateAdversarialTest;
exports.compactConversationHistory = compactConversationHistory;
exports.generateMCTSApproaches = generateMCTSApproaches;
// src/llmService.ts
const vscode = __importStar(require("vscode"));
// Trigger registration of all tools by importing the barrel.
require("./agents/tools");
const container_1 = require("./container");
const RetryManager_1 = require("./infrastructure/RetryManager");
const RateLimitManager_1 = require("./infrastructure/RateLimitManager");
const errors_1 = require("./utilities/errors");
const jsonRequest_1 = require("./llm/jsonRequest");
const errors_2 = require("./llm/errors");
const llm_1 = require("./llm");
const jsonSchemas_1 = require("./llm/jsonSchemas");
const logger_1 = require("./logger");
let _apiKeyMigrated = false;
/**
 * Default model identifier when neither the user's `nexuscode.model`
 * setting nor any role-specific override is set, and when the
 * VS Code config layer can't be reached at all (CLI runtime with no
 * config file, fresh first-launch before settings are written, etc).
 *
 * IMPORTANT: this must match `package.json` → contributes →
 * configuration → `nexuscode.model`.default. Drifting between the two
 * causes "the setting says X but the runtime uses Y" support tickets.
 *
 * Migration history:
 *   - v1.x  → 'qwen2.5-coder' (default before V2.0)
 *   - V2.0+ → 'qwen3.6-27b'   (thinking-mode capable, native tool calls)
 *
 * If you change this, also update:
 *   - package.json (contributes.configuration.nexuscode.model.default)
 *   - tests under src/test/unit/perAgentRouting.test.ts
 *   - tests under src/test/unit/provider.test.ts (model-name string)
 *   - tests under src/test/unit/sessionDiagnostics.test.ts
 */
const DEFAULT_MODEL = 'qwen3.6-27b';
/**
 * Last-resort endpoint default. Reached only when the user has
 * neither configured `nexuscode.apiEndpoint` nor set the
 * `NEXUSCODE_API_ENDPOINT` env var. Pre-marketplace, this points at
 * the lab inference cluster; v1 marketplace launch should change
 * this to either a 127.0.0.1 placeholder (forcing first-run setup)
 * or remove the fallback entirely with an explicit "configure your
 * endpoint" onboarding flow. Tracked as a v1 polish item — do NOT
 * ship this address to the public marketplace.
 */
exports.DEFAULT_ENDPOINT = 'http://192.168.191.41:8000/v1/chat/completions';
function decodeHTMLEntities(text) {
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
    };
    let decoded = text.replace(/&[a-z0-9]+;/gi, (match) => entities[match] || match);
    decoded = decoded.replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(dec));
    return decoded;
}
async function resilientFetch(url, options, logCallback) {
    return await RetryManager_1.RetryManager.executeWithExponentialBackoff(async () => {
        // 🚀 FIX: Pre-check if the user already clicked cancel
        if (options?.signal?.aborted) {
            const e = new Error("This operation was aborted");
            e.name = 'AbortError';
            e.status = 400; // Force RetryManager to fast-fail
            throw e;
        }
        try {
            const response = await fetch(url, options);
            // Let the RateLimitManager inspect the headers. If it's a 429, it will pause the thread
            // and throw an error to trigger the RetryManager to try again.
            return await RateLimitManager_1.RateLimitManager.handleThrottling(response, logCallback);
        }
        catch (error) {
            // 🚀 FIX: Catch Fetch Abort (from Cancel button or Timeout) and force fast-fail
            if ((0, errors_1.isAbortError)(error) || options?.signal?.aborted) {
                // Throw a freshly constructed AbortError carrying status=400 so RetryManager
                // skips retries. Mutating the caught `unknown` is hostile to the type system
                // and risky if the runtime threw something exotic.
                const abortErr = new Error('AbortError');
                abortErr.name = 'AbortError';
                abortErr.status = 400;
                throw abortErr;
            }
            throw error;
        }
    }, 3, 1000, (attempt, delay, error) => {
        const msg = `⚠️ Nexus API Hiccup (${(0, errors_1.errorMessage)(error)}). Retrying in ${delay / 1000}s (Attempt ${attempt}/3)...`;
        if (logCallback) {
            logCallback(msg);
        }
        else {
            logger_1.log.warn(msg);
        }
    });
}
async function getLLMConfig(role = 'default') {
    const config = (0, container_1.getDeps)().config;
    // ── One-shot migration: plain settings.json key → SecretStorage ──
    //
    // Only attempt migration if the config source supports `update()`.
    // The IDE's VSCodeConfigSource does; the CLI's CliConfigSource does
    // not (CLI has no obvious place to persist back). In CLI mode we
    // skip the migration step — there's nothing to migrate from anyway,
    // since the CLI gets its api key from env/flags/cli.json, not from
    // a `nexuscode.apiKey` settings entry.
    if (!_apiKeyMigrated && config.update) {
        _apiKeyMigrated = true; // set first so a failed migration can't loop
        try {
            const plain = config.get('apiKey') ?? '';
            const isRealKey = plain.length > 5 && plain !== 'lm-studio';
            if (isRealKey) {
                await (0, container_1.getDeps)().secrets.store('nexuscode_apikey', plain);
                await config.update('apiKey', '');
                vscode.window.showInformationMessage("NexusCode: API key migrated to VS Code SecretStorage. The plain 'nexuscode.apiKey' setting has been cleared.");
            }
        }
        catch (e) {
            // Migration is best-effort — never block startup on it
            logger_1.log.warn('NexusCode: API key migration skipped:', e);
        }
    }
    const secureKey = await (0, container_1.getDeps)().secrets.get('nexuscode_apikey');
    // Role-specific model resolution. The per-role keys are optional —
    // when set, they override the global `nexuscode.model` for that
    // role only. When unset (typical user), every role uses the global
    // default and behavior is identical to pre-routing.
    //
    // Precedence per role:
    //   1. `nexuscode.modelPlanner` / `modelCoder` / `modelVerifier`
    //      (matching the role parameter)
    //   2. `nexuscode.model` (global default)
    //   3. hardcoded fallback (DEFAULT_MODEL — see top of file)
    //
    // The 'default' role skips step 1 and goes straight to the global,
    // which matches old behavior — useful for code paths that aren't
    // role-tagged yet.
    const globalModel = config.get('model') || DEFAULT_MODEL;
    let resolvedModel = globalModel;
    if (role === 'planner') {
        resolvedModel = config.get('modelPlanner') || globalModel;
    }
    else if (role === 'coder') {
        resolvedModel = config.get('modelCoder') || globalModel;
    }
    else if (role === 'verifier') {
        resolvedModel = config.get('modelVerifier') || globalModel;
    }
    return {
        endpoint: config.get('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: resolvedModel,
        apiKey: secureKey || undefined, // <-- no placeholder
        enableTools: config.get('enableTools') ?? true
    };
}
async function getThinkingProfile(role = 'default') {
    // Defensive: if getDeps() throws (pre-activation import paths or
    // unit tests that haven't called setDeps) OR if config.get itself
    // throws (a misbehaving config source), fall back to thinking-ON
    // Qwen 3.6 defaults. The thinking flags ride in extra_body and are
    // silently ignored by non-thinking endpoints, so the worst case
    // is "request body has a few extra fields the server ignores" —
    // never a crash. The whole-function try/catch ensures one bad
    // config-source read can't kill an agent run.
    try {
        const config = (0, container_1.getDeps)().config;
        // Per-role thinking flag. Default true for the three agent roles
        // (planner / coder / verifier); 'default' role inherits the planner
        // setting since it's the most reasoning-heavy fallback.
        const enableThinkingDefault = true;
        let configKey = null;
        if (role === 'planner') {
            configKey = 'thinkingPlanner';
        }
        else if (role === 'coder') {
            configKey = 'thinkingCoder';
        }
        else if (role === 'verifier') {
            configKey = 'thinkingVerifier';
        }
        // 'default' role: no per-role key; falls through to global default.
        const enableThinking = configKey
            ? (config.get(configKey) ?? enableThinkingDefault)
            : enableThinkingDefault;
        // preserve_thinking is on by default whenever thinking is on. The
        // efficiency win documented by Qwen (KV cache reuse, redundant-
        // reasoning reduction) is exactly what long autonomous sessions
        // need. Power users can override via nexuscode.preserveThinking.
        const preserveThinking = enableThinking
            ? (config.get('preserveThinking') ?? true)
            : false;
        if (enableThinking) {
            return {
                enableThinking: true,
                preserveThinking,
                temperature: 0.6,
                topP: 0.95,
                topK: 20,
                presencePenalty: 0.0,
            };
        }
        return {
            enableThinking: false,
            preserveThinking: false,
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            presencePenalty: 1.5,
        };
    }
    catch {
        return {
            enableThinking: true,
            preserveThinking: true,
            temperature: 0.6,
            topP: 0.95,
            topK: 20,
            presencePenalty: 0.0,
        };
    }
}
function authHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey.length > 0) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
/**
 * @deprecated Use `jsonRequest` from `./llm/jsonRequest` for new code.
 *
 * This is the legacy character-by-character JSON healer. It's retained
 * because (a) `jsonRequest`'s fallback path calls into it for endpoints
 * that don't support `response_format: { type: "json_schema" }`, and
 * (b) `traceabilityGraph.ts` and a couple of other callers outside this
 * module still depend on it.
 *
 * Do not introduce new call sites. Migrate to `jsonRequest` instead.
 */
function safeParseJSON(jsonString) {
    try {
        const startObj = jsonString.indexOf('{');
        const startArr = jsonString.indexOf('[');
        const firstChar = (startObj !== -1 && startArr !== -1) ? Math.min(startObj, startArr) : Math.max(startObj, startArr);
        const endObj = jsonString.lastIndexOf('}');
        const endArr = jsonString.lastIndexOf(']');
        const lastChar = Math.max(endObj, endArr);
        if (firstChar === -1 || lastChar === -1) {
            throw new Error("No JSON object found");
        }
        let extract = jsonString.substring(firstChar, lastChar + 1);
        //  THE ENTERPRISE HEALER
        let healed = "";
        const stack = [];
        let inString = false;
        let isEscaping = false;
        let lastMeaningfulChar = '';
        for (let i = 0; i < extract.length; i++) {
            const char = extract[i];
            if (char === undefined)
                continue; // bounded by length; defensive
            const isWhitespace = /[ \n\r\t]/.test(char);
            if (inString) {
                if (isEscaping) {
                    isEscaping = false;
                    healed += char;
                    continue;
                }
                if (char === '\\') {
                    isEscaping = true;
                    healed += char;
                    continue;
                }
                if (char === '"') {
                    inString = false;
                    lastMeaningfulChar = '"';
                    healed += char;
                    continue;
                }
                // 🚨 HEALER 1: The Missing Quote & Raw Newline Fixer
                // If the AI forgot a quote and hit a newline, or hallucinated a raw line break
                if (char === '\n' || char === '\r') {
                    let nextMeaningful = '';
                    let isKey = false;
                    let j = i + 1;
                    // Look ahead to see what the next real character is
                    while (j < extract.length) {
                        const cj = extract[j];
                        if (cj !== undefined && !/[ \n\r\t]/.test(cj)) {
                            nextMeaningful = cj;
                            if (nextMeaningful === '"') {
                                let k = j + 1;
                                while (k < extract.length && extract[k] !== '"') {
                                    k++;
                                }
                                k++;
                                while (k < extract.length) {
                                    const ck = extract[k];
                                    if (ck === undefined || !/[ \n\r\t]/.test(ck)) {
                                        break;
                                    }
                                    k++;
                                }
                                if (extract[k] === ':') {
                                    isKey = true;
                                }
                            }
                            break;
                        }
                        j++;
                    }
                    // If the next line is structural (a bracket or a new key), the AI dropped the quote!
                    if (nextMeaningful === '}' || nextMeaningful === ']' || isKey) {
                        inString = false;
                        healed += '"'; // Inject the missing quote!
                        lastMeaningfulChar = '"';
                    }
                    else {
                        healed += '\\n'; // It's a raw newline inside a string, safely escape it!
                    }
                    continue;
                }
                healed += char;
                continue;
            }
            // --- WE ARE OUTSIDE A STRING ---
            if (char === '"') {
                // 🚨 HEALER 2: The Missing Comma Fixer
                if (lastMeaningfulChar === '"' || lastMeaningfulChar === ']' || lastMeaningfulChar === '}') {
                    healed += ','; // Inject missing comma before string
                }
                inString = true;
                healed += char;
                continue;
            }
            if (char === '{' || char === '[') {
                if (lastMeaningfulChar === '"' || lastMeaningfulChar === ']' || lastMeaningfulChar === '}') {
                    healed += ','; // Inject missing comma before object/array
                }
                stack.push(char);
                healed += char;
                lastMeaningfulChar = char;
                continue;
            }
            if (char === '}' || char === ']') {
                // 🚨 HEALER 3: The Broken Bracket Fixer
                const expectedMatch = char === '}' ? '{' : '[';
                // If the stack top doesn't match, pop and auto-close missing structures!
                while (stack.length > 0 && stack[stack.length - 1] !== expectedMatch) {
                    const unclosed = stack.pop();
                    healed += (unclosed === '{' ? '}' : ']');
                }
                if (stack.length > 0 && stack[stack.length - 1] === expectedMatch) {
                    stack.pop();
                }
                healed += char;
                lastMeaningfulChar = char;
                continue;
            }
            healed += char;
            if (!isWhitespace) {
                lastMeaningfulChar = char;
            }
        }
        // 🚨 HEALER 4: The Cut-Off Fixer (If it hit a token limit)
        if (inString) {
            healed += '"';
        }
        while (stack.length > 0) {
            const unclosed = stack.pop();
            healed += (unclosed === '{' ? '}' : ']');
        }
        // 🚨 HEALER 5: The Trailing Comma Stripper
        healed = healed.replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(healed);
    }
    catch (e) {
        logger_1.log.error("=======================================================");
        logger_1.log.error("🚨 FATAL JSON PARSE ERROR 🚨");
        logger_1.log.error("The AI generated this exact string which caused the crash:");
        logger_1.log.error("-------------------------------------------------------");
        logger_1.log.error(jsonString);
        logger_1.log.error("=======================================================");
        throw new Error("Failed to extract JSON: " + String(e));
    }
}
async function determineIntent(prompt) {
    const systemPrompt = `You are an intent classifier for an AI coding assistant.
Analyze the user's prompt and classify it into EXACTLY ONE of these four categories:

1. "build" - The user gives a concrete instruction to write new code, modify a specific file, or implement a feature.
2. "explore" - The user is asking you to debug, investigate a bug, find out why something failed, or explore the codebase autonomously. (e.g., "check why it failed", "find the bug", "investigate").
3. "explain" - The user is asking for a high-level summary or architectural overview of the project.
4. "ask" - The user is asking a general question, or just chatting.

Return JSON: {"intent": "<one of: build, explore, explain, ask>"}`;
    try {
        const result = await (0, jsonRequest_1.jsonRequestData)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            schema: jsonSchemas_1.intentSchema,
            temperature: 0.1
        });
        const intent = result.intent;
        if (intent === 'build' || intent === 'explore' || intent === 'explain' || intent === 'ask') {
            return intent;
        }
        return 'ask';
    }
    catch (e) {
        return 'ask';
    }
}
/**
 * Maximum character count for the gathered-context block sent to
 * streamChat. Calibrated for the Qwen 3.6 27B 32K-token context
 * window, leaving room for the system prompt (~600 chars), history
 * (variable), user query (variable), and the response itself.
 *
 * 80,000 chars ≈ 20,000-24,000 tokens depending on content (code is
 * denser per char than prose; English averages ~4 chars/token, code
 * a bit lower). Past this we silently return 200 + empty completion
 * on the lab endpoint — not what we want.
 *
 * V2.4 (long-context survival) will replace this with proper token
 * counting via tiktoken or a model-aware tokenizer. Until then this
 * is the safety net.
 *
 * Exported so tests and the chat-context builder can reference the
 * same constant rather than re-magic-numbering elsewhere.
 */
exports.CHAT_CONTEXT_CHAR_BUDGET = 80_000;
/**
 * Truncate the gathered-context block to a safe size for the model's
 * context window. When truncation happens, we insert a visible marker
 * so the model knows the context was cut — important for accurate
 * answers ("based on what I can see, X" rather than "X is true",
 * which becomes a hallucination when the missing piece would have
 * contradicted X).
 *
 * Truncation strategy: keep the head (first 75% of the budget) and
 * the tail (remaining 25%). Codebases tend to bury the most-relevant
 * file at unpredictable positions, so a head-only trim would lose
 * common patterns like "context starts with the README, ends with
 * the open file the user was looking at".
 *
 * Pure function — no I/O — for testability.
 */
function truncateContextForChat(contextStr) {
    if (contextStr.length <= exports.CHAT_CONTEXT_CHAR_BUDGET) {
        return contextStr;
    }
    const headBudget = Math.floor(exports.CHAT_CONTEXT_CHAR_BUDGET * 0.75);
    const tailBudget = exports.CHAT_CONTEXT_CHAR_BUDGET - headBudget;
    const head = contextStr.substring(0, headBudget);
    const tail = contextStr.substring(contextStr.length - tailBudget);
    const omittedChars = contextStr.length - headBudget - tailBudget;
    return (head +
        '\n\n' +
        '─── [CONTEXT TRUNCATED — ' +
        omittedChars.toLocaleString() +
        ' characters omitted to fit context window. The middle of the gathered evidence was cut. If the user\'s question depends on the omitted region, ask them to narrow the scope.] ───' +
        '\n\n' +
        tail);
}
async function streamChat(prompt, contextStr, history, onToken, abortSignal) {
    // Provider abstraction (Component 1, Session 1):
    // streamChat is now an orchestration layer over `Provider.streamCompletion`.
    // It still owns:
    //   - System prompt construction
    //   - History message massaging (compacted-memory injection, plan-stub
    //     replacement)
    //   - Audit emission on success / error / abort
    //   - The token callback contract (for the Sidebar UI's incremental render)
    //
    // The Provider owns:
    //   - HTTP transport (retry, rate limiting)
    //   - SSE protocol parsing (data: prefixes, [DONE] sentinel, etc.)
    //   - Wire-shape concerns (model field, response_format, etc.)
    //
    // This split lets a future MindIEProvider replace the transport without
    // touching the prompt logic here.
    const provider = await (0, llm_1.getProvider)();
    // Build audit context up-front so the catch block can emit on failure
    // without re-reading config. Endpoint URL is logged but apiKey is NOT
    // (we deliberately exclude apiKey to avoid leaking it into audit logs).
    const auditPayload = {
        model: provider.model,
        endpoint: provider.endpoint,
        promptPreview: prompt.substring(0, 200),
        status: 'ok' // overwritten below if it errors
    };
    const systemPrompt = `You are Nexus, an elite Enterprise AI Software Architect. 
You are having a conversation with the developer about their codebase. 
Use the provided codebase context (Directory Tree, Open Files, and Vector DB results) to accurately answer their questions.

 ANTI-HALLUCINATION PROTOCOL 
The Vector DB Context may be polluted with old data from entirely different projects. 
You MUST prioritize the "Currently Open Files" and "Directory Tree". 
If the Vector search results (like C, Python, or FFmpeg scripts) completely clash with the open files (like a React/HTML project), IGNORE the Vector results entirely and ONLY explain the actual project files provided.

Always format your response in clean, highly readable Markdown. Use bullet points and code blocks where appropriate.`;
    const userPrompt = `--- GATHERED CODEBASE CONTEXT ---\n${truncateContextForChat(contextStr)}\n\n--- USER QUERY ---\n${prompt}`;
    const formattedHistory = history.map(msg => {
        // If this is a compacted memory block, inject it as a system prompt!
        if (msg.isCompacted) {
            return { role: "system", content: `--- PREVIOUS CONVERSATION MEMORY ---\n${msg.content}` };
        }
        // Strip out huge JSON plans or code attachments to save tokens
        const safeContent = msg.content || (msg.plan ? "[Implementation Plan Generated]" : "Empty Message");
        return { role: msg.role === 'user' ? 'user' : 'assistant', content: safeContent };
    });
    const messages = [
        { role: "system", content: systemPrompt },
        ...formattedHistory,
        { role: "user", content: userPrompt }
    ];
    try {
        const completionOptions = {
            temperature: 0.3,
            // V2.1.2 spec-fix-15: chat path explicitly excludes the
            // model's chain-of-thought. The user sees the answer, not
            // the reasoning trace — same UX as ChatGPT, Claude, etc.
            excludeReasoning: true
        };
        if (abortSignal) {
            completionOptions.signal = abortSignal;
        }
        const stream = await provider.streamCompletion(messages, completionOptions);
        // Track whether ANY non-empty token was emitted. The provider can
        // yield chunks that are empty strings (e.g. trailing-buffer
        // flushes that parse but carry no content), which would still
        // count as "got data" if we just incremented a counter — we
        // want "did the user see any actual text?".
        //
        // Why this matters: Qwen 3.6 27B with our 32K context cap has
        // been observed to return 200 + empty choices on context
        // overflow. The for-await loop runs zero iterations, the
        // function returns success, and the user sees the read tools
        // fire and then nothing. Without this guard, that's how
        // "Analyzing evidence... [silence]" reports happen.
        //
        // We throw a specific EmptyCompletionError rather than logging
        // a warning, because the caller is the only place that knows
        // how to surface this to the user (chat UI vs spec UI vs
        // background audit log). This way callers MUST handle it.
        let sawAnyTokenContent = false;
        for await (const chunk of stream) {
            if (chunk && chunk.length > 0) {
                sawAnyTokenContent = true;
            }
            onToken(chunk);
        }
        if (!sawAnyTokenContent) {
            // Audit it as an error path even though the network call
            // itself was 200, because from the user's perspective
            // this IS a failure.
            auditPayload.status = 'error';
            auditPayload.errorMessage = 'Empty completion (zero tokens emitted)';
            void (0, container_1.getDeps)().audit.logLlmCall(auditPayload);
            throw new errors_2.EmptyCompletionError('The LLM returned an empty response. This usually means the prompt + context exceeded the model\'s context window, or the model declined to answer. Try a shorter prompt, fewer attached files, or breaking the question into smaller parts.');
        }
    }
    catch (error) {
        auditPayload.status = (0, errors_1.isAbortError)(error) ? 'aborted' : 'error';
        auditPayload.errorMessage = (0, errors_1.errorMessage)(error);
        // Audit emit is fire-and-forget (returns a promise we don't await
        // here — getDeps().audit serializes writes internally). We don't
        // want a slow audit write to delay the rethrow.
        void (0, container_1.getDeps)().audit.logLlmCall(auditPayload);
        throw error;
    }
    // Success path: emit a successful llm_call record. The token counts
    // aren't tracked in this stream-chat path (no usage callback wired
    // here), so they're omitted from the payload. When/if Coordinator
    // routes through this path with a usage callback, we can add them.
    void (0, container_1.getDeps)().audit.logLlmCall(auditPayload);
}
/**
 * Re-exported from src/llm/errors.ts. The class moved to a shared
 * module so jsonRequest.ts (non-streaming path) can throw the same
 * class without importing back from llmService.ts (which would create
 * an import cycle). Existing callers are unchanged: this file still
 * exposes EmptyCompletionError as a top-level export.
 */
var errors_3 = require("./llm/errors");
Object.defineProperty(exports, "EmptyCompletionError", { enumerable: true, get: function () { return errors_3.EmptyCompletionError; } });
async function generateRequirements(rawIdea, contextStr = "", abortSignal) {
    const systemPrompt = `You are an elite Staff Product Manager. 
    The user will give you a raw idea. Expand this into a strict, Agile Product Requirements Document (PRD).
    
    Return ONLY valid JSON matching this exact schema:
    {
        "projectName": "Name",
        "domain": "Domain",
        "targetAudience": "Audience",
        "outOfScope": ["Do not build an admin panel", "Do not implement password reset yet"],
        "userStories": [
            { 
                "epic": "Authentication", 
                "story": "As a user...", 
                "acceptanceCriteria": ["Must validate email format", "Return 400 on duplicate"],
                "edgeCases": ["Network timeout during DB write", "Malformed JSON payload"]
            }
        ],
        "successMetrics": ["99.9% Uptime", "Sub-200ms latency"]
    }
    
    CRITICAL RULES:
    1. Extract exactly 5 to 8 core Epics.
    2. Think ruthlessly about EDGE CASES for every story. What happens when the database drops? What if the user sends a 10GB payload?
    3. Be explicitly clear in the "outOfScope" array about what we are NOT building.
    4. THE SINGLE QUOTE PROTOCOL: Use single quotes inside your JSON values to avoid breaking the parser.
    5. PERFECT JSON SYNTAX: Properly close all arrays and strings.`;
    const userPrompt = contextStr ? `--- ATTACHED DOCUMENTATION CONTEXT ---\n${contextStr}\n\n--- RAW IDEA ---\n${rawIdea}` : `Raw Idea: ${rawIdea}`;
    const opts = {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        schema: jsonSchemas_1.requirementPlanSchema,
        temperature: 0.2
    };
    if (abortSignal) {
        opts.signal = abortSignal;
    }
    return (0, jsonRequest_1.jsonRequestData)(opts);
}
/**
 * Hotfix (post-2B): the customer's vLLM endpoint advertises json_schema
 * support but xgrammar (vLLM's default constrained-decode backend) does
 * NOT enforce string-level constraints like `minLength`. The model can
 * therefore return tasks where `step`, `file`, and `detailedInstructions`
 * are valid strings ("") that pass schema validation but produce empty
 * cards in the UI. Observed in the wild: 17 tasks rendered with no
 * title, no file, no instructions — UI shows just "1." "2." "3."
 *
 * Schema-level fix isn't reliable (xgrammar limitation, see vLLM docs).
 * The honest fix is post-validation: after parsing the plan, reject
 * any task with empty required fields. The caller can choose to retry
 * with a corrective system message (we do this in `generateTasks`) or
 * surface the failure to the user.
 *
 * Returns null when the plan is valid; otherwise returns a human-
 * readable description of what's wrong (used in the corrective retry
 * prompt and in error messages surfaced to the user).
 *
 * Tasks may legitimately come back as plain strings (older flows did
 * this) — those are tolerated. Empty-string tasks are also rejected
 * because they produce the same UX bug.
 */
function validateTasksPlan(plan) {
    if (!plan || !Array.isArray(plan.implementationTasks)) {
        return 'plan has no implementationTasks array';
    }
    if (plan.implementationTasks.length === 0) {
        return 'plan has zero tasks';
    }
    const issues = [];
    plan.implementationTasks.forEach((task, idx) => {
        // Plain-string tasks: must be non-empty.
        if (typeof task === 'string') {
            if (!task.trim()) {
                issues.push(`task[${idx}] is an empty string`);
            }
            return;
        }
        // Object tasks: required fields must be non-empty after trim.
        // We check `step`, `file`, `detailedInstructions` because these
        // are the three the UI renders. Optional fields like
        // `relatedRequirement` may be empty without breaking anything.
        const t = task;
        const missing = [];
        if (!t.step || !String(t.step).trim()) {
            missing.push('step');
        }
        if (!t.file || !String(t.file).trim()) {
            missing.push('file');
        }
        if (!t.detailedInstructions || !String(t.detailedInstructions).trim()) {
            missing.push('detailedInstructions');
        }
        if (missing.length > 0) {
            issues.push(`task[${idx}] is missing or empty: ${missing.join(', ')}`);
        }
    });
    if (issues.length === 0) {
        return null;
    }
    // Cap the issue list at 5 entries so error messages stay readable
    // when the model returns 17 empty tasks. The first few are enough
    // to communicate the failure mode; the user doesn't need to scroll.
    const head = issues.slice(0, 5);
    const remaining = issues.length - head.length;
    if (remaining > 0) {
        head.push(`(+${remaining} more)`);
    }
    return head.join('; ');
}
/**
 * Build a corrective system message tailored to the SPECIFIC validation
 * failure pattern.
 *
 * Hotfix (post-2B): the original corrective was a generic "fields must
 * be non-empty" message — useful when the failure is empty fields, but
 * misleading when the failure is "zero tasks". The model reads "field
 * must not be empty" and tries to populate fields that... don't exist
 * because the tasks array is empty. Tailoring the message to the
 * actual failure helps the model recover on the retry.
 *
 * The xgrammar backend on vLLM doesn't enforce minLength or minItems
 * (per vLLM issues #12201 and #16880), so the schema can't catch these
 * at decode time. Post-validation + targeted corrective is the only
 * reliable approach.
 */
function buildCorrectiveMessage(issues) {
    if (issues.includes('zero tasks')) {
        return (`Your previous response had: ${issues}.\n\n` +
            `You returned an empty implementationTasks array. This is INVALID. ` +
            `You MUST produce AT LEAST ONE task. Do not return an empty array under any circumstances.\n\n` +
            `If the user's request is "create a website" or similar broad scaffolding, START with bootstrapping tasks: ` +
            `one task to create package.json with the dependencies, one task to create tsconfig.json, ` +
            `one task to create src/index.tsx (entry point), one task to create src/App.tsx, etc. Each gets ` +
            `its own task object with concrete step, file, and detailedInstructions.\n\n` +
            `If the request is to modify existing code, identify the SINGLE most important file to change ` +
            `and produce one well-scoped task targeting it.\n\n` +
            `Re-emit the entire JSON. Make sure implementationTasks contains at least one fully-populated task object.`);
    }
    if (issues.includes('no implementationTasks array')) {
        return (`Your previous response had: ${issues}.\n\n` +
            `The "plan" object MUST contain an "implementationTasks" array. ` +
            `Re-emit the entire JSON with a properly-shaped plan object: ` +
            `{ "folderStructure": [...], "implementationTasks": [ {...}, {...} ] }.`);
    }
    // Field-level failure — the original generic message.
    return (`Your previous response had a structural problem: ${issues}.\n\n` +
        `Every task MUST have non-empty values for "step", "file", and "detailedInstructions". ` +
        `Do not return placeholder strings, single spaces, or empty strings for these fields. ` +
        `Each task should describe a concrete file-creation or code-editing action with a real target path.`);
}
async function generatePlan(prompt, projectContext, scaffoldHint) {
    // Hotfix (post-2B audit): generatePlan was using `aiPlanSchema` /
    // `implementationTaskSchema` which has fields `{id, description,
    // targetFile, instructions}`. The webview (App.tsx) reads
    // `taskObj.step`, `taskObj.file`, `taskObj.detailedInstructions` —
    // i.e., the ProjectTask shape used by `generateTasks`. The two
    // didn't match, so EVERY plan produced via Vibe-mode chat (this
    // function) rendered with blank task titles in the UI.
    //
    // The right fix is to align the schemas: this function and
    // `generateTasks` should both produce the same shape because the
    // webview is the same. We unify on the ProjectTask shape (the
    // richer one — `generateTasks` already uses it for the Master
    // Implementation Plan flow). The legacy field names are gone;
    // there's no consumer for them anymore.
    //
    // We also reuse the same `validateTasksPlan` post-validation +
    // one-shot retry pattern as `generateTasks` so empty fields can't
    // slip through here either.
    const scaffoldGuidance = scaffoldHint
        ? `

GREENFIELD PROJECT — SCAFFOLDING REQUIRED:
You are working in an empty (or near-empty) workspace. The user wants a NEW project, not edits to an existing one. Detection confidence: ${scaffoldHint.confidence}${scaffoldHint.stackHint ? `, stack hint: ${scaffoldHint.stackHint}` : ''}.

Your FIRST task in implementationTasks MUST be a scaffolding task. Two options:

OPTION A — Use a shipped template (PREFERRED when one fits):
${scaffoldHint.availableTemplates.length === 0
            ? '   No shipped templates match this stack. Use Option B.'
            : `Available templates (pick the best match):
${scaffoldHint.availableTemplates.map(t => `   - id: "${t.id}" — ${t.displayName} (${t.description}) — tags: [${t.stackTags.join(', ')}]`).join('\n')}

If one template fits the user's request, emit task[0] like this:
   {
     "kind": "scaffold-template",
     "templateId": "<one of the ids above>",
     "step": "Scaffold project from <displayName>",
     "file": "(scaffold)",
     "detailedInstructions": "Apply the <templateId> template — package.json, tsconfig, src/ skeleton, etc.",
     "relatedRequirement": "Project bootstrap",
     "dependencies": [],
     "verificationRules": ["package.json exists", "src/ directory exists"],
     "testStrategy": "Verify scaffold files written and project compiles."
   }`}

OPTION B — LLM-driven scaffolding (when no template fits):
Emit task[0] like this:
   {
     "kind": "scaffold-llm",
     "step": "Scaffold <stack-name> project from scratch",
     "file": "(scaffold)",
     "detailedInstructions": "Create the boilerplate for a <stack> project: <enumerate exact files needed, e.g. Cargo.toml, src/main.rs for Rust>. Include sensible defaults for build config and a 'hello world' entry point.",
     "relatedRequirement": "Project bootstrap",
     "dependencies": [],
     "verificationRules": ["<verify files exist>", "<verify project compiles/runs>"],
     "testStrategy": "Run <stack-specific> build/test command to verify."
   }

After the scaffold task, emit code tasks for the user's actual feature request. List the scaffold task's "step" in their dependencies array so they wait for it.`
        : '';
    const systemPrompt = `You are the Coordinator Agent (Lead Architect).
Your job is to analyze the user's request and the EXISTING DIRECTORY STRUCTURE, then break it down into atomic tasks.
YOU DO NOT WRITE THE FINAL CODE. You only generate the blueprint for the Coder Agent.

Return JSON matching this exact shape:
{
  "explanation": "1-2 sentence summary of the architectural approach",
  "plan": {
    "folderStructure": ["src/index.ts", "src/components/Header.tsx"],
    "implementationTasks": [
      {
        "step": "Add booking tab to navigation",
        "file": "src/components/Navigation.tsx",
        "detailedInstructions": "Insert a new <Tab> component after the existing tabs, route it to /booking, and use the existing styling tokens.",
        "relatedRequirement": "Booking flow",
        "dependencies": [],
        "verificationRules": ["Tab renders without error", "Click navigates to /booking"],
        "testStrategy": "Render the navigation, click the new tab, assert URL changes."
      }
    ]
  }
}

CRITICAL RULES:
- ADAPT to the existing folder structure. Do not invent new paradigms.
- ATOMIC TASKS: Break down "implementationTasks" so EACH task targets ONE file.
- Every task MUST have non-empty values for "step", "file", and "detailedInstructions".
- "implementationTasks" MUST contain AT LEAST ONE task. NEVER return an empty array. If you are unsure how to break the request down, produce one well-scoped task targeting the most important file.
- For new projects (empty directory tree), START with bootstrapping tasks: package.json, tsconfig.json, src/index.tsx, src/App.tsx, etc. Each as a separate task.${scaffoldGuidance}`;
    const baseMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `EXISTING DIRECTORY STRUCTURE:\n${projectContext}\n\nUSER REQUEST: ${prompt}` }
    ];
    // We build a fresh JSON-schema envelope here that wraps
    // `tasksPlanSchema`'s shape (the ProjectTask shape). Inline rather
    // than adding a new exported schema because this is the only call
    // site for it and pulling it into jsonSchemas.ts would require
    // touching that file too. The legacy `planEnvelopeSchema` (which
    // wrapped the OLD task shape) is no longer referenced anywhere.
    const planEnvelopeWithTasksShape = {
        name: 'plan_envelope_v2',
        strict: false,
        schema: {
            type: 'object',
            properties: {
                explanation: { type: 'string' },
                plan: jsonSchemas_1.tasksPlanSchema.schema
            },
            required: ['explanation', 'plan']
        }
    };
    let result = await (0, jsonRequest_1.jsonRequestData)({
        messages: baseMessages,
        schema: planEnvelopeWithTasksShape,
        temperature: 0.1
    });
    let plan = result.plan || { folderStructure: [], implementationTasks: [] };
    let issues = validateTasksPlan(plan);
    if (issues) {
        // Same retry pattern as generateTasks — append a corrective
        // system message that names the failure and try once more.
        // No infinite retries; the user gets a clear error if both
        // attempts fail.
        //
        // Hotfix (post-2B): the corrective message is now tailored to
        // the failure pattern. "Zero tasks" gets a very different
        // corrective from "field is empty" — see buildCorrectiveMessage.
        const correctiveMessages = [
            ...baseMessages,
            {
                role: 'system',
                content: buildCorrectiveMessage(issues)
            }
        ];
        result = await (0, jsonRequest_1.jsonRequestData)({
            messages: correctiveMessages,
            schema: planEnvelopeWithTasksShape,
            temperature: 0.1
        });
        plan = result.plan || { folderStructure: [], implementationTasks: [] };
        issues = validateTasksPlan(plan);
        if (issues) {
            throw new Error(`Implementation plan generation failed validation after retry: ${issues}. ` +
                `This usually means the model endpoint is having trouble with the structured-output ` +
                `format. Try regenerating the plan, or check the model/endpoint configuration.`);
        }
    }
    return {
        explanation: result.explanation || "Here is the implementation plan:",
        plan
    };
}
async function inferTargetFile(taskDescription, projectContext, lastActiveFile) {
    const contextHint = lastActiveFile ? `CONTEXT: You just modified "${lastActiveFile}". Unless explicitly mentioned, MUST continue working on "${lastActiveFile}".` : "";
    const systemPrompt = `You are a Senior Software Architect. Analyze the directory and the task.
    Decide exactly ONE file that needs to be reviewed, modified, or created.
    ${contextHint}
    Return ONLY valid JSON: { "filepath": "src/file.ts", "reasoning": "..." }`;
    return (0, jsonRequest_1.jsonRequestData)({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Directory:\n${projectContext}\n\nTask: ${taskDescription}` }
        ],
        schema: jsonSchemas_1.targetFileSchema,
        temperature: 0.1
    });
}
async function generateTests(fileName, fileContent, projectRules = "") {
    const systemPrompt = `You are an expert QA Engineer. Generate a comprehensive pure unit test file.
    
    ${projectRules ? `🔥 STRICT CUSTOM PROJECT RULES 🔥\n${projectRules}\n\n` : ''}
    
    🔥 DIRECTORY RULES:
    You MUST place the test file in a dedicated 'tests/' directory at the root of the project, mirroring the original path. 
    For example: 
    - If source is 'src/routes/auth.ts', filepath MUST be 'tests/routes/auth.test.ts'

    EXECUTION & SYNTAX RULES (CRITICAL):
    1. DYNAMIC FRAMEWORK: You must use the industry-standard test framework for the target file's language:
       - .ts / .js -> Jest (Command: "npx jest --preset ts-jest")
       - .py -> PyTest (Command: "pytest")
       - .go -> Go Test (Command: "go test ./...")
       - .rs -> Cargo (Command: "cargo test")
    2. TYPESCRIPT/JEST SPECIFIC: If using Jest, you MUST import globals: import { describe, it, expect, jest } from '@jest/globals';
    3. STRICT UNIT TESTING: You are strictly forbidden from establishing database connections. Do not import or start any memory servers.
    4. MONGOOSE SCHEMA TESTING: Test schema validation synchronously using \`const err = new Model(data).validateSync();\`.
    5. THE UNIQUE CONSTRAINT RULE: validateSync() CANNOT test "unique" constraints because uniqueness requires a database. DO NOT write tests for unique emails or usernames.
    6. TYPESCRIPT STRICT MODE SAFEGUARDS: 
       - \`validateSync()\` can return null. ALWAYS use optional chaining (e.g., \`expect(err?.errors?.username).toBeDefined();\`) to avoid TS18047 "possibly null" errors.
       - NEVER access deep Mongoose properties like \`.properties.message\` on errors. Just assert the field error exists: \`expect(err?.errors?.email).toBeDefined();\`.
    
    Return valid JSON matching: { "language": "...", "framework": "...", "testFilePath": "...", "testCode": "...", "setupCommands": ["..."] }`;
    return (0, jsonRequest_1.jsonRequestData)({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Target: ${fileName}\n\n\`\`\`\n${fileContent}\n\`\`\`` }
        ],
        schema: jsonSchemas_1.testSetupSchema,
        temperature: 0.1
    });
}
async function healError(errorOutput, sourceFilePath, sourceCode, testFilePath, testCode) {
    const systemPrompt = `You are an expert debugger. Determine if the error is in the source code OR the test code. Fix ONLY the file causing the error.
    Return JSON: { "filepath": "<path>", "code": "<full file content>" }
    The "code" field must contain the COMPLETE file content, not a diff. Use \\n for line breaks inside the JSON string.`;
    const userPrompt = `Source: ${sourceFilePath}\n\`\`\`\n${sourceCode}\n\`\`\`\nTest: ${testFilePath}\n\`\`\`\n${testCode}\n\`\`\`\nError:\n\`\`\`\n${errorOutput}\n\`\`\``;
    const result = await (0, jsonRequest_1.jsonRequestData)({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        schema: jsonSchemas_1.healErrorSchema,
        temperature: 0.1
    });
    // Strip markdown fences the model may have wrapped around the code
    const extractedCode = decodeHTMLEntities(result.code.trim()).replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
    return { filepath: result.filepath.trim(), code: extractedCode };
}
async function generateAtomicEdits(tasks, projectContext, _codingStyle) {
    const systemPrompt = `Return JSON: { "edits": [{ "filepath": "...", "code": "...", "action": "replace" }] }`;
    const result = await (0, jsonRequest_1.jsonRequestData)({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Tasks: ${tasks.join(', ')}\n\nContext:\n${projectContext}` }
        ],
        schema: jsonSchemas_1.atomicEditsSchema,
        temperature: 0.1
    });
    return result.edits;
}
async function getAvailableModels() {
    // Use deps.config so this works in both IDE and CLI runtimes. The
    // CLI uses CliConfigSource (env/flags/cli.json); the IDE uses
    // VSCodeConfigSource (vscode.workspace.getConfiguration).
    const fixedModel = (0, container_1.getDeps)().config.get('model') || DEFAULT_MODEL;
    return [fixedModel];
}
/**
 * V2.1.2 spec-redesign-fix: strip the "Here's a thinking process:" /
 * "Let me analyze this..." prose preamble that Qwen 3.6 27B emits before
 * the actual structured response. The model is in reasoning mode and
 * sometimes writes its scratch work into the content channel rather than
 * the reasoning channel — when that happens, the preamble lands in the
 * saved spec file and the user sees pages of "1. Analyze User Input..."
 * before any real content.
 *
 * Heuristic: find the first occurrence of the genuine content start —
 * a YAML frontmatter `---` opener, a top-level markdown heading (`# `),
 * or the first XML structural tag the prompt asked for. Strip everything
 * before that marker. If no marker is found, return the input unchanged
 * (legitimate plain-prose responses aren't ours to truncate).
 *
 * Conservative by design: false negatives (preamble survives) are
 * cosmetic; false positives (real content stripped) corrupt the spec.
 * We only strip when we can clearly identify the structural start.
 *
 * Pure function for testability — no I/O.
 */
function stripThinkingPreamble(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }
    // Markers we look for, in priority order. Each must be at line start
    // (`^` plus newline-handling) so we don't false-match inside prose.
    // Order matters when multiple markers exist; we want the EARLIEST one.
    const markers = [
        /(^|\n)---\n/, // YAML frontmatter
        /(^|\n)# [A-Z]/, // Top-level markdown heading
        /(^|\n)<architecture_components>/i, // Design XML markers
        /(^|\n)<data_models>/i,
        /(^|\n)<er_diagram>/i,
        /(^|\n)<business_interaction>/i,
        /(^|\n)<api_routes>/i,
        /(^|\n)<tasks>/i, // Tasks XML
        /(^|\n)<task /i,
        /(^|\n)<epic /i, // Requirements XML
        /(^|\n)<story /i,
    ];
    let earliestMatch = -1;
    let earliestMatchPrefix = 0; // length of the leading newline we matched
    for (const re of markers) {
        const m = re.exec(text);
        if (m && m.index !== undefined) {
            // m.index points to the start of the match (the optional newline);
            // the actual content starts after the leading newline (if any).
            const prefixLen = m[1] === '\n' ? 1 : 0;
            const contentStart = m.index + prefixLen;
            if (earliestMatch === -1 || contentStart < earliestMatch) {
                earliestMatch = contentStart;
                earliestMatchPrefix = prefixLen;
            }
        }
    }
    // No structural marker found — return unchanged. Better to leave a
    // noisy spec than to mangle a clean one.
    if (earliestMatch === -1) {
        return text;
    }
    // Sanity check: if the marker is at position 0, there's nothing to
    // strip. Don't bother allocating a substring.
    if (earliestMatch === 0) {
        return text;
    }
    // Sanity check 2: if the "preamble" we'd strip is shorter than 50
    // chars, it's probably whitespace or a brief note — not a thinking
    // trace. Leave it alone to avoid eating actual content.
    if (earliestMatch < 50) {
        return text;
    }
    return text.substring(earliestMatch);
    // (earliestMatchPrefix is captured for symmetry but unused — we
    // already include the marker in the substring start position.)
    void earliestMatchPrefix;
}
async function generateDesign(requirements, abortSignal) {
    const systemPrompt = `You are an elite FAANG Software Architect.
Analyze the provided PRD and design a highly scalable System Architecture.

CRITICAL INSTRUCTION - AGENT-NATIVE FORMATTING:
You must wrap your top-level sections in XML structural tags so that other AI agents can parse it deterministically.
Use YAML frontmatter at the very top.

Follow this exact format:
---
version: 1.0.0
type: architecture_design
---

# System Architecture

<architecture_components>
## Core Components
(Use standard Markdown to detail your frontend, backend, and database layers)
</architecture_components>

<data_models>
## Data Models
(CRITICAL: Use Markdown tables to define schemas. You MUST use proper newlines (\n) for every single row in the table. DO NOT output the table on a single continuous line. DO NOT use nested XML tags like <field> for properties.
Example:
### User Model
| Field | Type | Description |
|---|---|---|
| id | UUID | Unique ID |
)
</data_models>

<er_diagram>
## Entity-Relationship (ER) Diagram
(Use Mermaid.js \`erDiagram\` syntax to map out the database relations. Wrap it in a \`\`\`mermaid code block.

VALID erDiagram skeleton — follow this exact shape:
\`\`\`mermaid
erDiagram
    USER ||--o{ ORDER : places
    USER {
        uuid id PK
        string email
    }
    ORDER {
        uuid id PK
        uuid user_id FK
    }
\`\`\`
Cardinality symbols: ||--o{ (one to many), ||--|| (one to one), }o--o{ (many to many).
NO flowchart arrows. NO comments inside attribute lists.)
</er_diagram>

<business_interaction>
## Business Interaction Flow
(Use Mermaid.js \`sequenceDiagram\` syntax to show the core business logic and system interactions. Wrap it in a \`\`\`mermaid code block.

VALID sequenceDiagram skeleton — follow this exact shape:
\`\`\`mermaid
sequenceDiagram
    participant User
    participant API
    participant DB
    User->>API: POST /book
    API->>DB: INSERT booking
    DB-->>API: ok
    alt Recurrence requested
        API->>DB: INSERT recurrence_rule
        DB-->>API: ok
    else One-off booking
        Note over API: skip recurrence
    end
    API-->>User: 201 Created
\`\`\`

CRITICAL syntax rules — these are the common parse errors:
1. \`alt\` / \`else\` / \`end\` MUST appear as a triplet. Every \`else\` requires a preceding \`alt\` on its own line. Every \`alt\` block must be closed with \`end\`.
2. Lines inside alt/else blocks MUST be valid sequenceDiagram statements (participant references, arrows like ->>, -->>, or \`Note over X: text\`).
3. Use sequenceDiagram arrows ONLY: ->> (sync), -->> (return), -x (failure). Do NOT use flowchart arrows (-> or -->) — they'll cause parse errors.
4. \`participant Name\` declarations go at the top, before any arrows.
5. Indent consistently (4 spaces). Mermaid is whitespace-sensitive in some contexts.)
</business_interaction>

<api_routes>
## API Specs
(Use standard Markdown lists or tables to describe routes. DO NOT use <request> or <param> XML tags.)
</api_routes>`;
    // Migrated to Provider abstraction (Component 1, Session 2). Note:
    // the original code set `response_format: { type: "json_object" }`
    // despite the system prompt asking for markdown wrapped in XML tags
    // — same bug pattern as streamChat in Session 1. The Provider's
    // Per-agent routing: design generation is planner-like reasoning
    // work (analyzing requirements + producing structured architectural
    // output). Routes to `nexuscode.modelPlanner` when configured,
    // falls back to global `nexuscode.model` when unset.
    const provider = await (0, llm_1.getProvider)('planner');
    const completionOptions = {
        temperature: 0.2
    };
    if (abortSignal) {
        completionOptions.signal = abortSignal;
    }
    const fullDesign = await provider.completion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Requirements:\n${requirements}` }
    ], completionOptions);
    return stripThinkingPreamble(fullDesign.trim());
}
async function generateTasks(requirements, design, existingStructure, abortSignal, 
/** P1.2: project-specific steering rules injected into the planner's
 *  context. When non-empty, the planner sees this AFTER its
 *  generic engineering rules so steering can ADD constraints
 *  (e.g. "always use Result<T,E> instead of throw") without
 *  overriding the core planning behavior.
 *
 *  Build this via SteeringManager.buildSteeringPromptBlock(). Pass
 *  empty string when steering should be ignored (CLI flag, test
 *  fixtures, etc.). */
steeringBlock = '') {
    const systemPrompt = `You are the Principal Orchestrator Agent.
    The user has provided a PRD, a Technical Design Document, and the existing Directory Structure.
    YOU DO NOT WRITE CODE. Break the project down into an actionable, exhaustive implementation plan.
    
     CRITICAL ENGINEERING RULES 
    1. TOPOLOGICAL SORTING: You MUST order tasks logically. DB Models -> API Routes -> UI Components.
    2. ATOMIC FILES: Each task MUST target exactly ONE primary 'file'.
    3. EXISTING CONTEXT: Map tasks to the provided EXISTING DIRECTORY STRUCTURE.
    4. NO METADATA TASKS: DO NOT create tasks for "reviewing", "testing", "debugging", or "verifying". Our Swarm Engine handles QA automatically in the background. ONLY output concrete file-creation or code-editing tasks.
    5. NEVER RETURN AN EMPTY TASK LIST. "implementationTasks" MUST contain AT LEAST ONE task. If the PRD scope is small, produce one well-scoped task. If the directory is empty (new project), START with bootstrapping tasks: package.json, tsconfig.json, src/index.tsx, src/App.tsx, etc. Each as a separate task.
    6. EVERY TASK MUST HAVE NON-EMPTY VALUES for "step", "file", and "detailedInstructions". Empty strings are INVALID.
    
    Return ONLY valid JSON matching this exact schema:
    {
      "folderStructure": ["src/index.ts", "src/models/user.ts"],
      "implementationTasks": [
        {
          "step": "Define User Model",
          "file": "src/models/user.ts",
          "detailedInstructions": "Export a Mongoose schema matching the Design Doc Interface. Do not write the API yet.",
          "relatedRequirement": "Epic: Authentication",
          "dependencies": [],
          "verificationRules": ["Must export 'User'", "Must contain email field"],
          "testStrategy": "Write a unit test verifying the schema validates a correct email and rejects an invalid one."
        }
      ]
    }`;
    // HOTFIX (post-Component 1 Session 2): regression where the Master
    // Implementation Plan rendered with empty task titles and file paths.
    //
    // Root cause: Session 2 dropped `response_format: { type: "json_object" }`
    // from this call, expecting `safeParseJSON` to tolerate any model output.
    // It did parse successfully — but the model, freed from JSON-mode
    // constraints, drifted to producing JSON whose `step` and `file` fields
    // came back as empty strings (likely the model wrapped its real output
    // in an unexpected envelope or flattened the wrong path).
    //
    // The fix: route through `provider.jsonCompletion(messages, schema)` which
    // uses `response_format: { type: "json_schema" }` mode (stricter than
    // json_object). The endpoint constrains decode-time output so the field
    // names and types literally match the schema. This is the long-term
    // correct shape — `jsonCompletion` is the Provider method designed for
    // structured-output use cases. No part of this is a temporary band-aid.
    //
    // The old flow (provider.completion + manual JSON extraction +
    // safeParseJSON) is GONE — it's not needed when the schema is enforced
    // at decode time. Same with the special-case handling for tasks that
    // came back as plain strings (the schema rules that out — items must
    // be objects with `step`, `file`, `detailedInstructions`).
    //
    // POST-2B HOTFIX: schema-level constraint enforcement is unreliable on
    // the customer's vLLM endpoint (xgrammar backend doesn't honor
    // minLength/string-non-empty constraints — see vLLM structured-output
    // docs). The model can therefore return tasks with `step: ""`,
    // `file: ""`, `detailedInstructions: ""` that pass schema validation
    // but produce empty cards in the UI. We post-validate and, on
    // failure, retry once with a corrective system message that points
    // Per-agent routing: task generation reads the design and produces
    // a structured plan. Same reasoning category as generateDesign —
    // routes via 'planner' role.
    const provider = await (0, llm_1.getProvider)('planner');
    const completionOptions = {
        temperature: 0.1
    };
    if (abortSignal) {
        completionOptions.signal = abortSignal;
    }
    const baseMessages = steeringBlock
        ? [
            { role: 'system', content: systemPrompt },
            // P1.2: steering as a second system message — placed AFTER
            // the planner's engineering rules so steering ADDS
            // constraints rather than overriding the core planning
            // behavior. The header inside steeringBlock makes its
            // role explicit ("# Steering: project conventions") so
            // the model treats it as authoritative on what to apply,
            // not on how to plan.
            { role: 'system', content: steeringBlock },
            { role: 'user', content: `EXISTING STRUCTURE:\n${existingStructure}\n\nPRD:\n${requirements}\n\nDESIGN:\n${design}` }
        ]
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `EXISTING STRUCTURE:\n${existingStructure}\n\nPRD:\n${requirements}\n\nDESIGN:\n${design}` }
        ];
    let parsedPlan = await provider.jsonCompletion(baseMessages, jsonSchemas_1.tasksPlanSchema, completionOptions);
    let issues = validateTasksPlan(parsedPlan);
    if (issues) {
        // First attempt failed validation. Retry ONCE with a corrective
        // system message that surfaces the exact failure. We don't retry
        // indefinitely — the customer endpoint's pricing isn't free and
        // a deterministic-temperature model that fails twice is very
        // unlikely to succeed on attempt 3. One retry catches the
        // "model got confused once" case; persistent failure surfaces
        // to the user.
        //
        // Hotfix (post-2B): corrective message is now tailored to the
        // failure pattern (zero-tasks vs empty-fields vs missing-array).
        // See buildCorrectiveMessage for the branching logic.
        const correctiveMessages = [
            ...baseMessages,
            {
                role: 'system',
                content: buildCorrectiveMessage(issues)
            }
        ];
        parsedPlan = await provider.jsonCompletion(correctiveMessages, jsonSchemas_1.tasksPlanSchema, completionOptions);
        issues = validateTasksPlan(parsedPlan);
        if (issues) {
            throw new Error(`Implementation plan generation failed validation after retry: ${issues}. ` +
                `This usually means the model endpoint is having trouble with the structured-output ` +
                `format. Try regenerating the plan, or check the model/endpoint configuration.`);
        }
    }
    return parsedPlan;
}
async function verifyAgainstSpec(techSpec, taskQuery, fileContent) {
    // 🚀 THE FIX: Titanium-clad QA Prompting
    const systemPrompt = `You are an elite, ruthlessly objective Enterprise QA Verifier.
Your ONLY job is to verify if the provided code satisfies the Technical Spec.

CRITICAL RULES:
1. STRICT ADHERENCE: You must evaluate the code strictly against the Technical Spec. Do NOT invent new business rules, best practices, or personal preferences.
2. NO CONTRADICTIONS: If the spec requires a String, accept a String. If it requires a Date, accept a Date. 
3. MONGOOSE TOLERANCE: Mongoose typing can be tricky. Accept valid variations (e.g., 'mongoose.Schema.Types.UUID', 'String' if UUID is represented as string, 'mongoose.Types.Decimal128').
4. PASS CONDITIONS: If the code is syntactically valid and meets the explicit core requirements of the Spec, YOU MUST PASS IT. Do not reject code for minor stylistic choices.

Output ONLY a JSON object in this exact format:
{
  "verified": boolean,
  "reasoning": "A concise explanation of why it passed or failed. If failed, give exact actionable steps."
}`;
    const userPrompt = `--- TECHNICAL SPEC ---
${techSpec}

--- TARGET TASK ---
${taskQuery}

--- PROPOSED CODE ---
\`\`\`
${fileContent}
\`\`\`

Evaluate the code and return the JSON.`;
    try {
        const result = await (0, jsonRequest_1.jsonRequest)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            schema: jsonSchemas_1.verificationSchema,
            // Per-agent routing: verifier uses 'verifier' role so the
            // QA-review LLM call can be routed independently of the
            // Coder. Falls back to global default when
            // `nexuscode.modelVerifier` is unset.
            role: 'verifier',
            temperature: 0.0
        });
        return { ...result.data, usage: result.usage };
    }
    catch (error) {
        return { verified: false, reasoning: `System QA Error: ${(0, errors_1.errorMessage)(error)}` };
    }
}
//  ENHANCEMENT A: The Living PRD QA Agent
async function updateLivingPRD(prdContext, taskDescription, filepath, newCode) {
    const systemPrompt = `You are an elite QA Agent maintaining a "Living PRD".
    The developer just completed a task. You must read the new code and the PRD.
    Identify if ANY "- [ ]" Acceptance Criteria or Requirements were fulfilled by this specific code.
    
    Return ONLY valid JSON containing an array of string replacements.
    You must match the original string EXACTLY so it can be replaced in the Markdown file.
    
    Schema:
    {
        "replacements": [
            {
                "original": "- [ ] Must validate email format",
                "updated": "- [x] Must validate email format (Completed in src/routes/auth.ts)"
            }
        ]
    }
    
    CRITICAL: If the code does NOT fully satisfy a criteria, do not include it. Return an empty array [] if nothing was fully completed.`;
    try {
        const result = await (0, jsonRequest_1.jsonRequestData)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `TASK:\n${taskDescription}\n\nFILE: ${filepath}\n\nNEW CODE:\n\`\`\`\n${newCode.substring(0, 10000)}\n\`\`\`\n\nCURRENT PRD:\n${prdContext}` }
            ],
            schema: jsonSchemas_1.livingPrdUpdateSchema,
            temperature: 0.1
        });
        return result.replacements || [];
    }
    catch (e) {
        logger_1.log.warn("[DEBUG] QA Agent failed to parse PRD updates.");
        return [];
    }
}
//  PILLAR 3: The Completeness Reviewer
async function reviewCodeCompleteness(taskDescription, prdContext, generatedCode) {
    const systemPrompt = `You are a ruthless Principal Software Engineer. Your job is to review code written by a Junior AI.
    You are checking for FUNCTIONAL COMPLETENESS. 
    
    You MUST REJECT the code (isComplete: false) if:
    1. It contains lazy placeholders like "// TODO", "// Add logic here", or returning empty objects/nulls where real logic belongs.
    2. It fails to implement the specific requirements requested in the Task Description.
    3. It imports internal files/functions that obviously don't exist yet without providing mock data.
    
    If the code is 100% complete and ready for production, set isComplete to true.
    
    Return ONLY valid JSON matching this schema:
    {
        "isComplete": false,
        "critique": "Line 42 has a // TODO comment. You failed to implement the Stripe API call. Rewrite the entire file and implement the API call."
    }`;
    const userPrompt = `TASK:\n${taskDescription}\n\nPRD CONTEXT:\n${prdContext}\n\nGENERATED CODE TO REVIEW:\n\`\`\`\n${generatedCode}\n\`\`\``;
    try {
        return await (0, jsonRequest_1.jsonRequestData)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            schema: jsonSchemas_1.completenessReviewSchema,
            temperature: 0.1
        });
    }
    catch (e) {
        logger_1.log.warn("[DEBUG] Completeness Reviewer failed, bypassing to avoid blockage.");
        return { isComplete: true, critique: "" }; // Bypass if the reviewer itself crashes
    }
}
//  STEP 4: The Global Build-Healer Agent
async function healGlobalBuild(buildErrors, filesContext, _codingStyle) {
    const systemPrompt = `You are an elite Principal DevOps Engineer. The global project build just failed.
    You will be provided with the raw compiler error log and the contents of the files mentioned in the errors.
    
    Your job is to fix the cross-file mismatches, phantom imports, and type errors.
    
    Return JSON: { "edits": [ { "filepath": "src/routes/auth.ts", "code": "...", "action": "replace" } ] }

     CRITICAL RULES:
    1. Only fix the exact lines causing the compilation errors.
    2. Output the FULL file content for the "replace" action so we don't lose any existing logic.
    3. Do NOT output markdown outside of the JSON.`;
    const userPrompt = `COMPILER ERRORS:\n\`\`\`\n${buildErrors}\n\`\`\`\n\nBROKEN FILES CONTEXT:\n${filesContext}`;
    try {
        const result = await (0, jsonRequest_1.jsonRequestData)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            schema: jsonSchemas_1.atomicEditsSchema,
            temperature: 0.1
        });
        return result.edits || [];
    }
    catch (e) {
        logger_1.log.error("[DEBUG] Build-Healer failed to parse response.");
        return [];
    }
}
//  PHASE 4: ZERO-TRUST SECURITY FIREWALL
//
// Two entry points:
//   - askSecurityMonitor: legacy boolean contract (true = block).
//     Catches all errors and fails CLOSED. Stable public API used by
//     pre-existing callers and tests.
//   - askSecurityMonitorVerbose: returns a discriminated verdict
//     ({ kind: 'allow' } | { kind: 'deny'; reason: string }) and
//     PROPAGATES errors. Used by the security hook's actionable-banner
//     path (M-8) — letting infra failures throw lets the caller
//     distinguish "monitor said no" from "monitor crashed", which
//     drives different UX (block-pill vs retry-banner).
//
// Both functions share the same prompt + schema. askSecurityMonitor is
// a thin error-swallowing wrapper around askSecurityMonitorVerbose to
// keep the LLM call defined exactly once.
const SECURITY_MONITOR_SYSTEM_PROMPT = `You are an elite Security Monitor for an autonomous coding agent.
    Your ONLY job is to evaluate bash/terminal commands before they are executed.

    THREAT MODEL:
    - Irreversible local destruction (e.g., rm -rf /, wiping databases).
    - Credential exfiltration (e.g., curl sending ~/.aws/credentials to a random IP).
    - Blind Git Applies (e.g., git push --force without review).

    Standard dev commands (npm install, mkdir, touch, tsc, git status) are SAFE.

    Return JSON: { "allowed": true|false, "reason": "<one-sentence justification>" }
    Set "allowed" to false to BLOCK the command, true to ALLOW.`;
/**
 * Verbose-verdict version of the security monitor. Throws on
 * infrastructure failure (LLM provider crash, malformed response,
 * timeout). Returns a discriminated union on success.
 *
 * Callers should wrap in try/catch; thrown errors mean "monitor
 * unreachable" not "monitor declined". The securityHook factory uses
 * this distinction to render the M-8 actionable banner.
 */
async function askSecurityMonitorVerbose(command) {
    const result = await (0, jsonRequest_1.jsonRequestData)({
        messages: [
            { role: "system", content: SECURITY_MONITOR_SYSTEM_PROMPT },
            { role: "user", content: `Command to evaluate: ${command}` }
        ],
        schema: jsonSchemas_1.securityDecisionSchema,
        temperature: 0.0
    });
    if (result.allowed) {
        return { kind: 'allow' };
    }
    return {
        kind: 'deny',
        reason: typeof result.reason === 'string' && result.reason.trim()
            ? result.reason
            : 'Security Monitor declined the command.'
    };
}
/**
 * Legacy boolean contract. Returns true to BLOCK, false to ALLOW.
 * Fails closed: any error (provider down, malformed response) returns
 * true so the command is blocked. Stable public API — do not change
 * the signature without updating call sites.
 */
async function askSecurityMonitor(command) {
    try {
        const verdict = await askSecurityMonitorVerbose(command);
        return verdict.kind === 'deny'; // true means block
    }
    catch (e) {
        return true; // Fail-safe: monitor crash = block.
    }
}
//  PHASE 4: ADVERSARIAL VERIFICATION SPECIALIST
async function generateAdversarialTest(task, filepath, code) {
    const systemPrompt = `You are a hostile Verification Specialist. You do not trust the Coder Agent.
    Your job is to write a temporary Node.js script to aggressively test the code they just wrote.
    Do NOT just test the "happy path". Test edge cases, null inputs, and boundaries.
    
    Return ONLY a raw JavaScript script that can be executed via 'node'. 
    If the tests pass, the script MUST log.info("VERIFICATION_PASSED").
    If they fail, it MUST throw an Error.`;
    // Migrated to Provider abstraction (Component 1, Session 2).
    // Per-agent routing: adversarial test generation is verifier-class
    // work — same category as verifyAgainstSpec (QA-side LLM call,
    // tolerant of smaller/faster models for cost optimization). Routes
    // to 'verifier' role.
    const provider = await (0, llm_1.getProvider)('verifier');
    const script = await provider.completion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Task: ${task}\nFile: ${filepath}\nCode:\n\`\`\`\n${code}\n\`\`\`` }
    ], { temperature: 0.1 });
    return script.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
}
//  PHASE 2: THE COMPACTOR DAEMON
async function compactConversationHistory(messages) {
    const systemPrompt = `You are a background Context Compactor AI. 
    Your ONLY job is to read a long conversation history and summarize it into a highly dense, structured memory block.
    
    You must drop all conversational filler, raw code blocks that are no longer relevant, and apologies.
    Keep the summary under 40 lines.
    
    Return ONLY valid XML matching this structure:
    <memory_state>
        <primary_request>What is the user ultimately trying to achieve?</primary_request>
        <completed_steps>What tasks/files have already been finished?</completed_steps>
        <pending_tasks>What still needs to be done?</pending_tasks>
        <important_discoveries>Hard lessons, bugs caught, or architectural rules discovered</important_discoveries>
    </memory_state>`;
    const formattedHistory = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    // Migrated to Provider abstraction (Component 1, Session 2).
    // Returns XML <memory_state>, not JSON — uses provider.completion().
    const provider = await (0, llm_1.getProvider)();
    const result = await provider.completion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `CONVERSATION TO COMPACT:\n\`\`\`\n${formattedHistory}\n\`\`\`` }
    ], { temperature: 0.1 });
    return result.trim();
}
//  PHASE 4: MONTE CARLO TREE SEARCH (MCTS) PLANNER
async function generateMCTSApproaches(task, context) {
    const systemPrompt = `You are a Principal Software Architect. 
    The user has requested a feature/fix. Instead of providing one solution, you must provide THREE distinctly different implementation approaches.
    
    Approach A: The most straightforward, standard enterprise implementation.
    Approach B: A defensive, highly-robust approach prioritizing safety and error handling.
    Approach C: A creative, highly-optimized, or alternative pattern approach.
    
    Return EXACTLY valid JSON matching this schema:
    {
      "approaches": [
        "Description of Approach A and exactly what logic to write...",
        "Description of Approach B and exactly what logic to write...",
        "Description of Approach C and exactly what logic to write..."
      ]
    }`;
    try {
        const result = await (0, jsonRequest_1.jsonRequestData)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Task: ${task}\n\nContext:\n${context}` }
            ],
            schema: jsonSchemas_1.mctsApproachesSchema,
            temperature: 0.4
        });
        return result.approaches || [task];
    }
    catch (e) {
        return [task]; // Fallback to standard single execution if JSON fails
    }
}
//# sourceMappingURL=llmService.js.map