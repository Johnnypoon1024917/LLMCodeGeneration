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
function getLLMConfig() {
    const config = vscode.workspace.getConfiguration('nexuscode');
    return {
        endpoint: config.get('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get('model') || 'qwen2.5-coder', // 🔥 Fixed default to qwen2.5-coder
        apiKey: config.get('apiKey') || 'lm-studio',
        enableTools: config.get('enableTools') || false
    };
}
function safeParseJSON(jsonString) {
    try {
        const start = jsonString.indexOf('{');
        const end = jsonString.lastIndexOf('}');
        if (start === -1 || end === -1)
            throw new Error("No JSON object found");
        const extract = jsonString.substring(start, end + 1)
            .replace(/\/\/.*$/gm, '')
            .replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(extract);
    }
    catch (e) {
        let msg = "Unknown error";
        if (e instanceof Error)
            msg = e.message;
        else if (typeof e === "string")
            msg = e;
        throw new Error("Failed to extract JSON: " + msg);
    }
}
async function askQwenForStructure(prompt, projectContext) {
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
    const data = await response.json();
    // 1. Existing error check
    if (data.error)
        throw new Error(`LLM API Error: ${data.error.message}`);
    // 2. 🔥 NEW DEFENSIVE CHECK: Make sure 'choices' exists before reading it!
    if (!data.choices || data.choices.length === 0) {
        throw new Error(`Invalid response from LLM API. Make sure your model is loaded and running. Raw response: ${JSON.stringify(data).substring(0, 150)}`);
    }
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
async function askQwenForTargetFile(taskDescription, projectContext, lastActiveFile) {
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
    const data = await response.json();
    if (data.error)
        throw new Error(`API Error: ${data.error.message}`);
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
async function runAgenticExploration(taskDescription, workspaceRoot, statusCallback) {
    const { endpoint, model, apiKey } = getLLMConfig();
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
    for (let step = 0; step < 5; step++) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: model, messages: messages, tools: agentTools_1.agentToolDefinitions, tool_choice: "auto", temperature: 0.1 })
        });
        const data = await response.json();
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
                const toolResult = await (0, agentTools_1.executeAgentTool)(toolCall, workspaceRoot);
                gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
            }
        }
        else {
            if (aiMessage.content && aiMessage.content.includes("READY_TO_CODE")) {
                statusCallback("💡 Context gathered. Ready to code.");
                break;
            }
            else
                break;
        }
    }
    return gatheredContext;
}
async function askQwenForTests(fileName, fileContent) {
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
    const data = await response.json();
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
async function askQwenToFixError(errorOutput, sourceFilePath, sourceCode, testFilePath, testCode) {
    const systemPrompt = `You are an expert debugger. Determine if the error is in the source code OR the test code. Fix ONLY the file causing the error.
    Respond with valid XML: <filepath>path/to/file</filepath> <code>...</code>`;
    const userPrompt = `Source: ${sourceFilePath}\n\`\`\`\n${sourceCode}\n\`\`\`\nTest: ${testFilePath}\n\`\`\`\n${testCode}\n\`\`\`\nError:\n\`\`\`\n${errorOutput}\n\`\`\``;
    const { endpoint, model, apiKey } = getLLMConfig();
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
    const data = await response.json();
    const content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON(content);
}
// Replace ONLY the streamQwenForCode function in src/llmService.ts
async function streamQwenForCode(taskDescription, availableFiles = [], currentFileContent = "", codingStyle = "precise", chatHistory = [], callbacks) {
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
    if (!response.body)
        throw new Error("No readable stream available.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    // 🔥 NEW: 4-Stage State Machine for intercepting the Reasoning Stream
    let state = "SEARCHING_REASONING";
    let buffer = "";
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
                    // STAGE 1: Wait for <reasoning>
                    if (state === "SEARCHING_REASONING") {
                        const rStart = buffer.indexOf('<reasoning>');
                        if (rStart !== -1) {
                            state = "STREAMING_REASONING";
                            buffer = buffer.substring(rStart + 11);
                        }
                        else if (buffer.includes('<filepath>') || buffer.includes('```') || buffer.includes('<code>')) {
                            state = "SEARCHING_SETUP"; // AI skipped reasoning, proceed to code
                        }
                    }
                    // STAGE 2: Stream Reasoning to UI
                    if (state === "STREAMING_REASONING") {
                        const rEnd = buffer.indexOf('</reasoning>');
                        if (rEnd !== -1) {
                            const chunk = buffer.substring(0, rEnd);
                            if (chunk && callbacks.onReasoning)
                                await callbacks.onReasoning(chunk);
                            state = "SEARCHING_SETUP";
                            buffer = buffer.substring(rEnd + 12);
                        }
                        else {
                            if (buffer.length > 15) { // 15 char lookahead to prevent emitting closing tag
                                const chunk = buffer.substring(0, buffer.length - 15);
                                if (callbacks.onReasoning)
                                    await callbacks.onReasoning(chunk);
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
                            if (chunk)
                                await callbacks.onToken(chunk);
                            break; // Stream finished perfectly
                        }
                        else {
                            if (buffer.length > 7) {
                                const chunk = buffer.substring(0, buffer.length - 7);
                                await callbacks.onToken(chunk);
                                buffer = buffer.substring(buffer.length - 7);
                            }
                        }
                    }
                }
                catch (e) { }
            }
        }
        if (state === "STREAMING_CODE" && buffer.includes('</code'))
            break;
    }
    // Flush remaining code buffer if stream broke unexpectedly
    if (state === "STREAMING_CODE" && buffer.length > 0)
        await callbacks.onToken(buffer);
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