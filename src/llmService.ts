// src/llmService.ts
import * as vscode from 'vscode';
import { agentToolDefinitions, executeAgentTool } from './agentTools';
import { globalContext } from './extension';

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
        enableTools : config.get<boolean>('enableTools') || false
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

        if (firstChar === -1 || lastChar === -1) throw new Error("No JSON object found");
        
        const extract = jsonString.substring(firstChar, lastChar + 1)
            .replace(/\/\/.*$/gm, '') // Remove inline comments
            .replace(/,\s*([\]}])/g, '$1'); // Fix trailing commas
            
        return JSON.parse(extract);
    } catch (e: unknown) {
        throw new Error("Failed to extract JSON: " + String(e));
    }
}

/**
 * Automatically classifies the user's prompt to determine the correct execution flow.
 */
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

        console.log("[DEBUG-LLM] determineIntent HTTP Status:", response.status);
        if (!response.ok) throw new Error(`HTTP ${response.status} - ${await response.text()}`);

        const data = await response.json() as any;
        console.log("[DEBUG-LLM] determineIntent Raw Response:", JSON.stringify(data));

        if (!data.choices || data.choices.length === 0) return 'ask'; 
        
        const intent = data.choices[0].message.content.trim().toLowerCase();
        if (intent.includes('build')) return 'build';
        if (intent.includes('explain')) return 'explain';
        return 'ask';
    } catch (e) {
        console.error("[DEBUG-LLM] determineIntent failed! Defaulting to 'ask'. Error:", e);
        return 'ask';
    }
} 

export async function streamQwenChat(
    prompt: string, contextStr: string, onToken: (token: string) => void, abortSignal?: AbortSignal
): Promise<void> {
    console.log("[DEBUG-LLM] streamQwenChat triggered.");
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

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error("No readable stream.");
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        let networkBuffer = ""; 

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            networkBuffer += decoder.decode(value, { stream: true });
            let lines = networkBuffer.split('\n');
            networkBuffer = lines.pop() || ""; 

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(trimmed.substring(6));
                        const token = data.choices[0]?.delta?.content || data.choices[0]?.message?.content || "";
                        if (token) onToken(token);
                    } catch (e) {}
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const data = JSON.parse(trimmed);
                        const token = data.choices[0]?.message?.content || "";
                        if (token) onToken(token);
                    } catch (e) {}
                }
            }
        }
        
        // 🔥 FIX: FLUSH LEFTOVER BUFFER
        // If LM Studio sends the whole response on one line without a newline, 
        // lines.pop() traps it here. We must manually flush it!
        if (networkBuffer.trim().startsWith('{')) {
            try {
                const data = JSON.parse(networkBuffer.trim());
                const token = data.choices?.[0]?.message?.content || data.choices?.[0]?.delta?.content || "";
                if (token) onToken(token);
            } catch (e) {
                console.warn("[DEBUG-LLM] Leftover buffer parse error:", e);
            }
        }
        
    } catch (error) {
        console.error("[DEBUG-LLM] streamQwenChat critically failed:", error);
        throw error; 
    }
}

export interface AIPlan { folderStructure: string[]; implementationTasks: string[]; }
export interface TestSetupPlan { installCommand: string; testCommand: string; filepath: string; code: string; }
export interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append'; }
interface QwenResponse { choices: { message: { content: string; }; }[]; }
interface ChatMessage { role: string; content?: string; plan?: { folderStructure: string[]; implementationTasks: string[]; }; }

export async function askQwenForStructure(prompt: string, projectContext: string): Promise<{ explanation: string, plan: AIPlan }> {
    const systemPrompt = `You are an expert AI software architect. Analyze the user's request and the EXISTING DIRECTORY STRUCTURE provided.
    
    1. First, write a brief 1-2 sentence explanation of what you are going to do and why.
    2. Then, output the implementation plan in STRICT JSON format.
    
    CRITICAL RULES FOR JSON:
    - ADAPT to the existing folder structure.
    - In "folderStructure", list EVERY file that needs to be created OR modified.
    - ATOMIC TASKS: Break down "implementationTasks" so EACH task targets ONE file. 

    Example Output:
    We need to add a new Booking tab to the navigation menu to allow users to access the booking form.
    \`\`\`json
    {
      "folderStructure": ["public/index.html"],
      "implementationTasks": ["Add booking tab to navigation in public/index.html"]
    }
    \`\`\``;

    // 🔥 FIX 1: Added 'await' because getLLMConfig now reads from the OS Vault securely!
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
    if (data.error) throw new Error(`LLM API Error: ${data.error.message}`);
    if (!data.choices || data.choices.length === 0) throw new Error("Invalid response from LLM API.");
    
    const rawText = data.choices[0].message.content;
    
    // 🔥 FIX 2: Bulletproof separation of the human explanation and the JSON code
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');
    
    let explanation = "Here is the implementation plan:";
    let jsonStr = '{"folderStructure":[], "implementationTasks":[]}';

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
        const textBefore = rawText.substring(0, jsonStart).replace(/```json/g, '').replace(/```/g, '').trim();
        if (textBefore) explanation = textBefore;
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
    if (data.error) throw new Error(`API Error: ${data.error.message}`);
    
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<{ filepath: string, reasoning: string }>(content);
}

// 🔥 ENTERPRISE UPGRADE: Structured Agent Telemetry
export async function runAgenticExploration(
    taskDescription: string, 
    workspaceRoot: string, 
    onStep: (stepType: string, description: string, details?: string) => void
): Promise<string> {
    const { endpoint, model, apiKey } = await getLLMConfig();
    let messages: any[] = [
        { 
            role: "system", 
            content: `You are an elite autonomous software architect. Your goal is to EXPLORE the codebase to gather the exact context needed.
Use your tools to read files, list directories, and search the codebase.
Once you have enough context, reply with the exact word: "READY_TO_CODE" and nothing else.`
        },
        { role: "user", content: `Task: ${taskDescription}\nExplore the codebase to figure out how to do this.` }
    ];

    let gatheredContext = "";
    
    // Notify UI that analysis is starting
    onStep('analyze', 'Analyzed task', taskDescription);

    for (let step = 0; step < 5; step++) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: model, messages: messages, tools: agentToolDefinitions, tool_choice: "auto", temperature: 0.1 })
        });

        const data = await response.json() as any;
        if (data.error) {
            onStep('error', 'Agent API Error', 'Tools might not be supported.');
            break;
        }

        const aiMessage = data.choices[0].message;
        messages.push(aiMessage);

        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            for (const toolCall of aiMessage.tool_calls) {
                const funcName = toolCall.function.name;
                const funcArgs = JSON.parse(toolCall.function.arguments);
                
                // 🔥 Route specific tools to beautiful UI Step Types
                if (funcName === 'search_codebase') {
                    onStep('search', 'Searched workspace', `Keyword: ${funcArgs.keyword}`);
                } else if (funcName === 'read_file') {
                    onStep('read', 'Read file(s)', funcArgs.filepath);
                } else if (funcName === 'list_directory') {
                    onStep('analyze', 'Analyzed directory', funcArgs.dirpath);
                }
                
                const toolResult = await executeAgentTool(toolCall, workspaceRoot);
                gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
            }
        } else {
            if (aiMessage.content && aiMessage.content.includes("READY_TO_CODE")) {
                break;
            } else break;
        }
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
    if (!filepathMatch || !codeMatch) throw new Error("Auto-healer failed to return XML tags.");
    
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
    taskDescription: string, availableFiles: string[] = [], currentFileContent: string = "", codingStyle: string = "precise", chatHistory: any[] = [],
    callbacks: { 
        onReasoning?: (token: string) => Promise<void>, 
        onSetup: (action: string, filepath: string, target?: string) => Promise<void>, 
        onToken: (token: string) => Promise<void> 
    },
    abortSignal?: AbortSignal // 🔥 NEW: Enterprise Cancellation Support
): Promise<void> {
    const { endpoint, model, apiKey } = await getLLMConfig(); 

    const systemPrompt = `You are an expert coding agent.
    CRITICAL RULE: SINGLE-FILE MODE. Output ONE <filepath>, ONE <action>, and ONE <code> block. 
    <action> rules: append, replace, or inject (requires <target> tag).
    
    🔥 XML FORMAT STRICT ORDER 🔥
    <reasoning>
    Explain your step-by-step thinking, edge cases, and cross-file consistency BEFORE writing code.
    </reasoning>
    <filepath>path/to/file.ext</filepath>
    <action>append | replace | inject</action>
    <target>ClassName (Only if inject)</target>
    <code>... code here ...</code>`;

    const userPrompt = currentFileContent.trim() ? `Task: ${taskDescription}\n\nEXISTING FILE:\n\`\`\`\n${currentFileContent}\n\`\`\`` : `Task: ${taskDescription}\n\n(File is empty, action must be 'replace')`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1, stream: true }),
        signal: abortSignal // Wire up the abort signal
    });

    if (!response.body) throw new Error("No readable stream available.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    let state: "SEARCHING_REASONING" | "STREAMING_REASONING" | "SEARCHING_SETUP" | "STREAMING_CODE" = "SEARCHING_REASONING";
    let buffer = ""; 

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const data = JSON.parse(line.substring(6));
                    const token = data.choices[0]?.delta?.content || "";
                    buffer += token;

                    // STAGE 1: Wait for <reasoning>
                    if (state === "SEARCHING_REASONING") {
                        const rStart = buffer.indexOf('<reasoning>');
                        if (rStart !== -1) {
                            state = "STREAMING_REASONING";
                            buffer = buffer.substring(rStart + 11);
                        } else if (buffer.includes('<filepath>') || buffer.includes('```') || buffer.includes('<code>')) {
                            state = "SEARCHING_SETUP"; 
                        }
                    }

                    // STAGE 2: Stream Reasoning
                    if (state === "STREAMING_REASONING") {
                        const rEnd = buffer.indexOf('</reasoning>');
                        if (rEnd !== -1) {
                            const chunk = buffer.substring(0, rEnd);
                            if (chunk && callbacks.onReasoning) await callbacks.onReasoning(chunk);
                            state = "SEARCHING_SETUP";
                            buffer = buffer.substring(rEnd + 12);
                        } else {
                            if (buffer.length > 15) { 
                                const chunk = buffer.substring(0, buffer.length - 15);
                                if (callbacks.onReasoning) await callbacks.onReasoning(chunk);
                                buffer = buffer.substring(buffer.length - 15);
                            }
                        }
                    }

                    // STAGE 3: 🔥 BULLETPROOF METADATA EXTRACTION
                    if (state === "SEARCHING_SETUP") {
                        const codeTag = buffer.indexOf('<code>');
                        const mdTag = buffer.indexOf('```');

                        let codeStart = -1;

                        if (codeTag !== -1) {
                            codeStart = codeTag + 6;
                        } else if (mdTag !== -1) {
                            const nl = buffer.indexOf('\n', mdTag);
                            if (nl !== -1) {
                                codeStart = nl + 1; // Safe! We waited for the newline.
                            }
                        }

                        if (codeStart !== -1) {
                            let filepath = buffer.match(/<filepath>(.*?)<\/filepath>/s)?.[1]?.trim() || "unknown";
                            let action = buffer.match(/<action>(.*?)<\/action>/s)?.[1]?.trim().toLowerCase() || 'replace';
                            let target = buffer.match(/<target>(.*?)<\/target>/s)?.[1]?.trim();

                            await callbacks.onSetup(action, filepath, target);
                            state = "STREAMING_CODE";
                            buffer = buffer.substring(codeStart);
                        }
                    }

                    // STAGE 4: Stream Code
                    if (state === "STREAMING_CODE") {
                        const endCode = buffer.indexOf('</code');
                        const endMd = buffer.indexOf('```');
                        const endIndex = endCode !== -1 ? endCode : endMd;

                        if (endIndex !== -1) {
                            const chunk = buffer.substring(0, endIndex);
                            if (chunk) await callbacks.onToken(chunk);
                            state = "SEARCHING_REASONING"; // Done!
                            break; 
                        } else {
                            if (buffer.length > 7) {
                                const chunk = buffer.substring(0, buffer.length - 7);
                                await callbacks.onToken(chunk);
                                buffer = buffer.substring(buffer.length - 7);
                            }
                        }
                    }
                } catch (e) { } // Ignore incomplete JSON chunks
            }
        }
        if (state === "STREAMING_CODE" && (buffer.includes('</code') || buffer.includes('```'))) break; 
    }
    
    if (state === "STREAMING_CODE" && buffer.length > 0) await callbacks.onToken(buffer);
}

/**
 * Fetches available models dynamically from the LM Studio / API endpoint.
 */
export async function getAvailableModels(): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('nexuscode');
    
    // Check if the user manually overrode it in settings, otherwise enforce the fixed model
    const fixedModel = config.get<string>('model') || 'qwen2.5-coder';
    
    return [fixedModel];
}