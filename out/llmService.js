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
exports.safeParseJSON = safeParseJSON;
exports.determineIntent = determineIntent;
exports.streamQwenChat = streamQwenChat;
exports.askQwenForStructure = askQwenForStructure;
exports.askQwenForTargetFile = askQwenForTargetFile;
exports.runAgenticExploration = runAgenticExploration;
exports.askQwenForTests = askQwenForTests;
exports.askQwenToFixError = askQwenToFixError;
exports.askQwenForAtomicEdits = askQwenForAtomicEdits;
exports.streamQwenForCode = streamQwenForCode;
exports.getAvailableModels = getAvailableModels;
// src/llmService.ts
const vscode = __importStar(require("vscode"));
const agentTools_1 = require("./agentTools");
const extension_1 = require("./extension");
function decodeHTMLEntities(text) {
    const entities = {
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
    const secureKey = await extension_1.globalContext.secrets.get('nexuscode_apikey');
    return {
        endpoint: config.get('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get('model') || 'qwen2.5-coder',
        apiKey: secureKey || config.get('apiKey') || 'lm-studio',
        enableTools: config.get('enableTools') || false
    };
}
function safeParseJSON(jsonString) {
    try {
        const startObj = jsonString.indexOf('{');
        const startArr = jsonString.indexOf('[');
        const firstChar = (startObj !== -1 && startArr !== -1) ? Math.min(startObj, startArr) : Math.max(startObj, startArr);
        const endObj = jsonString.lastIndexOf('}');
        const endArr = jsonString.lastIndexOf(']');
        const lastChar = Math.max(endObj, endArr);
        if (firstChar === -1 || lastChar === -1)
            throw new Error("No JSON object found");
        const extract = jsonString.substring(firstChar, lastChar + 1)
            .replace(/\/\/.*$/gm, '') // Remove inline comments
            .replace(/,\s*([\]}])/g, '$1'); // Fix trailing commas
        return JSON.parse(extract);
    }
    catch (e) {
        throw new Error("Failed to extract JSON: " + String(e));
    }
}
/**
 * Automatically classifies the user's prompt to determine the correct execution flow.
 */
async function determineIntent(prompt) {
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
        if (!response.ok)
            throw new Error(`HTTP ${response.status} - ${await response.text()}`);
        const data = await response.json();
        console.log("[DEBUG-LLM] determineIntent Raw Response:", JSON.stringify(data));
        if (!data.choices || data.choices.length === 0)
            return 'ask';
        const intent = data.choices[0].message.content.trim().toLowerCase();
        if (intent.includes('build'))
            return 'build';
        if (intent.includes('explain'))
            return 'explain';
        return 'ask';
    }
    catch (e) {
        console.error("[DEBUG-LLM] determineIntent failed! Defaulting to 'ask'. Error:", e);
        return 'ask';
    }
}
async function streamQwenChat(prompt, contextStr, onToken, abortSignal) {
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
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        if (!response.body)
            throw new Error("No readable stream.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let networkBuffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            networkBuffer += decoder.decode(value, { stream: true });
            let lines = networkBuffer.split('\n');
            networkBuffer = lines.pop() || "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(trimmed.substring(6));
                        const token = data.choices[0]?.delta?.content || data.choices[0]?.message?.content || "";
                        if (token)
                            onToken(token);
                    }
                    catch (e) { }
                }
                else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const data = JSON.parse(trimmed);
                        const token = data.choices[0]?.message?.content || "";
                        if (token)
                            onToken(token);
                    }
                    catch (e) { }
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
                if (token)
                    onToken(token);
            }
            catch (e) {
                console.warn("[DEBUG-LLM] Leftover buffer parse error:", e);
            }
        }
    }
    catch (error) {
        console.error("[DEBUG-LLM] streamQwenChat critically failed:", error);
        throw error;
    }
}
async function askQwenForStructure(prompt, projectContext) {
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
    const data = await response.json();
    if (data.error)
        throw new Error(`LLM API Error: ${data.error.message}`);
    if (!data.choices || data.choices.length === 0)
        throw new Error("Invalid response from LLM API.");
    const rawText = data.choices[0].message.content;
    // 🔥 FIX 2: Bulletproof separation of the human explanation and the JSON code
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');
    let explanation = "Here is the implementation plan:";
    let jsonStr = '{"folderStructure":[], "implementationTasks":[]}';
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
        const textBefore = rawText.substring(0, jsonStart).replace(/```json/g, '').replace(/```/g, '').trim();
        if (textBefore)
            explanation = textBefore;
        jsonStr = rawText.substring(jsonStart, jsonEnd + 1);
    }
    else {
        explanation = rawText;
    }
    return { explanation, plan: safeParseJSON(jsonStr) };
}
async function askQwenForTargetFile(taskDescription, projectContext, lastActiveFile) {
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
    const data = await response.json();
    if (data.error)
        throw new Error(`API Error: ${data.error.message}`);
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
// 🔥 ENTERPRISE UPGRADE: Structured Agent Telemetry
async function runAgenticExploration(taskDescription, workspaceRoot, statusCallback) {
    const { endpoint, model, apiKey, enableTools } = await getLLMConfig();
    // 🔥 FIX 1: If tools are disabled (local LLMs), bypass instantly! No more 2-minute hangs!
    if (!enableTools) {
        statusCallback('analyze', 'Skipped Agentic Search', 'Tools disabled in settings. Relying on RAG.');
        return "";
    }
    let messages = [
        {
            role: "system",
            content: `You are an elite autonomous software architect. Your goal is to EXPLORE the codebase to gather the exact context needed.
Use your tools to read files, list directories, and search the codebase.
Once you have enough context, reply with the exact word: "READY_TO_CODE" and nothing else.`
        },
        { role: "user", content: `Task: ${taskDescription}\nExplore the codebase to figure out how to do this.` }
    ];
    let gatheredContext = "";
    statusCallback('analyze', 'Analyzed task', taskDescription);
    for (let step = 0; step < 3; step++) { // Reduced to 3 steps to save time
        try {
            // 🔥 FIX 2: Added a strict 15-second AbortController so it NEVER hangs forever
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: model, messages: messages, tools: agentTools_1.agentToolDefinitions, tool_choice: "auto", temperature: 0.1 }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await response.json();
            if (data.error)
                throw new Error(data.error.message);
            const aiMessage = data.choices[0].message;
            messages.push(aiMessage);
            if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                for (const toolCall of aiMessage.tool_calls) {
                    const funcName = toolCall.function.name;
                    const funcArgs = JSON.parse(toolCall.function.arguments);
                    if (funcName === 'search_codebase')
                        statusCallback('search', 'Searched workspace', `Keyword: ${funcArgs.keyword}`);
                    else if (funcName === 'read_file')
                        statusCallback('read', 'Read file(s)', funcArgs.filepath);
                    else if (funcName === 'list_directory')
                        statusCallback('analyze', 'Analyzed directory', funcArgs.dirpath);
                    const toolResult = await (0, agentTools_1.executeAgentTool)(toolCall, workspaceRoot);
                    gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                    messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
                }
            }
            else {
                if (aiMessage.content && aiMessage.content.includes("READY_TO_CODE"))
                    break;
                else
                    break;
            }
        }
        catch (e) {
            console.warn("[DEBUG] Agentic loop failed/timed out, bypassing safely.", e);
            statusCallback('error', 'Agent API Error', 'Failed to use tools. Falling back to standard context.');
            break; // Break cleanly instead of crashing the whole pipeline
        }
    }
    return gatheredContext;
}
async function askQwenForTests(fileName, fileContent) {
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
    const data = await response.json();
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
async function askQwenToFixError(errorOutput, sourceFilePath, sourceCode, testFilePath, testCode) {
    const systemPrompt = `You are an expert debugger. Determine if the error is in the source code OR the test code. Fix ONLY the file causing the error.
    Respond with valid XML: <filepath>path/to/file</filepath> <code>...</code>`;
    const userPrompt = `Source: ${sourceFilePath}\n\`\`\`\n${sourceCode}\n\`\`\`\nTest: ${testFilePath}\n\`\`\`\n${testCode}\n\`\`\`\nError:\n\`\`\`\n${errorOutput}\n\`\`\``;
    const { endpoint, model, apiKey } = await getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1 })
    });
    const data = await response.json();
    let content = data.choices[0].message.content;
    const filepathMatch = content.match(/<filepath>(.*?)<\/filepath>/s);
    const codeMatch = content.match(/<code>(.*?)<\/code>/s);
    if (!filepathMatch || !codeMatch)
        throw new Error("Auto-healer failed to return XML tags.");
    let extractedCode = decodeHTMLEntities(codeMatch[1].trim()).replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();
    return { filepath: filepathMatch[1].trim(), code: extractedCode };
}
async function askQwenForAtomicEdits(tasks, projectContext, codingStyle) {
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
    const data = await response.json();
    const content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
async function streamQwenForCode(taskDescription, availableFiles = [], currentFileContent = "", codingStyle = "precise", chatHistory = [], callbacks, abortSignal) {
    const { endpoint, model, apiKey } = await getLLMConfig();
    // 🔥 ENTERPRISE UPGRADE: Multi-file Prompt
    const systemPrompt = `You are an elite autonomous Enterprise coding agent.
    CRITICAL RULE: MULTI-FILE MODE. You may create or modify multiple files in a single response.
    
    <action> rules: 
    - 'replace': Overwrites the entire file (default).
    - 'append': Adds code to the end of the file.
    - 'inject': Inserts code into a specific Class or Function (requires <target> tag).
    
    🔥 XML FORMAT STRICT ORDER 🔥
    For EVERY file you need to modify, you MUST output this EXACT sequence:
    
    <reasoning>Explain your step-by-step thinking for this file.</reasoning>
    <filepath>path/to/file.ext</filepath>
    <action>replace | append | inject</action>
    <target>ClassNameOrFunctionName</target> \`\`\`
    ... code here ...
    \`\`\`
    <command>npm install package-name</command> You can repeat this entire sequence as many times as needed to complete the multi-file feature.`;
    const userPrompt = currentFileContent.trim() ? `Task: ${taskDescription}\n\nEXISTING FILE:\n\`\`\`\n${currentFileContent}\n\`\`\`` : `Task: ${taskDescription}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.1, stream: true }),
        signal: abortSignal
    });
    if (!response.body)
        throw new Error("No readable stream available.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    // 🔥 ENTERPRISE UPGRADE: Robust sliding-window AST parser
    let buffer = "";
    let isStreamingCode = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const data = JSON.parse(line.substring(6));
                    const token = data.choices[0]?.delta?.content || "";
                    buffer += token;
                    if (!isStreamingCode) {
                        // Forward reasoning if present
                        const rMatch = buffer.match(/<reasoning>(.*?)<\/reasoning>/s);
                        if (rMatch && callbacks.onReasoning)
                            await callbacks.onReasoning(token);
                        // Look for robust triggers indicating code is about to start
                        const fpMatch = buffer.match(/<filepath>(.*?)<\/filepath>/s);
                        const acMatch = buffer.match(/<action>(.*?)<\/action>/s);
                        const targetMatch = buffer.match(/<target>(.*?)<\/target>/s);
                        // Tolerate ANY code block trigger (```, ```javascript, <code>)
                        const codeStartIdx = Math.max(buffer.lastIndexOf('```'), buffer.lastIndexOf('<code>'));
                        if (fpMatch && acMatch && codeStartIdx !== -1) {
                            const filepath = fpMatch[1].trim();
                            const action = acMatch[1].trim().toLowerCase();
                            const target = targetMatch ? targetMatch[1].trim() : undefined;
                            await callbacks.onSetup(action, filepath, target);
                            // Slice off everything before the code block
                            const newLineAfterCodeStart = buffer.indexOf('\n', codeStartIdx);
                            buffer = newLineAfterCodeStart !== -1 ? buffer.substring(newLineAfterCodeStart + 1) : "";
                            isStreamingCode = true;
                        }
                    }
                    else {
                        // Streaming actual code
                        const codeEndIdx = Math.max(buffer.lastIndexOf('```'), buffer.lastIndexOf('</code'));
                        if (codeEndIdx !== -1) {
                            // Code block finished
                            const finalCodeChunk = buffer.substring(0, codeEndIdx);
                            if (finalCodeChunk)
                                await callbacks.onToken(finalCodeChunk);
                            if (callbacks.onFileComplete)
                                await callbacks.onFileComplete();
                            // Reset state to catch the NEXT file in the stream!
                            isStreamingCode = false;
                            buffer = buffer.substring(codeEndIdx + 3);
                        }
                        else {
                            // Safe emission window (prevent splitting closing tags)
                            if (buffer.length > 10) {
                                const emitChunk = buffer.substring(0, buffer.length - 10);
                                await callbacks.onToken(emitChunk);
                                buffer = buffer.substring(buffer.length - 10);
                            }
                        }
                    }
                }
                catch (e) { } // Ignore JSON cuts
            }
        }
    }
    // Flush remaining code buffer
    if (isStreamingCode && buffer.length > 0) {
        const cleanEnd = buffer.replace(/```$/, '').replace(/<\/code>$/, '');
        await callbacks.onToken(cleanEnd);
        if (callbacks.onFileComplete)
            await callbacks.onFileComplete();
    }
}
/**
 * Fetches available models dynamically from the LM Studio / API endpoint.
 */
async function getAvailableModels() {
    const config = vscode.workspace.getConfiguration('nexuscode');
    // Check if the user manually overrode it in settings, otherwise enforce the fixed model
    const fixedModel = config.get('model') || 'qwen2.5-coder';
    return [fixedModel];
}
//# sourceMappingURL=llmService.js.map