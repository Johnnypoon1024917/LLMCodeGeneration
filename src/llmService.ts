// src/llmService.ts
import * as vscode from 'vscode';
// Trigger registration of all tools by importing the barrel.
import './agents/tools';
import { getDeps } from './container';
import { RetryManager } from './infrastructure/RetryManager';
import { RateLimitManager } from './infrastructure/RateLimitManager';
import { errorMessage, isAbortError } from './utilities/errors';
import { jsonRequest, jsonRequestData } from './llm/jsonRequest';
import { getProvider } from './llm';
import {
    intentSchema,
    requirementPlanSchema,
    tasksPlanSchema,
    targetFileSchema,
    testSetupSchema,
    atomicEditsSchema,
    healErrorSchema,
    verificationSchema,
    livingPrdUpdateSchema,
    completenessReviewSchema,
    securityDecisionSchema,
    mctsApproachesSchema
} from './llm/jsonSchemas';
import { log } from './logger';

let _apiKeyMigrated = false;

export interface LLMConfig {
    endpoint: string;
    model: string;
    apiKey: string | undefined;
    /**
     * @deprecated Component 2A removed user-facing control of this
     * setting. Tool capability is now auto-detected per endpoint by
     * `OpenAICompatibleProvider.chatCompletion`. Field kept for binary
     * compatibility with `CliConfigSource.ts` mapping; value is
     * ignored. Will be removed in a future cleanup pass when CLI
     * config interface is updated.
     */
    enableTools: boolean;
}

/**
 * Per-agent role used for model routing. Each role can have its own
 * preferred model (configured via `nexuscode.modelPlanner`,
 * `nexuscode.modelCoder`, `nexuscode.modelVerifier`); when not set,
 * the role falls through to the global `nexuscode.model` default.
 *
 * Why per-role routing: long-horizon agentic reasoning (Planner) and
 * per-step code generation (Coder) have different cost / quality /
 * latency profiles. Cheaper-but-faster models work fine for Coder's
 * focused per-file edits, but Planner often benefits from a stronger
 * reasoning model. Routing lets users pay for quality only where it
 * matters. When all role keys are unset, behavior is identical to
 * pre-routing (everyone uses the global default).
 *
 * `'default'` is the implicit role for callers that don't specify
 * one — equivalent to omitting the parameter, returns the global
 * model.
 */
export type AgentRole = 'planner' | 'coder' | 'verifier' | 'default';

export interface AgileUserStory {
    epic: string;
    story: string;
    acceptanceCriteria: string[];
    edgeCases: string[];
}

export interface RequirementPlan {
    projectName: string;
    domain: string;
    targetAudience: string;
    userStories: AgileUserStory[];
    nonFunctionalRequirements: string[];
    outOfScope: string[];
}

function decodeHTMLEntities(text: string): string {
    const entities: Record<string, string> = {
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

export async function resilientFetch(url: string, options: any, logCallback?: (msg: string) => void): Promise<Response> {
    return await RetryManager.executeWithExponentialBackoff(async () => {
        // 🚀 FIX: Pre-check if the user already clicked cancel
        if (options?.signal?.aborted) {
            const e: Error & { status?: number } = new Error("This operation was aborted");
            e.name = 'AbortError';
            e.status = 400; // Force RetryManager to fast-fail
            throw e;
        }

        try {
            const response = await fetch(url, options);

            // Let the RateLimitManager inspect the headers. If it's a 429, it will pause the thread
            // and throw an error to trigger the RetryManager to try again.
            return await RateLimitManager.handleThrottling(response, logCallback);
        } catch (error: unknown) {
            // 🚀 FIX: Catch Fetch Abort (from Cancel button or Timeout) and force fast-fail
            if (isAbortError(error) || options?.signal?.aborted) {
                // Throw a freshly constructed AbortError carrying status=400 so RetryManager
                // skips retries. Mutating the caught `unknown` is hostile to the type system
                // and risky if the runtime threw something exotic.
                const abortErr: Error & { status?: number } = new Error('AbortError');
                abortErr.name = 'AbortError';
                abortErr.status = 400;
                throw abortErr;
            }
            throw error;
        }
    }, 3, 1000, (attempt, delay, error) => {
        const msg = `⚠️ Nexus API Hiccup (${errorMessage(error)}). Retrying in ${delay / 1000}s (Attempt ${attempt}/3)...`;
        if (logCallback) logCallback(msg);
        else log.warn(msg);
    });
}

export async function getLLMConfig(role: AgentRole = 'default'): Promise<LLMConfig> {
    const config = getDeps().config;

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
            const plain = config.get<string>('apiKey') ?? '';
            const isRealKey = plain.length > 5 && plain !== 'lm-studio';
            if (isRealKey) {
                await getDeps().secrets.store('nexuscode_apikey', plain);
                await config.update('apiKey', '');
                vscode.window.showInformationMessage(
                    "NexusCode: API key migrated to VS Code SecretStorage. The plain 'nexuscode.apiKey' setting has been cleared."
                );
            }
        } catch (e) {
            // Migration is best-effort — never block startup on it
            log.warn('NexusCode: API key migration skipped:', e);
        }
    }

    const secureKey = await getDeps().secrets.get('nexuscode_apikey');

    // Role-specific model resolution. The per-role keys are optional —
    // when set, they override the global `nexuscode.model` for that
    // role only. When unset (typical user), every role uses the global
    // default and behavior is identical to pre-routing.
    //
    // Precedence per role:
    //   1. `nexuscode.modelPlanner` / `modelCoder` / `modelVerifier`
    //      (matching the role parameter)
    //   2. `nexuscode.model` (global default)
    //   3. hardcoded fallback ('qwen2.5-coder')
    //
    // The 'default' role skips step 1 and goes straight to the global,
    // which matches old behavior — useful for code paths that aren't
    // role-tagged yet.
    const globalModel = config.get<string>('model') || 'qwen2.5-coder';
    let resolvedModel = globalModel;
    if (role === 'planner') {
        resolvedModel = config.get<string>('modelPlanner') || globalModel;
    } else if (role === 'coder') {
        resolvedModel = config.get<string>('modelCoder') || globalModel;
    } else if (role === 'verifier') {
        resolvedModel = config.get<string>('modelVerifier') || globalModel;
    }

    return {
        endpoint: config.get<string>('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: resolvedModel,
        apiKey: secureKey || undefined,                       // <-- no placeholder
        enableTools: config.get<boolean>('enableTools') ?? true
    };
}

export function authHeaders(apiKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
export function safeParseJSON<T>(jsonString: string): T {
    try {
        const startObj = jsonString.indexOf('{');
        const startArr = jsonString.indexOf('[');
        const firstChar = (startObj !== -1 && startArr !== -1) ? Math.min(startObj, startArr) : Math.max(startObj, startArr);

        const endObj = jsonString.lastIndexOf('}');
        const endArr = jsonString.lastIndexOf(']');
        const lastChar = Math.max(endObj, endArr);

        if (firstChar === -1 || lastChar === -1) { throw new Error("No JSON object found"); }

        let extract = jsonString.substring(firstChar, lastChar + 1);

        //  THE ENTERPRISE HEALER
        let healed = "";
        const stack: ('{' | '[')[] = [];
        let inString = false;
        let isEscaping = false;
        let lastMeaningfulChar = '';

        for (let i = 0; i < extract.length; i++) {
            const char = extract[i];
            if (char === undefined) continue; // bounded by length; defensive
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
                                while (k < extract.length && extract[k] !== '"') { k++; }
                                k++;
                                while (k < extract.length) {
                                    const ck = extract[k];
                                    if (ck === undefined || !/[ \n\r\t]/.test(ck)) break;
                                    k++;
                                }
                                if (extract[k] === ':') { isKey = true; }
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
                    } else {
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
        if (inString) { healed += '"'; }
        while (stack.length > 0) {
            const unclosed = stack.pop();
            healed += (unclosed === '{' ? '}' : ']');
        }

        // 🚨 HEALER 5: The Trailing Comma Stripper
        healed = healed.replace(/,\s*([\]}])/g, '$1');

        return JSON.parse(healed);
    } catch (e: unknown) {
        log.error("=======================================================");
        log.error("🚨 FATAL JSON PARSE ERROR 🚨");
        log.error("The AI generated this exact string which caused the crash:");
        log.error("-------------------------------------------------------");
        log.error(jsonString);
        log.error("=======================================================");
        throw new Error("Failed to extract JSON: " + String(e));
    }
}

export async function determineIntent(prompt: string): Promise<'build' | 'explain' | 'ask' | 'explore'> {
    const systemPrompt = `You are an intent classifier for an AI coding assistant.
Analyze the user's prompt and classify it into EXACTLY ONE of these four categories:

1. "build" - The user gives a concrete instruction to write new code, modify a specific file, or implement a feature.
2. "explore" - The user is asking you to debug, investigate a bug, find out why something failed, or explore the codebase autonomously. (e.g., "check why it failed", "find the bug", "investigate").
3. "explain" - The user is asking for a high-level summary or architectural overview of the project.
4. "ask" - The user is asking a general question, or just chatting.

Return JSON: {"intent": "<one of: build, explore, explain, ask>"}`;

    try {
        const result = await jsonRequestData<{ intent: string }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            schema: intentSchema,
            temperature: 0.1
        });
        const intent = result.intent;
        if (intent === 'build' || intent === 'explore' || intent === 'explain' || intent === 'ask') {
            return intent;
        }
        return 'ask';
    } catch (e: unknown) {
        return 'ask';
    }
}

export async function streamChat(
    prompt: string, contextStr: string,
    history: any[], onToken: (token: string) => void, abortSignal?: AbortSignal
): Promise<void> {
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
    const provider = await getProvider();

    // Build audit context up-front so the catch block can emit on failure
    // without re-reading config. Endpoint URL is logged but apiKey is NOT
    // (we deliberately exclude apiKey to avoid leaking it into audit logs).
    const auditPayload: import('./audit/types').LlmCallPayload = {
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

    const formattedHistory: { role: 'system' | 'user' | 'assistant'; content: string }[] = history.map(msg => {
        // If this is a compacted memory block, inject it as a system prompt!
        if (msg.isCompacted) {
            return { role: "system" as const, content: `--- PREVIOUS CONVERSATION MEMORY ---\n${msg.content}` };
        }

        // Strip out huge JSON plans or code attachments to save tokens
        const safeContent = msg.content || (msg.plan ? "[Implementation Plan Generated]" : "Empty Message");
        return { role: msg.role === 'user' ? 'user' as const : 'assistant' as const, content: safeContent };
    });

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: "system", content: systemPrompt },
        ...formattedHistory,
        { role: "user", content: userPrompt }
    ];

    try {
        const completionOptions: { temperature: number; signal?: AbortSignal } = {
            temperature: 0.3
        };
        if (abortSignal) {
            completionOptions.signal = abortSignal;
        }
        const stream = await provider.streamCompletion(messages, completionOptions);
        for await (const chunk of stream) {
            onToken(chunk);
        }
    } catch (error) {
        auditPayload.status = isAbortError(error) ? 'aborted' : 'error';
        auditPayload.errorMessage = errorMessage(error);
        // Audit emit is fire-and-forget (returns a promise we don't await
        // here — getDeps().audit serializes writes internally). We don't
        // want a slow audit write to delay the rethrow.
        void getDeps().audit.logLlmCall(auditPayload);
        throw error;
    }
    // Success path: emit a successful llm_call record. The token counts
    // aren't tracked in this stream-chat path (no usage callback wired
    // here), so they're omitted from the payload. When/if Coordinator
    // routes through this path with a usage callback, we can add them.
    void getDeps().audit.logLlmCall(auditPayload);
}

export async function generateRequirements(rawIdea: string, contextStr: string = "", abortSignal?: AbortSignal): Promise<RequirementPlan> {
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

    const opts: Parameters<typeof jsonRequestData>[0] = {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        schema: requirementPlanSchema,
        temperature: 0.2
    };
    if (abortSignal) {
        opts.signal = abortSignal;
    }
    return jsonRequestData<RequirementPlan>(opts);
}

//  ENHANCEMENT A: Added "relatedRequirement" to bridge Code and PRD
export interface ProjectTask {
    step: string;
    file: string;
    detailedInstructions: string;
    relatedRequirement: string;
    dependencies: string[];
    verificationRules: string[];
    testStrategy: string;
}

export interface AIPlan {
    folderStructure: string[];
    implementationTasks: (string | ProjectTask)[];
}
export interface TestSetupPlan { installCommand: string; testCommand: string; filepath: string; code: string; }
export interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append'; }

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
export function validateTasksPlan(plan: AIPlan): string | null {
    if (!plan || !Array.isArray(plan.implementationTasks)) {
        return 'plan has no implementationTasks array';
    }
    if (plan.implementationTasks.length === 0) {
        return 'plan has zero tasks';
    }

    const issues: string[] = [];
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
        const t = task as Partial<ProjectTask>;
        const missing: string[] = [];
        if (!t.step || !String(t.step).trim()) missing.push('step');
        if (!t.file || !String(t.file).trim()) missing.push('file');
        if (!t.detailedInstructions || !String(t.detailedInstructions).trim()) {
            missing.push('detailedInstructions');
        }
        if (missing.length > 0) {
            issues.push(`task[${idx}] is missing or empty: ${missing.join(', ')}`);
        }
    });

    if (issues.length === 0) return null;
    // Cap the issue list at 5 entries so error messages stay readable
    // when the model returns 17 empty tasks. The first few are enough
    // to communicate the failure mode; the user doesn't need to scroll.
    const head = issues.slice(0, 5);
    const remaining = issues.length - head.length;
    if (remaining > 0) head.push(`(+${remaining} more)`);
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
function buildCorrectiveMessage(issues: string): string {
    if (issues.includes('zero tasks')) {
        return (
            `Your previous response had: ${issues}.\n\n` +
            `You returned an empty implementationTasks array. This is INVALID. ` +
            `You MUST produce AT LEAST ONE task. Do not return an empty array under any circumstances.\n\n` +
            `If the user's request is "create a website" or similar broad scaffolding, START with bootstrapping tasks: ` +
            `one task to create package.json with the dependencies, one task to create tsconfig.json, ` +
            `one task to create src/index.tsx (entry point), one task to create src/App.tsx, etc. Each gets ` +
            `its own task object with concrete step, file, and detailedInstructions.\n\n` +
            `If the request is to modify existing code, identify the SINGLE most important file to change ` +
            `and produce one well-scoped task targeting it.\n\n` +
            `Re-emit the entire JSON. Make sure implementationTasks contains at least one fully-populated task object.`
        );
    }
    if (issues.includes('no implementationTasks array')) {
        return (
            `Your previous response had: ${issues}.\n\n` +
            `The "plan" object MUST contain an "implementationTasks" array. ` +
            `Re-emit the entire JSON with a properly-shaped plan object: ` +
            `{ "folderStructure": [...], "implementationTasks": [ {...}, {...} ] }.`
        );
    }
    // Field-level failure — the original generic message.
    return (
        `Your previous response had a structural problem: ${issues}.\n\n` +
        `Every task MUST have non-empty values for "step", "file", and "detailedInstructions". ` +
        `Do not return placeholder strings, single spaces, or empty strings for these fields. ` +
        `Each task should describe a concrete file-creation or code-editing action with a real target path.`
    );
}


export async function generatePlan(prompt: string, projectContext: string): Promise<{ explanation: string, plan: AIPlan }> {
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
- For new projects (empty directory tree), START with bootstrapping tasks: package.json, tsconfig.json, src/index.tsx, src/App.tsx, etc. Each as a separate task.`;

    const baseMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const,   content: `EXISTING DIRECTORY STRUCTURE:\n${projectContext}\n\nUSER REQUEST: ${prompt}` }
    ];

    // We build a fresh JSON-schema envelope here that wraps
    // `tasksPlanSchema`'s shape (the ProjectTask shape). Inline rather
    // than adding a new exported schema because this is the only call
    // site for it and pulling it into jsonSchemas.ts would require
    // touching that file too. The legacy `planEnvelopeSchema` (which
    // wrapped the OLD task shape) is no longer referenced anywhere.
    const planEnvelopeWithTasksShape: import('./llm/jsonSchemas').JsonSchema = {
        name: 'plan_envelope_v2',
        strict: false,
        schema: {
            type: 'object',
            properties: {
                explanation: { type: 'string' },
                plan: tasksPlanSchema.schema
            },
            required: ['explanation', 'plan']
        }
    };

    let result = await jsonRequestData<{ explanation?: string, plan?: AIPlan }>({
        messages: baseMessages,
        schema: planEnvelopeWithTasksShape,
        temperature: 0.1
    });

    let plan: AIPlan = result.plan || ({ folderStructure: [], implementationTasks: [] } as AIPlan);
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
        const correctiveMessages: typeof baseMessages = [
            ...baseMessages,
            {
                role: 'system' as const,
                content: buildCorrectiveMessage(issues)
            }
        ];
        result = await jsonRequestData<{ explanation?: string, plan?: AIPlan }>({
            messages: correctiveMessages,
            schema: planEnvelopeWithTasksShape,
            temperature: 0.1
        });
        plan = result.plan || ({ folderStructure: [], implementationTasks: [] } as AIPlan);
        issues = validateTasksPlan(plan);
        if (issues) {
            throw new Error(
                `Implementation plan generation failed validation after retry: ${issues}. ` +
                `This usually means the model endpoint is having trouble with the structured-output ` +
                `format. Try regenerating the plan, or check the model/endpoint configuration.`
            );
        }
    }

    return {
        explanation: result.explanation || "Here is the implementation plan:",
        plan
    };
}

export async function inferTargetFile(taskDescription: string, projectContext: string, lastActiveFile?: string): Promise<{ filepath: string, reasoning: string }> {
    const contextHint = lastActiveFile ? `CONTEXT: You just modified "${lastActiveFile}". Unless explicitly mentioned, MUST continue working on "${lastActiveFile}".` : "";
    const systemPrompt = `You are a Senior Software Architect. Analyze the directory and the task.
    Decide exactly ONE file that needs to be reviewed, modified, or created.
    ${contextHint}
    Return ONLY valid JSON: { "filepath": "src/file.ts", "reasoning": "..." }`;

    return jsonRequestData<{ filepath: string, reasoning: string }>({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Directory:\n${projectContext}\n\nTask: ${taskDescription}` }
        ],
        schema: targetFileSchema,
        temperature: 0.1
    });
}

export async function generateTests(fileName: string, fileContent: string, projectRules: string = ""): Promise<TestSetupPlan> {
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

    return jsonRequestData<TestSetupPlan>({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Target: ${fileName}\n\n\`\`\`\n${fileContent}\n\`\`\`` }
        ],
        schema: testSetupSchema,
        temperature: 0.1
    });
}

export async function healError(errorOutput: string, sourceFilePath: string, sourceCode: string, testFilePath: string, testCode: string): Promise<{ filepath: string, code: string }> {
    const systemPrompt = `You are an expert debugger. Determine if the error is in the source code OR the test code. Fix ONLY the file causing the error.
    Return JSON: { "filepath": "<path>", "code": "<full file content>" }
    The "code" field must contain the COMPLETE file content, not a diff. Use \\n for line breaks inside the JSON string.`;
    const userPrompt = `Source: ${sourceFilePath}\n\`\`\`\n${sourceCode}\n\`\`\`\nTest: ${testFilePath}\n\`\`\`\n${testCode}\n\`\`\`\nError:\n\`\`\`\n${errorOutput}\n\`\`\``;

    const result = await jsonRequestData<{ filepath: string, code: string }>({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        schema: healErrorSchema,
        temperature: 0.1
    });
    // Strip markdown fences the model may have wrapped around the code
    const extractedCode = decodeHTMLEntities(result.code.trim()).replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
    return { filepath: result.filepath.trim(), code: extractedCode };
}

export async function generateAtomicEdits(tasks: string[], projectContext: string, _codingStyle: string): Promise<AtomicEdit[]> {
    const systemPrompt = `Return JSON: { "edits": [{ "filepath": "...", "code": "...", "action": "replace" }] }`;
    const result = await jsonRequestData<{ edits: AtomicEdit[] }>({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Tasks: ${tasks.join(', ')}\n\nContext:\n${projectContext}` }
        ],
        schema: atomicEditsSchema,
        temperature: 0.1
    });
    return result.edits;
}


export async function getAvailableModels(): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('nexuscode');
    const fixedModel = config.get<string>('model') || 'qwen2.5-coder';
    return [fixedModel];
}

export async function generateDesign(requirements: string, abortSignal?: AbortSignal): Promise<string> {
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
    // Per-agent routing: design generation is planner-like reasoning
    // work (analyzing requirements + producing structured architectural
    // output). Routes to `nexuscode.modelPlanner` when configured,
    // falls back to global `nexuscode.model` when unset.
    const provider = await getProvider('planner');
    const completionOptions: import('./llm').CompletionOptions = {
        temperature: 0.2
    };
    if (abortSignal) completionOptions.signal = abortSignal;
    const fullDesign = await provider.completion(
        [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `Requirements:\n${requirements}` }
        ],
        completionOptions
    );

    return fullDesign.trim();
}

export async function generateTasks(requirements: string, design: string, existingStructure: string, abortSignal?: AbortSignal): Promise<AIPlan> {
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
    const provider = await getProvider('planner');
    const completionOptions: import('./llm').CompletionOptions = {
        temperature: 0.1
    };
    if (abortSignal) completionOptions.signal = abortSignal;

    const baseMessages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const,   content: `EXISTING STRUCTURE:\n${existingStructure}\n\nPRD:\n${requirements}\n\nDESIGN:\n${design}` }
    ];

    let parsedPlan = await provider.jsonCompletion<AIPlan>(
        baseMessages,
        tasksPlanSchema,
        completionOptions
    );

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
        const correctiveMessages: typeof baseMessages = [
            ...baseMessages,
            {
                role: 'system' as const,
                content: buildCorrectiveMessage(issues)
            }
        ];
        parsedPlan = await provider.jsonCompletion<AIPlan>(
            correctiveMessages,
            tasksPlanSchema,
            completionOptions
        );
        issues = validateTasksPlan(parsedPlan);
        if (issues) {
            throw new Error(
                `Implementation plan generation failed validation after retry: ${issues}. ` +
                `This usually means the model endpoint is having trouble with the structured-output ` +
                `format. Try regenerating the plan, or check the model/endpoint configuration.`
            );
        }
    }

    return parsedPlan;
}

export async function verifyAgainstSpec(
    techSpec: string,
    taskQuery: string,
    fileContent: string
): Promise<{ verified: boolean; reasoning: string; usage?: any }> { // 🚀 Added usage to return type

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
        const result = await jsonRequest<{ verified: boolean, reasoning: string }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            schema: verificationSchema,
            // Per-agent routing: verifier uses 'verifier' role so the
            // QA-review LLM call can be routed independently of the
            // Coder. Falls back to global default when
            // `nexuscode.modelVerifier` is unset.
            role: 'verifier',
            temperature: 0.0
        });
        return { ...result.data, usage: result.usage };
    } catch (error: unknown) {
        return { verified: false, reasoning: `System QA Error: ${errorMessage(error)}` };
    }
}

//  ENHANCEMENT A: The Living PRD QA Agent
export async function updateLivingPRD(prdContext: string, taskDescription: string, filepath: string, newCode: string): Promise<{ original: string, updated: string }[]> {
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
        const result = await jsonRequestData<{ replacements: { original: string, updated: string }[] }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `TASK:\n${taskDescription}\n\nFILE: ${filepath}\n\nNEW CODE:\n\`\`\`\n${newCode.substring(0, 10000)}\n\`\`\`\n\nCURRENT PRD:\n${prdContext}` }
            ],
            schema: livingPrdUpdateSchema,
            temperature: 0.1
        });
        return result.replacements || [];
    } catch (e) {
        log.warn("[DEBUG] QA Agent failed to parse PRD updates.");
        return [];
    }
}

//  PILLAR 3: The Completeness Reviewer
export async function reviewCodeCompleteness(taskDescription: string, prdContext: string, generatedCode: string): Promise<{ isComplete: boolean, critique: string }> {
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
        return await jsonRequestData<{ isComplete: boolean, critique: string }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            schema: completenessReviewSchema,
            temperature: 0.1
        });
    } catch (e) {
        log.warn("[DEBUG] Completeness Reviewer failed, bypassing to avoid blockage.");
        return { isComplete: true, critique: "" }; // Bypass if the reviewer itself crashes
    }
}

//  STEP 4: The Global Build-Healer Agent
export async function healGlobalBuild(buildErrors: string, filesContext: string, _codingStyle: string): Promise<AtomicEdit[]> {
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
        const result = await jsonRequestData<{ edits: AtomicEdit[] }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            schema: atomicEditsSchema,
            temperature: 0.1
        });
        return result.edits || [];
    } catch (e) {
        log.error("[DEBUG] Build-Healer failed to parse response.");
        return [];
    }
}

//  PHASE 4: ZERO-TRUST SECURITY FIREWALL
export async function askSecurityMonitor(command: string): Promise<boolean> {
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
        const result = await jsonRequestData<{ allowed: boolean, reason: string }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Command to evaluate: ${command}` }
            ],
            schema: securityDecisionSchema,
            temperature: 0.0
        });
        return !result.allowed; // returns true if it should be blocked
    } catch (e) {
        return true; // Fail-safe: If the security monitor crashes, BLOCK the command!
    }
}

//  PHASE 4: ADVERSARIAL VERIFICATION SPECIALIST
export async function generateAdversarialTest(task: string, filepath: string, code: string): Promise<string> {
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
    const provider = await getProvider('verifier');
    const script = await provider.completion(
        [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `Task: ${task}\nFile: ${filepath}\nCode:\n\`\`\`\n${code}\n\`\`\`` }
        ],
        { temperature: 0.1 }
    );
    return script.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
}

//  PHASE 2: THE COMPACTOR DAEMON
export async function compactConversationHistory(messages: any[]): Promise<string> {
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
    const provider = await getProvider();
    const result = await provider.completion(
        [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `CONVERSATION TO COMPACT:\n\`\`\`\n${formattedHistory}\n\`\`\`` }
        ],
        { temperature: 0.1 }
    );
    return result.trim();
}

//  PHASE 4: MONTE CARLO TREE SEARCH (MCTS) PLANNER
export async function generateMCTSApproaches(task: string, context: string): Promise<string[]> {
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
        const result = await jsonRequestData<{ approaches: string[] }>({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Task: ${task}\n\nContext:\n${context}` }
            ],
            schema: mctsApproachesSchema,
            temperature: 0.4
        });
        return result.approaches || [task];
    } catch (e) {
        return [task]; // Fallback to standard single execution if JSON fails
    }
}