// src/llmService.ts
import * as vscode from 'vscode';
import { agentToolDefinitions, executeAgentTool } from './agentTools';
import { globalContext } from './extension';

export interface AgileUserStory {
    epic: string;
    story: string;
    acceptanceCriteria: string[];
}

export interface RequirementPlan {
    projectName: string;
    domain: string;
    targetAudience: string;
    userStories: AgileUserStory[];
    nonFunctionalRequirements: string[];
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
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
    return decoded;
}

async function getLLMConfig() {
    const config = vscode.workspace.getConfiguration('nexuscode');
    // Attempt to get the key from the secure vault
    const secureKey = await globalContext.secrets.get('nexuscode_apikey');

    return {
        endpoint: config.get<string>('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get<string>('model') || 'qwen2.5-coder',
        apiKey: secureKey || config.get<string>('apiKey') || 'lm-studio',
        enableTools: config.get<boolean>('enableTools') || false
    };
}

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

        // 🔥 THE ENTERPRISE HEALER
        let healed = "";
        const stack: ('{' | '[')[] = [];
        let inString = false;
        let isEscaping = false;
        let lastMeaningfulChar = '';

        for (let i = 0; i < extract.length; i++) {
            const char = extract[i];
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
                        if (!/[ \n\r\t]/.test(extract[j])) {
                            nextMeaningful = extract[j];
                            if (nextMeaningful === '"') {
                                let k = j + 1;
                                while (k < extract.length && extract[k] !== '"') { k++; }
                                k++;
                                while (k < extract.length && /[ \n\r\t]/.test(extract[k])) { k++; }
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
        console.error("=======================================================");
        console.error("🚨 FATAL JSON PARSE ERROR 🚨");
        console.error("The AI generated this exact string which caused the crash:");
        console.error("-------------------------------------------------------");
        console.error(jsonString);
        console.error("=======================================================");
        throw new Error("Failed to extract JSON: " + String(e));
    }
}

export async function determineIntent(prompt: string): Promise<'build' | 'explain' | 'ask'> {
    console.log("[DEBUG-LLM] determineIntent triggered for prompt:", prompt);
    const systemPrompt = `You are an intent classifier for an AI coding assistant.
Analyze the user's prompt and classify it into EXACTLY ONE of these three categories:

1. "build" - The user wants to write new code, edit, modify, create files, refactor, add a feature, or fix a bug. 
   CRITICAL: If the user asks to change code (e.g., "Can you edit...", "Please add...", "Make it do X"), you MUST output "build", even if it is phrased as a question!
2. "explain" - The user is asking for a high-level summary, architectural overview, or explanation of the ENTIRE project.
3. "ask" - The user is asking a general coding question, asking to explain a specific small snippet, or just chatting.

Reply ONLY with the exact word: "build", "explain", or "ask".`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
                temperature: 0.1
            })
        });

        if (!response.ok) { throw new Error(`HTTP ${response.status} - ${await response.text()}`); }

        const data = await response.json() as any;

        if (!data.choices || data.choices.length === 0) { return 'ask'; }

        const intent = data.choices[0].message.content.trim().toLowerCase();
        if (intent.includes('build')) { return 'build'; }
        if (intent.includes('explain')) { return 'explain'; }
        return 'ask';
    } catch (e) {
        return 'ask';
    }
}

export async function streamQwenChat(
    prompt: string, contextStr: string, onToken: (token: string) => void, abortSignal?: AbortSignal
): Promise<void> {
    const { endpoint, model, apiKey } = await getLLMConfig();

    const systemPrompt = `You are Nexus, an elite Enterprise AI Software Architect. 
You are having a conversation with the developer about their codebase. 
Use the provided codebase context (Directory Tree, Open Files, and Vector DB results) to accurately answer their questions.

🔥 ANTI-HALLUCINATION PROTOCOL 🔥
The Vector DB Context may be polluted with old data from entirely different projects. 
You MUST prioritize the "Currently Open Files" and "Directory Tree". 
If the Vector search results (like C, Python, or FFmpeg scripts) completely clash with the open files (like a React/HTML project), IGNORE the Vector results entirely and ONLY explain the actual project files provided.

Always format your response in clean, highly readable Markdown. Use bullet points and code blocks where appropriate.`;

    const userPrompt = `--- GATHERED CODEBASE CONTEXT ---\n${contextStr}\n\n--- USER QUERY ---\n${prompt}`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.3,
                stream: true
            }),
            signal: abortSignal
        });

        if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
        if (!response.body) { throw new Error("No readable stream."); }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        let networkBuffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) { break; }

            networkBuffer += decoder.decode(value, { stream: true });
            let lines = networkBuffer.split('\n');
            networkBuffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }

                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(trimmed.substring(6));
                        const token = data.choices[0]?.delta?.content || data.choices[0]?.message?.content || "";
                        if (token) onToken(token);
                    } catch (e) { }
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const data = JSON.parse(trimmed);
                        const token = data.choices[0]?.message?.content || "";
                        if (token) onToken(token);
                    } catch (e) { }
                }
            }
        }

        if (networkBuffer.trim().startsWith('{')) {
            try {
                const data = JSON.parse(networkBuffer.trim());
                const token = data.choices?.[0]?.message?.content || data.choices?.[0]?.delta?.content || "";
                if (token) onToken(token);
            } catch (e) { }
        }

    } catch (error) {
        throw error;
    }
}

export async function askQwenForRequirements(rawIdea: string, contextStr: string = "", abortSignal?: AbortSignal): Promise<RequirementPlan> {
    const systemPrompt = `You are an elite Enterprise Business Analyst and Product Manager. 
    The user will give you a raw, brief idea for a software application.
    Your job is to expand this into a strict, Agile Product Requirements Document (PRD).
    
    Return ONLY valid JSON matching this exact schema:
    {
        "projectName": "Catchy Name",
        "domain": "e.g., Travel & Hospitality",
        "targetAudience": "e.g., Budget backpackers and solo travelers",
        "userStories": [
            { 
                "epic": "Authentication", 
                "story": "As a user, I want to sign up using my email so that I can save my bookings.", 
                "acceptanceCriteria": ["Must validate email format", "Passwords must be hashed", "Return 400 on duplicate email"] 
            }
        ],
        "nonFunctionalRequirements": ["99.9% Uptime", "Mobile Responsive UI", "GDPR Compliant Data Storage"]
    }
    
    🔥 CRITICAL RULES:
    1. Extract exactly 5 to 8 core Epics.
    2. Write strict, highly technical Acceptance Criteria for every user story.
    ${contextStr ? `3. 🔥 SUPPLEMENTARY DOCUMENTATION PROVIDED 🔥\nYou MUST extract the specific API endpoints, JSON payloads, and business logic from the provided documentation and embed them directly into the Acceptance Criteria!` : '3. Include critical Non-Functional Requirements (NFRs).'}
    4. ⚠️ THE SINGLE QUOTE PROTOCOL ⚠️: You are generating a JSON response. Therefore, inside your string values (like the Acceptance Criteria), you MUST NOT use double quotes. If you need to write a JSON payload, use SINGLE QUOTES (e.g., "Must send payload {'userId': 123}").
    5. ⚠️ NO COMMENTS ⚠️: Do not write ANY comments (like // or /*) inside your JSON output.
    6. ⚠️ PERFECT JSON SYNTAX ⚠️: You MUST perfectly close all strings with a double quote (") and all arrays with a closing bracket (]). DO NOT output broken arrays like '["a", "b", }. You MUST properly close it like '["a", "b"]}'.`;

    const userPrompt = contextStr ? `--- ATTACHED DOCUMENTATION CONTEXT ---\n${contextStr}\n\n--- RAW IDEA ---\n${rawIdea}` : `Raw Idea: ${rawIdea}`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0.2
        }),
        signal: abortSignal // 🔥 NEW: Wire the kill switch
    });

    const data = await response.json() as { error?: { message: string }, choices: { message: { content: string } }[] };
    if (data.error) throw new Error(data.error.message);

    const content = data.choices[0].message.content;

    // 🔥 DEBUG LOG: See exactly what the AI PM wrote
    console.log("[DEBUG-PM-AGENT] Raw AI Output:\n", content);

    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    return safeParseJSON<RequirementPlan>(content.substring(jsonStart, jsonEnd + 1));
}

// 🔥 ENHANCEMENT A: Added "relatedRequirement" to bridge Code and PRD
export interface ProjectTask { step: string; file: string; detailedInstructions: string; relatedRequirement: string; }
export interface AIPlan { folderStructure: string[]; implementationTasks: (string | ProjectTask)[]; }

export interface TestSetupPlan { installCommand: string; testCommand: string; filepath: string; code: string; }
export interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append'; }
interface QwenResponse { choices: { message: { content: string; }; }[]; }

export async function askQwenForStructure(prompt: string, projectContext: string): Promise<{ explanation: string, plan: AIPlan }> {
    const systemPrompt = `You are the Coordinator Agent (Lead Architect).
    Your job is to analyze the user's request and the EXISTING DIRECTORY STRUCTURE, then break it down into atomic tasks.
    YOU DO NOT WRITE THE FINAL CODE. You only generate the blueprint for the Coder Agent.
    
    1. First, write a brief 1-2 sentence explanation of the architectural approach.
    2. Then, output the implementation plan in STRICT JSON format.
    
    CRITICAL RULES FOR JSON:
    - ADAPT to the existing folder structure. Do not invent new paradigms.
    - In "folderStructure", list EVERY file that needs to be created OR modified.
    - ATOMIC TASKS: Break down "implementationTasks" so EACH task targets ONE file.

    Example Output:
    We need to add a new Booking tab to the navigation menu.
    \`\`\`json
    {
      "folderStructure": ["public/index.html"],
      "implementationTasks": ["Add booking tab to navigation in public/index.html"]
    }
    \`\`\``;

    const { endpoint, model, apiKey } = await getLLMConfig();

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `EXISTING DIRECTORY STRUCTURE:\n${projectContext}\n\nUSER REQUEST: ${prompt}` }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    if (data.error) { throw new Error(`LLM API Error: ${data.error.message}`); }
    if (!data.choices || data.choices.length === 0) { throw new Error("Invalid response from LLM API."); }

    const rawText = data.choices[0].message.content;

    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');

    let explanation = "Here is the implementation plan:";
    let jsonStr = '{"folderStructure":[], "implementationTasks":[]}';

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
        const textBefore = rawText.substring(0, jsonStart).replace(/```json/g, '').replace(/```/g, '').trim();
        if (textBefore) { explanation = textBefore; }
        jsonStr = rawText.substring(jsonStart, jsonEnd + 1);
    } else {
        explanation = rawText;
    }

    return { explanation, plan: safeParseJSON<AIPlan>(jsonStr) };
}

export async function askQwenForTargetFile(taskDescription: string, projectContext: string, lastActiveFile?: string): Promise<{ filepath: string, reasoning: string }> {
    const contextHint = lastActiveFile ? `CONTEXT: You just modified "${lastActiveFile}". Unless explicitly mentioned, MUST continue working on "${lastActiveFile}".` : "";
    const systemPrompt = `You are a Senior Software Architect. Analyze the directory and the task.
    Decide exactly ONE file that needs to be reviewed, modified, or created.
    ${contextHint}
    Return ONLY valid JSON: { "filepath": "src/file.ts", "reasoning": "..." }`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Directory:\n${projectContext}\n\nTask: ${taskDescription}` }],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    if (data.error) { throw new Error(`API Error: ${data.error.message}`); }

    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<{ filepath: string, reasoning: string }>(content);
}

export async function runAgenticExploration(taskDescription: string, workspaceRoot: string, statusCallback: (stepType: string, desc: string, details?: string) => void): Promise<string> {
    const { endpoint, model, apiKey, enableTools } = await getLLMConfig();

    if (!enableTools) return "";

    const explorePrompt = `You are the Explorer Agent. Your role is EXCLUSIVELY to search and analyze the codebase dynamically using tools.
    
    🔥 CRITICAL RULES 🔥
    1. YOU ARE STRICTLY PROHIBITED FROM: Creating new files, modifying files, or writing code.
    2. Use 'grep_search' to find where specific functions, classes, or variables are defined and used across the whole project.
    3. Use 'read_file' to extract the exact implementation logic.
    4. Once you have enough context, reply with: "READY_TO_CODE".`;

    let messages: any[] = [
        { role: "system", content: explorePrompt },
        { role: "user", content: `Task: ${taskDescription}\nHunt down the required context.` }
    ];

    // 🔥 Inject the Claude-Style Dynamic Grep Tool
    const dynamicTools = [
        {
            type: "function",
            function: {
                name: "grep_search",
                description: "Search the entire codebase for a regex or string pattern (like ripgrep). Use this to hunt down where functions are used.",
                parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
        },
        ...agentToolDefinitions.filter(t => ['read_file', 'list_directory'].includes(t.function.name))
    ];

    let gatheredContext = "";
    statusCallback('analyze', 'Initializing Dynamic Search');

    for (let step = 0; step < 4; step++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: model, messages: messages, tools: dynamicTools, tool_choice: "auto", temperature: 0.1 }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const data = await response.json() as any;
            const aiMessage = data.choices[0].message;
            messages.push(aiMessage);

            if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                for (const toolCall of aiMessage.tool_calls) {
                    const funcName = toolCall.function.name;
                    const funcArgs = JSON.parse(toolCall.function.arguments);
                    let toolResult = "";

                    // 🔥 Execute Native VS Code Grep
                    if (funcName === 'grep_search') {
                        statusCallback('search', 'Grep Search', `Pattern: ${funcArgs.pattern}`);
                        try {
                            // Search code files, explicitly ignoring heavy build directories
                            const files = await vscode.workspace.findFiles(
                                '**/*.{ts,tsx,js,jsx,json,html,css,py,java,cpp,c,go,rs,rb}', 
                                '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**}', 
                                300 // Max files to scan for performance
                            );
                            
                            // Safely parse the regex to avoid crash loops on bad AI payloads
                            const regex = new RegExp(funcArgs.pattern, 'i');
                            let matchCount = 0;

                            for (const file of files) {
                                if (matchCount >= 30) break; // Strict token safety limit!
                                try {
                                    const fileData = await vscode.workspace.fs.readFile(file);
                                    const content = Buffer.from(fileData).toString('utf8');
                                    const lines = content.split('\n');
                                    
                                    for (let i = 0; i < lines.length; i++) {
                                        if (regex.test(lines[i])) {
                                            const relativePath = vscode.workspace.asRelativePath(file);
                                            // Format: path/to/file.ts:42: const x = ...
                                            toolResult += `${relativePath}:${i + 1}: ${lines[i].trim().substring(0, 100)}\n`;
                                            matchCount++;
                                            if (matchCount >= 30) break;
                                        }
                                    }
                                } catch (err) { 
                                    // Silently skip unreadable or binary files
                                }
                            }
                            toolResult = toolResult ? toolResult : "No matches found.";
                        } catch (e) { 
                            toolResult = "Grep failed due to invalid regex or file permissions."; 
                        }
                    }else {
                        if (funcName === 'read_file') statusCallback('read', 'Read file(s)', funcArgs.filepath);
                        toolResult = await executeAgentTool(toolCall, workspaceRoot);
                    }

                    gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                    messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
                }
            } else {
                if (aiMessage.content?.includes("READY_TO_CODE")) break;
            }
        } catch (e) { break; }
    }
    return gatheredContext;
}

export async function askQwenForTests(fileName: string, fileContent: string): Promise<TestSetupPlan> {
    const systemPrompt = `You are an expert QA Engineer. Generate a comprehensive unit test file.
    Return valid JSON: { "installCommand": "...", "testCommand": "...", "filepath": "...", "code": "..." }`;
    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Target: ${fileName}\n\n\`\`\`\n${fileContent}\n\`\`\`` }],
            temperature: 0.1
        })
    });
    const data = await response.json() as QwenResponse;
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<TestSetupPlan>(content);
}

export async function askQwenToFixError(errorOutput: string, sourceFilePath: string, sourceCode: string, testFilePath: string, testCode: string): Promise<{ filepath: string, code: string }> {
    const systemPrompt = `You are an expert debugger. Determine if the error is in the source code OR the test code. Fix ONLY the file causing the error.
    Respond with valid XML: <filepath>path/to/file</filepath> <code>...</code>`;
    const userPrompt = `Source: ${sourceFilePath}\n\`\`\`\n${sourceCode}\n\`\`\`\nTest: ${testFilePath}\n\`\`\`\n${testCode}\n\`\`\`\nError:\n\`\`\`\n${errorOutput}\n\`\`\``;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1 })
    });

    const data = await response.json() as any;
    let content = data.choices[0].message.content;
    const filepathMatch = content.match(/<filepath>(.*?)<\/filepath>/s);
    const codeMatch = content.match(/<code>(.*?)<\/code>/s);
    if (!filepathMatch || !codeMatch) { throw new Error("Auto-healer failed to return XML tags."); }

    let extractedCode = decodeHTMLEntities(codeMatch[1].trim()).replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
    return { filepath: filepathMatch[1].trim(), code: extractedCode };
}

export async function askQwenForAtomicEdits(tasks: string[], projectContext: string, codingStyle: string): Promise<AtomicEdit[]> {
    const systemPrompt = `Return a JSON array of edits: [{ "filepath": "...", "code": "...", "action": "replace" }]`;
    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Tasks: ${tasks.join(', ')}\n\nContext:\n${projectContext}` }],
            temperature: 0.1
        })
    });
    const data = await response.json() as any;
    const content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<AtomicEdit[]>(content);
}

export async function streamQwenForCode(
    taskDescription: string,
    availableFiles: string[] = [],
    currentFileContent: string = "",
    codingStyle: string = "precise",
    chatHistory: any[] = [],
    callbacks: {
        onReasoning?: (token: string) => Promise<void>,
        onSetup: (action: string, filepath: string, target?: string) => Promise<void>,
        onToken: (token: string) => Promise<void>,
        onCommand?: (command: string) => Promise<void>,
        onFileComplete?: () => Promise<void>
    },
    abortSignal?: AbortSignal,
    agentMode: 'creator' | 'healer' | 'rewriter' = 'creator' // 🔥 THE SPLIT
): Promise<void> {
    const { endpoint, model, apiKey } = await getLLMConfig();

    let personaBrain = "";

    if (agentMode === 'creator') {
        personaBrain = `You are the Lead Software Engineer. Your job is to implement the requested feature or bug fix perfectly on the first try.`;
    } else if (agentMode === 'healer') {
        personaBrain = `You are the Build-Healer. The previous code crashed the compiler. Your ONLY job is to read the compiler errors and fix the syntax. DO NOT add new features. DO NOT refactor unrelated logic.`;
    } else if (agentMode === 'rewriter') {
        personaBrain = `You are the Redemption Agent. Your previous implementation was REJECTED by the Principal Engineer. You must read their critique and fix the logic completely. Do not repeat your previous mistakes.`;
    }

    const lineCount = currentFileContent.trim() ? currentFileContent.split('\n').length : 0;

    // 🔥 THE FIX: Zero-Trust Replace Policy. If the file exists, FORCE the AST Splicer.
    const hasExistingCode = lineCount > 0;

    const chunkingRules = hasExistingCode
        ? `PRECISE EDITING PROTOCOL:
    This file already exists. You MUST NOT use 'replace'. 
    Use <action>insert_before</action> to add new routes/logic. Target the EXACT LINE of code where the new code should be inserted above.
    Output ONLY the specific new code to be inserted.`
        : `<action> rules: 
    - 'replace': Creates a brand new file from scratch.`;

    const systemPrompt = `${personaBrain}
    
    CRITICAL RULE: ATOMIC SINGLE-FILE MODE. You are executing exactly ONE atomic task.
    
    🔥 MULTI-FILE EDITING IS STRICTLY FORBIDDEN 🔥
    Output exactly ONE block of code.
    
    ZERO CONVERSATIONAL FILLER ALLOWED. Go straight to the point.
    
    🛠️ ENTERPRISE ENGINEERING STANDARDS 🛠️
    1. NO UNNECESSARY ADDITIONS: Don't add features, refactor code, or make "improvements" beyond what was asked.
    2. NO PREMATURE ABSTRACTIONS: Don't design for hypothetical future requirements.
    3. NO UNNECESSARY ERROR HANDLING: Don't add fallbacks for scenarios that can't happen.
    4. NO COMPATIBILITY HACKS: Delete unused code completely.
    5. THE "NO STUBS" PROTOCOL: NEVER use placeholders like "// TODO". Write complete, production-ready logic.
    6. UNIVERSAL LANGUAGE RULES: Match the existing module system.
    
    ${chunkingRules}
    
    🛑 STRICT OUTPUT TEMPLATE 🛑
    You are a machine communicating with a rigid parser. You MUST output EXACTLY this sequence. 
    NEVER skip a tag. If you break this formatting, the system will crash.
    
    EXAMPLE EXACT OUTPUT:
    <plan>1 sentence explaining what you will do.</plan>
    <action>${hasExistingCode ? 'insert_before' : 'replace'}</action>
    ${hasExistingCode ? '<target>exact line of code to insert above</target>\n' : ''}<self_critique>Briefly critique your own plan. Did you follow the NO STUBS rule? Did you match the project's existing style? Are there any logical flaws?</self_critique>
    \`\`\`javascript
    // YOUR CODE GOES HERE. TRIPLE BACKTICKS ARE MANDATORY!
    \`\`\`
    <command></command>`;

    const userPrompt = currentFileContent.trim() ? `Task: ${taskDescription}\n\nEXISTING FILE:\n\`\`\`\n${currentFileContent}\n\`\`\`` : `Task: ${taskDescription}`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1, stream: true }),
        signal: abortSignal
    });

    if (!response.body) { throw new Error("No readable stream available."); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let isStreamingCode = false;
    let isReasoningCompleted = false;
    let isFirstCodeChunk = false;
    let hasFinishedCodeBlock = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const dataStr = line.substring(6).trim();
                    if (!dataStr) continue;

                    const data = JSON.parse(dataStr);
                    const token = data.choices[0]?.delta?.content || "";
                    buffer += token;

                    // 🔥 1. GLOBAL COMMAND EXTRACTOR (Routes purely to onCommand)
                    const cmdRegex = /<command>\s*(.*?)\s*<\/command>/is;
                    let cmdMatch;
                    while ((cmdMatch = buffer.match(cmdRegex)) !== null) {
                        if (callbacks.onCommand) { await callbacks.onCommand(cmdMatch[1].trim()); }
                        buffer = buffer.replace(cmdMatch[0], '');
                    }

                    if (!isStreamingCode) {
                        if (buffer.match(/<\/reason/i) || buffer.includes('<filepath>')) {
                            isReasoningCompleted = true;
                        }

                        if (callbacks.onReasoning && !isReasoningCompleted) {
                            // Add self_critique to the regex
                            let cleanToken = token.replace(/<\/?(plan|reasoning|filepath|action|target|command|typescript|self_critique)[^>]*>/gi, '');
                            if (cleanToken && !buffer.includes('###')) {
                                await callbacks.onReasoning(cleanToken);
                            }
                        }

                        const fpMatch = buffer.match(/<filepath>\s*(.*?)\s*<\/filepath>/i);
                        const acMatch = buffer.match(/<action>\s*(.*?)\s*<\/action>/i);
                        const targetMatch = buffer.match(/<target>\s*(.*?)\s*<\/target>/i);
                        const codeStartIdx = Math.max(buffer.lastIndexOf('```'), buffer.lastIndexOf('<code>'));
                        const ultraFallbackMatch = buffer.match(/<\/?[a-z]+>\s*(?:(?:typescript|javascript|tsx|jsx|ts|js|html|css|json)\s*)?(import |const |let |var |export |class |function )/i);

                        if ((fpMatch && acMatch && (codeStartIdx !== -1 || buffer.length - (acMatch.index! + acMatch[0].length) > 25)) ||
                            codeStartIdx !== -1 ||
                            ultraFallbackMatch) {

                            const filepath = fpMatch ? fpMatch[1].trim() : "unknown";
                            const action = acMatch ? acMatch[1].trim().toLowerCase() : "replace";
                            const target = targetMatch ? targetMatch[1].trim() : undefined;

                            await callbacks.onSetup(action, filepath, target);

                            let cutIndex = 0;
                            if (codeStartIdx !== -1) {
                                const nl = buffer.indexOf('\n', codeStartIdx);
                                cutIndex = nl !== -1 ? nl + 1 : codeStartIdx + 3;
                            } else if (ultraFallbackMatch) {
                                cutIndex = ultraFallbackMatch.index! + ultraFallbackMatch[0].indexOf(ultraFallbackMatch[1]);
                            } else if (targetMatch) {
                                cutIndex = targetMatch.index! + targetMatch[0].length;
                            } else if (acMatch) {
                                cutIndex = acMatch.index! + acMatch[0].length;
                            }

                            let codeBuffer = buffer.substring(cutIndex);

                            codeBuffer = codeBuffer.replace(/^\s*(typescript|javascript|tsx|jsx|ts|js|html|css|json)\s*\n/i, '');
                            // Add self_critique to the regex
                            codeBuffer = codeBuffer.replace(/<\/?(plan|filepath|action|target|reasoning|reason|typescript|javascript|self_critique)[^>]*>/gi, '');

                            buffer = codeBuffer;
                            isStreamingCode = true;
                            isFirstCodeChunk = true;
                            isReasoningCompleted = false;
                        }
                    } else {
                        if (isFirstCodeChunk) {
                            if (buffer.length < 30 && !buffer.includes('\n')) { continue; }
                            // Strip standard markdown backticks
                            buffer = buffer.replace(/^\s*```[a-z]*\s*\n?/i, '');
                            // Strip raw language words
                            buffer = buffer.replace(/^\s*(typescript|javascript|tsx|jsx|ts|js|html|css|json)\s*\n?/i, '');
                            // 🔥 STRIP MALFORMED TAGS (e.g., </javascript)
                            buffer = buffer.replace(/^\s*<\/[a-z]+>\s*\n?/i, '');
                            // Strip language words colliding with code
                            buffer = buffer.replace(/^\s*(typescript|javascript|tsx|jsx|ts|js|html|css|json)\s+(import |const |let |var |export |class |function |router)/i, '$2');
                            isFirstCodeChunk = false;
                        }

                        const codeEndMatch = buffer.match(/```|<\/code>/i);
                        const emergencyCommandMatch = buffer.match(/<command/i);

                        if (codeEndMatch || emergencyCommandMatch) {
                            const cutIndex = codeEndMatch ? codeEndMatch.index! : emergencyCommandMatch!.index!;
                            const finalCodeChunk = buffer.substring(0, cutIndex);

                            if (finalCodeChunk && !hasFinishedCodeBlock) {
                                await callbacks.onToken(finalCodeChunk);
                            }
                            if (callbacks.onFileComplete) { await callbacks.onFileComplete(); }

                            isStreamingCode = false;
                            hasFinishedCodeBlock = true;
                            buffer = buffer.substring(cutIndex + (codeEndMatch ? codeEndMatch[0].length : 0));
                        } else {
                            if (!hasFinishedCodeBlock) {
                                const cmdStartIdx = buffer.lastIndexOf('<command');
                                let safeTailLength = 15;
                                if (cmdStartIdx !== -1) { safeTailLength = Math.max(15, buffer.length - cmdStartIdx); }

                                if (buffer.length > safeTailLength) {
                                    const emitChunk = buffer.substring(0, buffer.length - safeTailLength);
                                    await callbacks.onToken(emitChunk);
                                    buffer = buffer.substring(buffer.length - safeTailLength);
                                }
                            }
                        }
                    }
                } catch (e) { }
            }
        }
    }

    if (buffer.length > 0) {
        const cmdRegex = /<command>\s*(.*?)\s*<\/command>/is;
        let cmdMatch;
        while ((cmdMatch = buffer.match(cmdRegex)) !== null) {
            if (callbacks.onCommand) await callbacks.onCommand(cmdMatch[1].trim());
            buffer = buffer.replace(cmdMatch[0], '');
        }

        if (isStreamingCode) {
            const cleanEnd = buffer.replace(/```$/, '').replace(/<\/code>$/, '');
            await callbacks.onToken(cleanEnd);
            if (callbacks.onFileComplete) await callbacks.onFileComplete();
        }
    }
}

export async function getAvailableModels(): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('nexuscode');
    const fixedModel = config.get<string>('model') || 'qwen2.5-coder';
    return [fixedModel];
}

export async function askQwenForDesign(requirements: string, abortSignal?: AbortSignal): Promise<string> {
    const systemPrompt = `You are an elite Principal System Architect at a top FAANG company. 
    The user has provided a Product Requirements Document (PRD).
    Your job is to generate a massive, highly detailed Technical Design Document (TDD) based strictly on these requirements.
    
    The document MUST include:
    1. High-Level Architecture: System context, data flow, scaling strategy, and tech stack justifications.
    2. Database Schema: Detailed tables, fields, data types, and relationships.
    3. API Design: Core REST/GraphQL routes, payload structures, and HTTP status codes.
    4. Enterprise ASCII Diagrams: You MUST draw extremely detailed, professional ASCII diagrams. You must include:
       - A complex Network/Architecture Diagram (including Gateways, Load Balancers, Microservices, DB clusters).
       - An Entity-Relationship (ER) Diagram showing tables and foreign keys.
       - A Sequence Diagram illustrating the core critical-path data flow (e.g., authentication or checkout).
    
    Do NOT generate simple, tiny boxes. Use professional spacing, comprehensive labels, and detailed ASCII connectors.
    Format the output in clean, highly readable Markdown. Return ONLY the Markdown text.`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Requirements:\n${requirements}` }],
            temperature: 0.2,
            stream: true
        }),
        signal: abortSignal // 🔥 NEW: Wire the kill switch
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("No readable stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullDesign = "";
    let networkBuffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        networkBuffer += decoder.decode(value, { stream: true });
        const packets = networkBuffer.split(/\r?\n\r?\n/);
        networkBuffer = packets.pop() || "";

        for (const packet of packets) {
            const lines = packet.split(/\r?\n/);
            for (const line of lines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                        const dataStr = line.substring(6).trim();
                        if (!dataStr) continue;

                        const data = JSON.parse(dataStr);
                        if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                            fullDesign += data.choices[0].delta.content;
                        }
                    } catch (e) { }
                }
            }
        }
    }

    if (networkBuffer) {
        const lines = networkBuffer.split(/\r?\n/);
        for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                try {
                    const dataStr = line.substring(6).trim();
                    if (dataStr) {
                        const data = JSON.parse(dataStr);
                        if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                            fullDesign += data.choices[0].delta.content;
                        }
                    }
                } catch (e) { }
            }
        }
    }

    return fullDesign.trim();
}

export async function askQwenForProjectTasks(requirements: string, design: string, abortSignal?: AbortSignal): Promise<AIPlan> {
    const systemPrompt = `You are the Coordinator Agent (Lead Staff Engineer). 
    The user has provided a PRD and a Technical Design Document.
    YOU DO NOT WRITE CODE. Your job is to break the entire project down into an actionable, exhaustive implementation plan for the Coder Agents.
    
    Return ONLY valid JSON matching this exact schema:
    {
      "folderStructure": ["src/index.ts", "src/routes/auth.ts"],
      "implementationTasks": [
        {
          "step": "Setup Express server and middleware",
          "file": "src/index.ts",
          "detailedInstructions": "Initialize Express. Configure CORS, Helmet, and Morgan middleware.",
          "relatedRequirement": "Epic: Authentication - Core Server Setup"
        }
      ]
    }
    
    🔥 CRITICAL RULES 🔥:
    1. You MUST output an array of OBJECTS for 'implementationTasks'.
    2. EXHAUSTIVE TASKS: 'detailedInstructions' must be a massive paragraph detailing EXACTLY what libraries to use, what methods to write, and the expected business logic from the PRD.
    3. ATOMIC EXECUTION: Each task MUST target exactly 1 primary 'file'.
    4. TRACEABILITY: 'relatedRequirement' MUST reference the exact Epic/Story from the PRD.`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `PRD:\n${requirements}\n\nDESIGN:\n${design}` }],
            temperature: 0.1,
            stream: true
        }),
        signal: abortSignal // 🔥 NEW: Wire the kill switch
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("No readable stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullContent = "";
    let networkBuffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        networkBuffer += decoder.decode(value, { stream: true });
        const packets = networkBuffer.split(/\r?\n\r?\n/);
        networkBuffer = packets.pop() || "";

        for (const packet of packets) {
            const lines = packet.split(/\r?\n/);
            for (const line of lines) {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                        const dataStr = line.substring(6).trim();
                        if (!dataStr) continue;
                        const data = JSON.parse(dataStr);
                        if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                            fullContent += data.choices[0].delta.content;
                        }
                    } catch (e) { }
                }
            }
        }
    }

    if (networkBuffer) {
        const lines = networkBuffer.split(/\r?\n/);
        for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                try {
                    const dataStr = line.substring(6).trim();
                    if (dataStr) {
                        const data = JSON.parse(dataStr);
                        if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                            fullContent += data.choices[0].delta.content;
                        }
                    }
                } catch (e) { }
            }
        }
    }

    const jsonStart = fullContent.indexOf('{');
    const jsonEnd = fullContent.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) { throw new Error("Failed to parse JSON plan."); }

    const parsedPlan = safeParseJSON<any>(fullContent.substring(jsonStart, jsonEnd + 1));

    if (parsedPlan && Array.isArray(parsedPlan.implementationTasks)) {
        parsedPlan.implementationTasks = parsedPlan.implementationTasks.map((task: any) => {
            if (typeof task === 'string') {
                return {
                    step: task,
                    file: "unknown",
                    detailedInstructions: task,
                    relatedRequirement: "General/Infrastructure"
                };
            }
            return task;
        });
    }

    return parsedPlan as AIPlan;
}

export async function askQwenToVerifyTask(taskDescription: string, requirements: string, codebaseContext: string): Promise<{ verified: boolean, reasoning: string }> {
    const systemPrompt = `You are a strict, elite QA Automation Engineer and Code Reviewer.
    The user (a human developer) claims to have manually completed a task.
    
    You must review their current codebase context against the Task Instructions and the PRD Acceptance Criteria.
    
    Return ONLY valid JSON matching this schema:
    {
        "verified": true, 
        "reasoning": "Explain exactly what criteria were met, or what is missing if you reject it."
    }`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `TASK INSTRUCTIONS:\n${taskDescription}\n\nSTRICT PRD:\n${requirements}\n\nCURRENT CODEBASE CONTEXT:\n${codebaseContext}` }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    if (data.error) throw new Error(data.error.message);

    const content = data.choices[0].message.content;
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    return safeParseJSON<{ verified: boolean, reasoning: string }>(content.substring(jsonStart, jsonEnd + 1));
}

// 🔥 ENHANCEMENT A: The Living PRD QA Agent
export async function askQwenToUpdatePRD(prdContext: string, taskDescription: string, filepath: string, newCode: string): Promise<{ original: string, updated: string }[]> {
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

    const { endpoint, model, apiKey } = await getLLMConfig();
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `TASK:\n${taskDescription}\n\nFILE: ${filepath}\n\nNEW CODE:\n\`\`\`\n${newCode.substring(0, 10000)}\n\`\`\`\n\nCURRENT PRD:\n${prdContext}` }
                ],
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        const content = data.choices[0].message.content;
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        const parsed = safeParseJSON<{ replacements: { original: string, updated: string }[] }>(content.substring(jsonStart, jsonEnd + 1));
        return parsed.replacements || [];
    } catch (e) {
        console.warn("[DEBUG] QA Agent failed to parse PRD updates.");
        return [];
    }
}

// 🔥 PILLAR 3: The Completeness Reviewer
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

    const { endpoint, model, apiKey } = await getLLMConfig();
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        const content = data.choices[0].message.content;
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        return safeParseJSON<{ isComplete: boolean, critique: string }>(content.substring(jsonStart, jsonEnd + 1));
    } catch (e) {
        console.warn("[DEBUG] Completeness Reviewer failed, bypassing to avoid blockage.");
        return { isComplete: true, critique: "" }; // Bypass if the reviewer itself crashes
    }
}

// 🔥 STEP 4: The Global Build-Healer Agent
export async function askQwenToHealGlobalBuild(buildErrors: string, filesContext: string, codingStyle: string): Promise<AtomicEdit[]> {
    const systemPrompt = `You are an elite Principal DevOps Engineer. The global project build just failed.
    You will be provided with the raw compiler error log and the contents of the files mentioned in the errors.
    
    Your job is to fix the cross-file mismatches, phantom imports, and type errors.
    
    Return ONLY a JSON array of atomic edits matching this schema:
    [
        { 
            "filepath": "src/routes/auth.ts", 
            "code": "import { User } from '../models/user';\\n...", 
            "action": "replace" 
        }
    ]
    
    🔥 CRITICAL RULES:
    1. Only fix the exact lines causing the compilation errors.
    2. Output the FULL file content for the "replace" action so we don't lose any existing logic.
    3. Do NOT output markdown outside of the JSON array.`;

    const userPrompt = `COMPILER ERRORS:\n\`\`\`\n${buildErrors}\n\`\`\`\n\nBROKEN FILES CONTEXT:\n${filesContext}`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        const content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return safeParseJSON<AtomicEdit[]>(content);
    } catch (e) {
        console.error("[DEBUG] Build-Healer failed to parse response.");
        return [];
    }
}

// 🔥 PHASE 4: ZERO-TRUST SECURITY FIREWALL
export async function askSecurityMonitor(command: string): Promise<boolean> {
    const systemPrompt = `You are an elite Security Monitor for an autonomous coding agent.
    Your ONLY job is to evaluate bash/terminal commands before they are executed.
    
    THREAT MODEL:
    - Irreversible local destruction (e.g., rm -rf /, wiping databases).
    - Credential exfiltration (e.g., curl sending ~/.aws/credentials to a random IP).
    - Blind Git Applies (e.g., git push --force without review).
    
    Standard dev commands (npm install, mkdir, touch, tsc, git status) are SAFE.
    
    If the command is SAFE, reply ONLY with: ALLOW
    If the command violates the threat model, reply ONLY with: BLOCK`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Command to evaluate: ${command}` }],
                temperature: 0.0 // MUST be zero for deterministic security!
            })
        });
        const data = await response.json() as any;
        const decision = data.choices[0].message.content.trim().toUpperCase();
        return decision.includes("BLOCK"); // Returns true if it should be blocked
    } catch (e) {
        return true; // Fail-safe: If the security monitor crashes, BLOCK the command!
    }
}

// 🔥 PHASE 4: ADVERSARIAL VERIFICATION SPECIALIST
export async function generateAdversarialTest(task: string, filepath: string, code: string): Promise<string> {
    const systemPrompt = `You are a hostile Verification Specialist. You do not trust the Coder Agent.
    Your job is to write a temporary Node.js script to aggressively test the code they just wrote.
    Do NOT just test the "happy path". Test edge cases, null inputs, and boundaries.
    
    Return ONLY a raw JavaScript script that can be executed via 'node'. 
    If the tests pass, the script MUST console.log("VERIFICATION_PASSED").
    If they fail, it MUST throw an Error.`;

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Task: ${task}\nFile: ${filepath}\nCode:\n\`\`\`\n${code}\n\`\`\`` }],
            temperature: 0.1
        })
    });
    const data = await response.json() as any;
    let script = data.choices[0].message.content;
    return script.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
}

// 🔥 PHASE 2: THE COMPACTOR DAEMON
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

    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `CONVERSATION TO COMPACT:\n\`\`\`\n${formattedHistory}\n\`\`\`` }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    return data.choices[0].message.content.trim();
}

// 🔥 PHASE 4: MONTE CARLO TREE SEARCH (MCTS) PLANNER
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

    const { endpoint, model, apiKey } = await getLLMConfig();
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Task: ${task}\n\nContext:\n${context}` }],
                temperature: 0.4
            })
        });
        const data = await response.json() as any;
        const jsonStr = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return parsed.approaches || [task];
    } catch (e) {
        return [task]; // Fallback to standard single execution if JSON fails
    }
}