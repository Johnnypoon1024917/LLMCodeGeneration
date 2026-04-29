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
exports.resilientFetch = resilientFetch;
exports.getLLMConfig = getLLMConfig;
exports.authHeaders = authHeaders;
exports.safeParseJSON = safeParseJSON;
exports.determineIntent = determineIntent;
exports.streamChat = streamChat;
exports.generateRequirements = generateRequirements;
exports.generatePlan = generatePlan;
exports.inferTargetFile = inferTargetFile;
exports.runAgenticExploration = runAgenticExploration;
exports.generateTests = generateTests;
exports.healError = healError;
exports.generateAtomicEdits = generateAtomicEdits;
exports.getAvailableModels = getAvailableModels;
exports.generateDesign = generateDesign;
exports.generateTasks = generateTasks;
exports.verifyAgainstSpec = verifyAgainstSpec;
exports.updateLivingPRD = updateLivingPRD;
exports.reviewCodeCompleteness = reviewCodeCompleteness;
exports.healGlobalBuild = healGlobalBuild;
exports.askSecurityMonitor = askSecurityMonitor;
exports.generateAdversarialTest = generateAdversarialTest;
exports.compactConversationHistory = compactConversationHistory;
exports.generateMCTSApproaches = generateMCTSApproaches;
// src/llmService.ts
const vscode = __importStar(require("vscode"));
const agentTools_1 = require("./agentTools");
const toolDispatchWithEvents_1 = require("./agents/toolDispatchWithEvents");
const securityHook_1 = require("./agents/securityHook");
// Trigger registration of all tools by importing the barrel.
require("./agents/tools");
const container_1 = require("./container");
const RetryManager_1 = require("./infrastructure/RetryManager");
const RateLimitManager_1 = require("./infrastructure/RateLimitManager");
const errors_1 = require("./utilities/errors");
const jsonRequest_1 = require("./llm/jsonRequest");
const llm_1 = require("./llm");
const jsonSchemas_1 = require("./llm/jsonSchemas");
const logger_1 = require("./logger");
let _apiKeyMigrated = false;
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
        if (logCallback)
            logCallback(msg);
        else
            logger_1.log.warn(msg);
    });
}
async function getLLMConfig() {
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
    return {
        endpoint: config.get('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get('model') || 'qwen2.5-coder',
        apiKey: secureKey || undefined, // <-- no placeholder
        enableTools: config.get('enableTools') ?? true
    };
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
                                    if (ck === undefined || !/[ \n\r\t]/.test(ck))
                                        break;
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
    const userPrompt = `--- GATHERED CODEBASE CONTEXT ---\n${contextStr}\n\n--- USER QUERY ---\n${prompt}`;
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
            temperature: 0.3
        };
        if (abortSignal) {
            completionOptions.signal = abortSignal;
        }
        const stream = await provider.streamCompletion(messages, completionOptions);
        for await (const chunk of stream) {
            onToken(chunk);
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
async function generatePlan(prompt, projectContext) {
    const systemPrompt = `You are the Coordinator Agent (Lead Architect).
    Your job is to analyze the user's request and the EXISTING DIRECTORY STRUCTURE, then break it down into atomic tasks.
    YOU DO NOT WRITE THE FINAL CODE. You only generate the blueprint for the Coder Agent.

    Return JSON with two fields:
      "explanation": a 1-2 sentence summary of the architectural approach
      "plan": { "implementationTasks": [...] }

    CRITICAL RULES:
    - ADAPT to the existing folder structure. Do not invent new paradigms.
    - ATOMIC TASKS: Break down "implementationTasks" so EACH task targets ONE file.

    Example Output:
    {
      "explanation": "We need to add a new Booking tab to the navigation menu.",
      "plan": {
        "implementationTasks": [
          { "id": "TASK-001", "description": "Add booking tab to navigation in public/index.html", "targetFile": "public/index.html" }
        ]
      }
    }`;
    const result = await (0, jsonRequest_1.jsonRequestData)({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `EXISTING DIRECTORY STRUCTURE:\n${projectContext}\n\nUSER REQUEST: ${prompt}` }
        ],
        schema: jsonSchemas_1.planEnvelopeSchema,
        temperature: 0.1
    });
    return {
        explanation: result.explanation || "Here is the implementation plan:",
        plan: result.plan || { implementationTasks: [] }
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
async function runAgenticExploration(taskDescription, projectContext, // 🚀 NEW: Accept the pre-fetched AST
workspaceRoot, statusCallback, abortSignal) {
    // Component 2A migration: switched from inline resilientFetch + manual
    // tool_calls parsing to provider.chatCompletion.
    // Component 2B-3b migration: read_file / list_directory now dispatch
    // through the typed registry (dispatchWithEvents) instead of the
    // legacy executeAgentTool shim. The grep_search / find_file inline
    // implementations stay inline — they have specific hallucination
    // guards and project-tuned exclude patterns that the generic registry
    // tools don't carry. Eventually those could move to registered tools
    // but it's not a 2B-3 concern.
    //
    // The original code also set `response_format: { type: "json_object" }`
    // which was wrong — the model produces tool_calls and READY_TO_CODE
    // text, not JSON. Removed (same fix pattern as Component 1's
    // generateDesign / generateTasks fixes).
    //
    // The `enableTools` short-circuit is removed: the Provider's
    // capability probe handles tool-incapable endpoints transparently.
    const provider = await (0, llm_1.getProvider)();
    const explorePrompt = `You are the Explorer Agent. Your role is EXCLUSIVELY to search and analyze the codebase dynamically using tools.
    
     CRITICAL RULES 
    1. DO NOT HALLUCINATE PATHS: You already have the full Directory Tree below. ONLY call 'read_file' on files that actually exist in this tree. Do not guess folder names.
    2. USE FIND_FILE: If you are looking for a file but don't know the exact path, use the 'find_file' tool. DO NOT guess the path.
    3. YOU ARE STRICTLY PROHIBITED FROM: Creating new files, modifying files, or writing code.
    4. Use 'grep_search' to find where specific functions, classes, or variables are defined.
    5. Once you have enough context, reply with: "READY_TO_CODE".
    
    --- DIRECTORY TREE ---
    ${projectContext}`;
    const messages = [
        { role: 'system', content: explorePrompt },
        { role: 'user', content: `Task: ${taskDescription}\nYou already know the file paths. Call 'read_file' on the targets immediately in a single batch, then exit with READY_TO_CODE!` }
    ];
    //  Inject the Claude-Style Dynamic Grep & Find Tools
    const dynamicTools = [
        {
            type: "function",
            function: {
                name: "grep_search",
                description: "Search the entire codebase for a regex or string pattern (like ripgrep). Use this to hunt down where functions are used.",
                parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
        },
        {
            type: "function",
            function: {
                name: "find_file",
                description: "Search the directory tree for a specific file by its name or partial name if you don't know the exact folder path.",
                parameters: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] }
            }
        },
        ...agentTools_1.agentToolDefinitions.filter(t => ['read_file', 'list_directory'].includes(t.function.name))
    ];
    let gatheredContext = "";
    statusCallback('analyze', 'Initializing Dynamic Search');
    for (let step = 0; step < 2; step++) {
        try {
            const chatOptions = {
                tools: dynamicTools,
                toolChoice: 'auto',
                temperature: 0.1
            };
            if (abortSignal)
                chatOptions.signal = abortSignal;
            const aiMessage = await provider.chatCompletion(messages, chatOptions);
            messages.push(aiMessage);
            if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                for (const toolCall of aiMessage.tool_calls) {
                    const funcName = toolCall.function.name;
                    const funcArgs = JSON.parse(toolCall.function.arguments);
                    let toolResult = "";
                    if (funcName === 'grep_search') {
                        statusCallback('search', 'Grep Search', `Pattern: ${funcArgs.pattern}`);
                        try {
                            if (funcArgs.pattern.length < 3) {
                                toolResult = "Pattern too short. Please use a more specific search term.";
                            }
                            else {
                                // 🚀 CROSS-PLATFORM BATCH GREP: 
                                // Fetch targets, then read them concurrently while bypassing the slow fs.stat()
                                const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,json,html,css,py,java,cpp,c,go,rs,rb,md,txt}', '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**}', 150 // Strict limit to prevent memory hangs
                                );
                                const regex = new RegExp(funcArgs.pattern, 'i');
                                let matchCount = 0;
                                await Promise.all(files.map(async (file) => {
                                    if (matchCount >= 30)
                                        return;
                                    try {
                                        const fileData = await vscode.workspace.fs.readFile(file);
                                        // 🚀 INSTANT SKIP: Ignore empty files or files > 500KB without needing fs.stat
                                        if (fileData.byteLength === 0 || fileData.byteLength > 512000)
                                            return;
                                        const content = new TextDecoder('utf8').decode(fileData);
                                        const lines = content.split('\n');
                                        for (let i = 0; i < lines.length; i++) {
                                            const line = lines[i];
                                            if (line !== undefined && regex.test(line)) {
                                                const relativePath = vscode.workspace.asRelativePath(file);
                                                toolResult += `${relativePath}:${i + 1}: ${line.trim().substring(0, 100)}\n`;
                                                matchCount++;
                                                if (matchCount >= 30)
                                                    return;
                                            }
                                        }
                                    }
                                    catch (err) {
                                        // Silently skip unreadable files
                                    }
                                }));
                                toolResult = toolResult ? toolResult : "No matches found.";
                            }
                        }
                        catch (e) {
                            toolResult = "Grep failed due to invalid regex.";
                        }
                    }
                    else if (funcName === 'find_file') {
                        statusCallback('search', 'Finding File', funcArgs.filename);
                        try {
                            const files = await vscode.workspace.findFiles(`**/*${funcArgs.filename}*`, '{**/node_modules/**,**/.git/**,**/dist/**}', 10);
                            toolResult = files.length > 0
                                ? files.map(f => vscode.workspace.asRelativePath(f)).join('\n')
                                : "File not found. Do not guess the path.";
                        }
                        catch (e) {
                            toolResult = "File search failed.";
                        }
                    }
                    else if (funcName === 'read_file') {
                        // 🚀 HALLUCINATION GUARD: Fast fail if the file doesn't exist
                        try {
                            const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), funcArgs.filepath);
                            await vscode.workspace.fs.stat(uri);
                            statusCallback('read', 'Read file(s)', funcArgs.filepath);
                            // Component 2B-3b: dispatchWithEvents replaces the
                            // legacy executeAgentTool shim. No emitter wired
                            // (this code path is exploration before user-visible
                            // task work begins). source='planner' tags events
                            // for any future emitter the caller might attach.
                            const dispatchResult = await (0, toolDispatchWithEvents_1.dispatchWithEvents)(toolCall, { workspaceRoot }, { source: 'planner', preDispatchHook: securityHook_1.allowAllHook });
                            toolResult = dispatchResult.llmContent;
                        }
                        catch (e) {
                            toolResult = `ERROR: File '${funcArgs.filepath}' does not exist. STOP guessing paths. Use 'find_file' to locate it.`;
                        }
                    }
                    else if (funcName === 'list_directory') {
                        // 🚀 HALLUCINATION GUARD: Fast fail if the folder doesn't exist
                        try {
                            const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), funcArgs.path || "");
                            await vscode.workspace.fs.stat(uri);
                            statusCallback('search', 'List Directory', funcArgs.path);
                            const dispatchResult = await (0, toolDispatchWithEvents_1.dispatchWithEvents)(toolCall, { workspaceRoot }, { source: 'planner', preDispatchHook: securityHook_1.allowAllHook });
                            toolResult = dispatchResult.llmContent;
                        }
                        catch (e) {
                            toolResult = `ERROR: Directory '${funcArgs.path}' does not exist. Look at the DIRECTORY TREE.`;
                        }
                    }
                    else {
                        // Fallback for any tool not specifically handled above
                        // (shouldn't fire today since the tool list is fixed,
                        // but kept as a safety net). Same dispatchWithEvents
                        // path as the explicit cases above.
                        const dispatchResult = await (0, toolDispatchWithEvents_1.dispatchWithEvents)(toolCall, { workspaceRoot }, { source: 'planner', preDispatchHook: securityHook_1.allowAllHook });
                        toolResult = dispatchResult.llmContent;
                    }
                    gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
                }
            }
            else {
                if (aiMessage.content?.includes("READY_TO_CODE"))
                    break;
            }
        }
        catch (e) {
            break;
        }
    }
    return gatheredContext;
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
    const config = vscode.workspace.getConfiguration('nexuscode');
    const fixedModel = config.get('model') || 'qwen2.5-coder';
    return [fixedModel];
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
(Use Mermaid.js \`erDiagram\` syntax to map out the database relations. Wrap it in a \`\`\`mermaid code block.)
</er_diagram>

<business_interaction>
## Business Interaction Flow
(Use Mermaid.js \`sequenceDiagram\` syntax to show the core business logic and system interactions. Wrap it in a \`\`\`mermaid code block.)
</business_interaction>

<api_routes>
## API Specs
(Use standard Markdown lists or tables to describe routes. DO NOT use <request> or <param> XML tags.)
</api_routes>`;
    // Migrated to Provider abstraction (Component 1, Session 2). Note:
    // the original code set `response_format: { type: "json_object" }`
    // despite the system prompt asking for markdown wrapped in XML tags
    // — same bug pattern as streamChat in Session 1. The Provider's
    // streamCompletion does not set this; the model is now free to
    // produce the markdown the prompt asks for.
    const provider = await (0, llm_1.getProvider)();
    const completionOptions = {
        temperature: 0.2
    };
    if (abortSignal)
        completionOptions.signal = abortSignal;
    const fullDesign = await provider.completion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Requirements:\n${requirements}` }
    ], completionOptions);
    return fullDesign.trim();
}
async function generateTasks(requirements, design, existingStructure, abortSignal) {
    const systemPrompt = `You are the Principal Orchestrator Agent.
    The user has provided a PRD, a Technical Design Document, and the existing Directory Structure.
    YOU DO NOT WRITE CODE. Break the project down into an actionable, exhaustive implementation plan.
    
     CRITICAL ENGINEERING RULES 
    1. TOPOLOGICAL SORTING: You MUST order tasks logically. DB Models -> API Routes -> UI Components.
    2. ATOMIC FILES: Each task MUST target exactly ONE primary 'file'.
    3. EXISTING CONTEXT: Map tasks to the provided EXISTING DIRECTORY STRUCTURE.
    4. NO METADATA TASKS: DO NOT create tasks for "reviewing", "testing", "debugging", or "verifying". Our Swarm Engine handles QA automatically in the background. ONLY output concrete file-creation or code-editing tasks.
    
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
    const provider = await (0, llm_1.getProvider)();
    const completionOptions = {
        temperature: 0.1
    };
    if (abortSignal)
        completionOptions.signal = abortSignal;
    const parsedPlan = await provider.jsonCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `EXISTING STRUCTURE:\n${existingStructure}\n\nPRD:\n${requirements}\n\nDESIGN:\n${design}` }
    ], jsonSchemas_1.tasksPlanSchema, completionOptions);
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
async function askSecurityMonitor(command) {
    const systemPrompt = `You are an elite Security Monitor for an autonomous coding agent.
    Your ONLY job is to evaluate bash/terminal commands before they are executed.

    THREAT MODEL:
    - Irreversible local destruction (e.g., rm -rf /, wiping databases).
    - Credential exfiltration (e.g., curl sending ~/.aws/credentials to a random IP).
    - Blind Git Applies (e.g., git push --force without review).

    Standard dev commands (npm install, mkdir, touch, tsc, git status) are SAFE.

    Return JSON: { "allowed": true|false, "reason": "<one-sentence justification>" }
    Set "allowed" to false to BLOCK the command, true to ALLOW.`;
    try {
        const result = await (0, jsonRequest_1.jsonRequestData)({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Command to evaluate: ${command}` }
            ],
            schema: jsonSchemas_1.securityDecisionSchema,
            temperature: 0.0
        });
        return !result.allowed; // returns true if it should be blocked
    }
    catch (e) {
        return true; // Fail-safe: If the security monitor crashes, BLOCK the command!
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
    // Returns a JavaScript script, not JSON — uses provider.completion()
    // and the existing markdown-fence stripper.
    const provider = await (0, llm_1.getProvider)();
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