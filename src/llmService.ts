// src/llmService.ts
import * as vscode from 'vscode';
import { agentToolDefinitions, executeAgentTool } from './agentTools';

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

function getLLMConfig() {
    const config = vscode.workspace.getConfiguration('nexuscode');
    return {
        endpoint: config.get<string>('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get<string>('model') || 'qwen2.5-coder', // 🔥 Fixed default to qwen2.5-coder
        apiKey: config.get<string>('apiKey') || 'lm-studio',
        enableTools : config.get<boolean>('enableTools') || false
    };
}

function safeParseJSON<T>(jsonString: string): T {
    try {
        const start = jsonString.indexOf('{');
        const end = jsonString.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error("No JSON object found");
        
        const extract = jsonString.substring(start, end + 1)
            .replace(/\/\/.*$/gm, '') 
            .replace(/,\s*([\]}])/g, '$1'); 
            
        return JSON.parse(extract);
    } catch (e: unknown) {
        let msg = "Unknown error";
        if (e instanceof Error) msg = e.message;
        else if (typeof e === "string") msg = e;
        throw new Error("Failed to extract JSON: " + msg);
    }
}

export interface AIPlan { folderStructure: string[]; implementationTasks: string[]; }
export interface TestSetupPlan { installCommand: string; testCommand: string; filepath: string; code: string; }
export interface AtomicEdit { filepath: string; code: string; action: 'replace' | 'append'; }
interface QwenResponse { choices: { message: { content: string; }; }[]; }
interface ChatMessage { role: string; content?: string; plan?: { folderStructure: string[]; implementationTasks: string[]; }; }

export async function askQwenForStructure(prompt: string, projectContext: string): Promise<AIPlan> {
    const systemPrompt = `You are an expert AI software architect. Analyze the user's request and the EXISTING DIRECTORY STRUCTURE provided.
    CRITICAL RULES FOR PATHS:
    1. ADAPT to the existing folder structure.
    2. DO NOT use generic placeholders.
    3. In "folderStructure", you MUST list EVERY file that needs to be created OR modified.
    4. ATOMIC TASKS (ONE TASK PER FILE): Break down "implementationTasks" so that EACH task targets exactly ONE file. 

    Reply ONLY with valid JSON matching this schema: 
    { "folderStructure": ["src/actual/realFile.ts"], "implementationTasks": ["Step 1 description"] }`;

    const { endpoint, model, apiKey } = getLLMConfig();
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
    
    // 1. Existing error check
    if (data.error) throw new Error(`LLM API Error: ${data.error.message}`);
    
    // 2. 🔥 NEW DEFENSIVE CHECK: Make sure 'choices' exists before reading it!
    if (!data.choices || data.choices.length === 0) {
        throw new Error(`Invalid response from LLM API. Make sure your model is loaded and running. Raw response: ${JSON.stringify(data).substring(0, 150)}`);
    }
    
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<AIPlan>(content);
}

export async function askQwenForTargetFile(taskDescription: string, projectContext: string, lastActiveFile?: string): Promise<{ filepath: string, reasoning: string }> {
    const contextHint = lastActiveFile ? `CONTEXT: You just modified "${lastActiveFile}". Unless explicitly mentioned, MUST continue working on "${lastActiveFile}".` : "";
    const systemPrompt = `You are a Senior Software Architect. Analyze the directory and the task.
    Decide exactly ONE file that needs to be reviewed, modified, or created.
    ${contextHint}
    Return ONLY valid JSON: { "filepath": "src/file.ts", "reasoning": "..." }`;

    const { endpoint, model, apiKey } = getLLMConfig();
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

export async function runAgenticExploration(taskDescription: string, workspaceRoot: string, statusCallback: (message: string) => void): Promise<string> {
    const { endpoint, model, apiKey } = getLLMConfig();
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
    for (let step = 0; step < 5; step++) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: model, messages: messages, tools: agentToolDefinitions, tool_choice: "auto", temperature: 0.1 })
        });

        const data = await response.json() as any;
        if (data.error) {
            statusCallback(`⚠️ Agent API Error: Tools might not be supported. Proceeding...`);
            break;
        }

        const aiMessage = data.choices[0].message;
        messages.push(aiMessage);

        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            for (const toolCall of aiMessage.tool_calls) {
                const funcName = toolCall.function.name;
                const funcArgs = JSON.parse(toolCall.function.arguments);
                const uiMsg = funcName === 'search_codebase' ? `Agent searching for: ${funcArgs.keyword}...` : `Agent reading: ${funcArgs.filepath || funcArgs.dirpath}...`;
                statusCallback(`🧠 ${uiMsg}`);
                
                const toolResult = await executeAgentTool(toolCall, workspaceRoot);
                gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
            }
        } else {
            if (aiMessage.content && aiMessage.content.includes("READY_TO_CODE")) {
                statusCallback("💡 Context gathered. Ready to code.");
                break;
            } else break;
        }
    }
    return gatheredContext;
}

export async function askQwenForTests(fileName: string, fileContent: string): Promise<TestSetupPlan> {
    const systemPrompt = `You are an expert QA Engineer. Generate a comprehensive unit test file.
    Return valid JSON: { "installCommand": "...", "testCommand": "...", "filepath": "...", "code": "..." }`;
    const { endpoint, model, apiKey } = getLLMConfig();
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
    
    const { endpoint, model, apiKey } = getLLMConfig();
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
    const { endpoint, model, apiKey } = getLLMConfig();
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

// Replace ONLY the streamQwenForCode function in src/llmService.ts

export async function streamQwenForCode(
    taskDescription: string, availableFiles: string[] = [], currentFileContent: string = "", codingStyle: string = "precise", chatHistory: any[] = [],
    callbacks: { 
        onReasoning?: (token: string) => Promise<void>, // 🔥 NEW CALLBACK
        onSetup: (action: string, filepath: string, target?: string) => Promise<void>, 
        onToken: (token: string) => Promise<void> 
    }
): Promise<void> {
    const { endpoint, model, apiKey } = getLLMConfig(); 

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
    <code>... code here ...</code>
    <command>shell command here</command>`;

    const userPrompt = currentFileContent.trim() ? `Task: ${taskDescription}\n\nEXISTING FILE:\n\`\`\`\n${currentFileContent}\n\`\`\`` : `Task: ${taskDescription}\n\n(File is empty, action must be 'replace')`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1, stream: true })
    });

    if (!response.body) throw new Error("No readable stream available.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    // 🔥 NEW: 4-Stage State Machine for intercepting the Reasoning Stream
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
                            state = "SEARCHING_SETUP"; // AI skipped reasoning, proceed to code
                        }
                    }

                    // STAGE 2: Stream Reasoning to UI
                    if (state === "STREAMING_REASONING") {
                        const rEnd = buffer.indexOf('</reasoning>');
                        if (rEnd !== -1) {
                            const chunk = buffer.substring(0, rEnd);
                            if (chunk && callbacks.onReasoning) await callbacks.onReasoning(chunk);
                            state = "SEARCHING_SETUP";
                            buffer = buffer.substring(rEnd + 12);
                        } else {
                            if (buffer.length > 15) { // 15 char lookahead to prevent emitting closing tag
                                const chunk = buffer.substring(0, buffer.length - 15);
                                if (callbacks.onReasoning) await callbacks.onReasoning(chunk);
                                buffer = buffer.substring(buffer.length - 15);
                            }
                        }
                    }

                    // STAGE 3: Extract Metadata (Filepath & Action)
                    if (state === "SEARCHING_SETUP") {
                        const codeTag = buffer.indexOf('<code>');
                        const mdTag = buffer.indexOf('```');

                        if (codeTag !== -1 || mdTag !== -1) {
                            let filepath = buffer.match(/<filepath>(.*?)<\/filepath>/s)?.[1]?.trim() || "unknown";
                            let action = buffer.match(/<action>(.*?)<\/action>/s)?.[1]?.trim().toLowerCase() || 'replace';
                            let target = buffer.match(/<target>(.*?)<\/target>/s)?.[1]?.trim();

                            await callbacks.onSetup(action, filepath, target);
                            state = "STREAMING_CODE";

                            let codeStart = codeTag !== -1 ? codeTag + 6 : mdTag;
                            if (mdTag !== -1 && codeTag === -1) {
                                const nl = buffer.indexOf('\n', mdTag);
                                codeStart = nl !== -1 ? nl + 1 : mdTag + 3;
                            }
                            buffer = buffer.substring(codeStart);
                        }
                    }

                    // STAGE 4: Stream Code to VS Code Editor
                    if (state === "STREAMING_CODE") {
                        const endCode = buffer.indexOf('</code');
                        const endMd = buffer.indexOf('```');
                        const endIndex = endCode !== -1 ? endCode : endMd;

                        if (endIndex !== -1) {
                            const chunk = buffer.substring(0, endIndex);
                            if (chunk) await callbacks.onToken(chunk);
                            break; // Stream finished perfectly
                        } else {
                            if (buffer.length > 7) {
                                const chunk = buffer.substring(0, buffer.length - 7);
                                await callbacks.onToken(chunk);
                                buffer = buffer.substring(buffer.length - 7);
                            }
                        }
                    }
                } catch (e) { }
            }
        }
        if (state === "STREAMING_CODE" && buffer.includes('</code')) break; 
    }
    
    // Flush remaining code buffer if stream broke unexpectedly
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