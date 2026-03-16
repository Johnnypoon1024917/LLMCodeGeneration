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
    // Replace standard named entities
    let decoded = text.replace(/&[a-z0-9]+;/gi, (match) => entities[match] || match);

    // Replace numeric entities (e.g., &#10;) if they appear
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));

    return decoded;
}

function getLLMConfig() {
    const config = vscode.workspace.getConfiguration('nexuscode');
    return {
        endpoint: config.get<string>('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get<string>('model') || 'qwen-72b',
        apiKey: config.get<string>('apiKey') || 'lm-studio',
        enableTools : config.get<boolean>('enableTools') || false
    };
}

function safeParseJSON<T>(jsonString: string): T {
    try {
        // Find the start and end of the JSON object
        const start = jsonString.indexOf('{');
        const end = jsonString.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error("No JSON object found");
        
        const extract = jsonString.substring(start, end + 1)
            .replace(/\/\/.*$/gm, '') // Remove comments
            .replace(/,\s*([\]}])/g, '$1'); // Remove trailing commas
            
        return JSON.parse(extract);
    } catch (e: unknown) {
        let msg = "Unknown error";
        if (e instanceof Error) {
            msg = e.message;
        } else if (typeof e === "string") {
            msg = e;
        }
        throw new Error("Failed to extract JSON: " + msg);
    }
}

export interface AIPlan {
    folderStructure: string[];
    implementationTasks: string[];
}

export interface TestSetupPlan {
    installCommand: string;
    testCommand: string;
    filepath: string;
    code: string;
}

interface QwenResponse {
    choices: {
        message: {
            content: string;
        };
    }[];
}

interface ChatMessage {
    role: string;
    content?: string;
    plan?: {
        folderStructure: string[];
        implementationTasks: string[];
    };
}

export interface AtomicEdit {
    filepath: string;
    code: string;
    action: 'replace' | 'append';
}

export async function askQwenForStructure(
    prompt: string,
    projectContext: string
): Promise<AIPlan> {

    const systemPrompt = `You are an expert AI software architect.
    Analyze the user's request and the EXISTING DIRECTORY STRUCTURE provided below.
    
    CRITICAL RULES FOR PATHS:
    1. ADAPT to the existing folder structure. If "src/components" exists, place new components there.
    2. DO NOT use generic placeholders. Use real, semantic names.
    3. **IMPORTANT:** In "folderStructure", you MUST list EVERY file that needs to be created OR modified.
       - Even if the file already exists, list it here so we know you plan to edit it.
       - If you are unsure of the exact path, make your best guess based on the file tree.
       
    🔥 4. ATOMIC TASKS (ONE TASK PER FILE): 🔥
    You MUST break down "implementationTasks" so that EACH task targets exactly ONE file. 
    NEVER group multiple files into a single task! 
    - BAD: "Create FlightCard, HotelCard, and CarRentalCard components"
    - GOOD: 
        Task 1: "Create FlightCard component in src/components/FlightCard.tsx"
        Task 2: "Create HotelCard component in src/components/HotelCard.tsx"
        Task 3: "Create CarRentalCard component in src/components/CarRentalCard.tsx"

    Reply ONLY with valid JSON matching this schema: 
    { 
        "folderStructure": ["src/actual/folder/realFile.ts"], 
        "implementationTasks": ["Step 1 description", "Step 2 description"] 
    }`;

    const { endpoint, model, apiKey } = getLLMConfig();

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    if (data.error) {
        throw new Error(`LLM API Error: ${data.error.message}`);
    }
    if (!data.choices || data.choices.length === 0) {
        throw new Error("LLM returned an empty or invalid response.");
    }
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
        return safeParseJSON<AIPlan>(content);
    } catch (e) {
        console.error("Failed to parse LLM JSON", content);
        return { folderStructure: [], implementationTasks: ["Error: Qwen returned invalid JSON."] };
    }
}

export async function askQwenForTargetFile(
    taskDescription: string,
    projectContext: string,
    lastActiveFile?: string // <--- NEW PARAMETER
): Promise<{ filepath: string, reasoning: string }> {

    // We explicitly tell Qwen where we were just working
    const contextHint = lastActiveFile
        ? `CONTEXT: You just modified "${lastActiveFile}". Unless the task explicitly mentions a DIFFERENT file/module, you MUST continue working on "${lastActiveFile}".`
        : "";

    const systemPrompt = `You are a Senior Software Architect. 
    Analyze the project directory and the task.
    Decide exactly ONE file that needs to be reviewed, modified, or created.
    
    ${contextHint}

    CRITICAL RULES:
    1. If the task is a continuation (e.g., "add method", "implement logic"), USE THE SAME FILE as the previous step.
    2. Only switch files if the task clearly says "Update App.tsx" or "Create new utils.ts".
    3. Return ONLY valid JSON.

    Format:
    {
        "filepath": "src/algorithms/aStar.ts",
        "reasoning": "Continuing implementation of A* class in the active file."
    }`;

    const { endpoint, model, apiKey } = getLLMConfig();

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Directory Structure:\n${projectContext}\n\nTask: ${taskDescription}` }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
   if (data.object === "error" || data.error) {
        const errorMsg = data.message || data.error?.message || "Unknown API Error";
        throw new Error(`API Error: ${errorMsg}`);
    }
    
    if (!data.choices || data.choices.length === 0) {
        throw new Error(`Invalid Response. Raw Data: ${JSON.stringify(data).substring(0, 250)}`);
    }
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<{ filepath: string, reasoning: string }>(content);
}

export async function askQwenForCode(
    taskDescription: string,
    availableFiles: string[] = [],
    currentFileContent: string = "", // NEW: Pass the current file state!
    codingStyle: string = "precise",
    chatHistory: ChatMessage[] = [] // NEW: Accept history
): Promise<{ filepath: string, action: string, code: string, command?: string, target?: string }> {

    let styleInstructions = "";
    if (codingStyle === "precise") {
        styleInstructions = "Write highly optimized, concise code. Do NOT include redundant comments. Only comment on highly complex regex or math.";
    } else if (codingStyle === "commented") {
        styleInstructions = "Write highly readable code. You MUST include JSDoc/Docstring headers for every function, and inline comments explaining the 'why' behind complex logic.";
    } else if (codingStyle === "analytical") {
        styleInstructions = "Think step-by-step. Focus heavily on edge cases, error handling, and robust typing. Prioritize security and stability over brevity.";
    }

    const systemPrompt = `You are an expert autonomous coding agent capable of working in ANY programming language (Python, TypeScript, Rust, Go, PHP, etc.).
    
    You have access to these files: [ ${availableFiles.join(', ')} ]
    
    Based on the task, choose the EXACT correct file path and write the code.

    CRITICAL RULE: SINGLE-FILE MODE
    You are executing a single-file edit. You MUST output exactly ONE <filepath>, ONE <action>, and ONE <code> block. 
    Do NOT generate code for multiple files in a single response. If the task requires multiple files, only generate the primary target file requested.

    CRITICAL: CROSS-FILE CONSISTENCY
    1. You are provided with "REPOSITORY CODEBASE CONTEXT". You MUST analyze this context to find existing class names (in CSS/TSX), variable names, and architectural patterns.
    2. Do NOT invent new CSS classes if the task involves existing UI components. Match the styles used in the .tsx files.
    3. Ensure imports in the target file match the exports found in the context.
    
    CODING STYLE DIRECTIVE:
    ${styleInstructions}
    
    CRITICAL RULES FOR "ACTION" TAG:
    1. <action>append</action>: Use this when adding NEW code (like a new class or function) to the bottom of the file. Output ONLY the new code snippet.
    2. <action>replace</action>: Use this when you need to rewrite the file or change existing lines. You MUST output the FULL, updated file content.
    3. <action>inject</action>: Use this to insert a specific method, field, or function INSIDE an existing Class or Module. 
       - You MUST include a <target> tag with the exact name of the Class, Interface, or Function you are modifying.
       - Output ONLY the code snippet to be injected (e.g., the new method).

    PREFERENCE: If the EXISTING FILE CONTENT is provided and is long, PRIORITIZE 'append' or 'inject' to save tokens.

    TERMINAL COMMANDS:
    If the code you wrote requires a terminal command to initialize the project or install dependencies, provide it in a <command> tag.
    
    Select the correct tool for the language:
    - Node/JS: <command>npm install</command> or <command>npm init -y</command>
    - Python:  <command>pip install -r requirements.txt</command> or <command>python -m venv venv</command>
    - Go:      <command>go mod tidy</command>
    - Rust:    <command>cargo build</command>
    - PHP:     <command>composer install</command>
    
    XML FORMAT:
    <filepath>path/to/file.ext</filepath>
    <action>append | replace</action>
    <code>
    ... code here ...
    </code>
    <command>shell command here</command> `;

    // Give Qwen the existing code so it knows what to modify!
    const userPrompt = currentFileContent.trim()
        ? `Task: ${taskDescription}\n\nEXISTING FILE CONTENT:\n\`\`\`\n${currentFileContent}\n\`\`\`\n\n(Decide: Should I 'append' new code to the end, or 'replace' the file to fix logic?)`
        : `Task: ${taskDescription}\n\n(The file is currently empty, so action must be 'replace')`;

    // Map the React chat history into Qwen's expected format
    const formattedHistory = chatHistory.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.plan
            ? `Proposed implementation plan with ${msg.plan.implementationTasks.length} tasks.`
            : (msg.content || "Executed a plan.")
    }));

    const { endpoint, model, apiKey } = getLLMConfig();

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                ...formattedHistory, // Inject previous conversation context
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    if (data.object === "error" || data.error) {
        const errorMsg = data.message || data.error?.message || "Unknown API Error";
        throw new Error(`API Error: ${errorMsg}`);
    }
    
    if (!data.choices || data.choices.length === 0) {
        throw new Error(`Invalid Response. Raw Data: ${JSON.stringify(data).substring(0, 250)}`);
    }

    let content = data.choices[0].message.content;

    // =========================================================
    // 🔥 NEW: DUMP THE RAW LLM RESPONSE TO THE CONSOLE
    // =========================================================
    console.log("\n\n=============== 🤖 RAW LLM RESPONSE (START) ===============");
    console.log(content);
    console.log("=============== 🤖 RAW LLM RESPONSE (END) ===============\n\n");
    // =========================================================


    // 1. Identify what file we actually requested (passed in from SidebarProvider)
    const targetFileMatch = currentFileContent.match(/Target File:\s*([^\n]+)/);
    const expectedTarget = targetFileMatch ? targetFileMatch[1].trim() : "";
    const expectedFileName = expectedTarget.split(/[\/\\]/).pop() || "";

    // 2. Split the LLM response into isolated chunks, separating at each <filepath> tag
    const chunks: string[] = content.split(/(?=<filepath>)/).filter((c: string) => c.trim().length > 0);

    let selectedChunk = chunks[0]; // Default to the first chunk

    // 3. If it generated multiple files, actively search for the one we asked for
    if (chunks.length > 1 && expectedFileName) {
        console.log(`[CodeGen] Detected ${chunks.length} files in response. Searching for ${expectedFileName}...`);
        
        const matchedChunk = chunks.find((chunk: string) => {
            const fp = chunk.match(/<filepath>(.*?)<\/filepath>/s)?.[1]?.trim() || "";
            return fp.includes(expectedFileName);
        });

        if (matchedChunk) {
            selectedChunk = matchedChunk;
            console.log(`[CodeGen] ✅ Successfully isolated the chunk for: ${expectedFileName}`);
        } else {
            console.log(`[CodeGen] ⚠️ Target not found in chunks, falling back to first chunk.`);
        }
    }



    let filepath = content.match(/<filepath>(.*?)<\/filepath>/s)?.[1]?.trim();
    let action = content.match(/<action>(.*?)<\/action>/s)?.[1]?.trim().toLowerCase() || 'replace';
    let target = content.match(/<target>(.*?)<\/target>/s)?.[1]?.trim();
    let command = content.match(/<command>(.*?)<\/command>/s)?.[1]?.trim();

    let extractedCode = "";
    const codeTagMatch = content.match(/<code>(.*?)<\/code>/s);

    if (codeTagMatch) {
        extractedCode = codeTagMatch[1].trim();
    } else {
        // Fallback to searching for ANY markdown code block
        const markdownMatch = content.match(/```[\w]*\n([\s\S]*?)\n```/);
        extractedCode = markdownMatch ? markdownMatch[1].trim() : content.trim();
    }

    // 3. FALLBACK: If filepath tag is missing, try to guess from the text
    if (!filepath) {
        // Look for a line that looks like a path (e.g., webview-ui/src/App.css)
        const pathMatch = content.match(/([a-zA-Z0-9._\-\/]+\.[a-zA-Z0-9]+)/);
        filepath = pathMatch ? pathMatch[1] : "unknown_file";
    }

    extractedCode = decodeHTMLEntities(extractedCode);
    extractedCode = extractedCode.replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();

    return {
        filepath: filepath,
        action: action,
        code: extractedCode,
        command: command,
        target: target
    };
}

export async function askQwenForTests(fileName: string, fileContent: string): Promise<TestSetupPlan> {
    const systemPrompt = `You are an expert QA Engineer. Analyze the provided code and generate a comprehensive unit test file.
    Determine the best standard framework based on the language (e.g., PyTest for Python, Jest for JavaScript).
    
    CRITICAL RULES:
    1. "testCommand" MUST explicitly target the "filepath" you provide to ensure the test runner finds it.
    2. "filepath" MUST be a STRICTLY RELATIVE path (e.g., "tests/test_bfs.py"). DO NOT output absolute paths like "C:\\Users\\...".
    
    You MUST reply ONLY in valid JSON format:
    {
        "installCommand": "npm install --save-dev jest", 
        "testCommand": "npx jest tests/test_file.js", 
        "filepath": "tests/test_file.js",
        "code": "FULL_TEST_CODE_HERE"
    }`;
    const { endpoint, model, apiKey } = getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Target File: ${fileName}\n\nCode:\n\`\`\`\n${fileContent}\n\`\`\`` }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as QwenResponse;
    let content = data.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return safeParseJSON<TestSetupPlan>(content);
}


export async function runAgenticExploration(
    taskDescription: string,
    workspaceRoot: string,
    statusCallback: (message: string) => void
): Promise<string> {
    
    const { endpoint, model, apiKey } = getLLMConfig();

    let messages: any[] = [
        { 
            role: "system", 
            content: `You are an elite autonomous software architect. 
Your current goal is NOT to write the final code. Your goal is to EXPLORE the codebase to gather the exact context needed to solve the user's task.
Use your tools to read files and list directories. 
Once you have enough context to confidently write the code, reply with the exact word: "READY_TO_CODE" and nothing else.`
        },
        { role: "user", content: `Task: ${taskDescription}\nExplore the codebase to figure out how to do this.` }
    ];

    let gatheredContext = "";
    const MAX_STEPS = 5; // Prevent infinite loops

    for (let step = 0; step < MAX_STEPS; step++) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                tools: agentToolDefinitions,
                tool_choice: "auto",
                temperature: 0.1
            })
        });

        const data = await response.json() as any;
        console.log("[Agent Debug] RAW SERVER RESPONSE:", data);
        // 🔥 FIX: Catch API errors (like "Tools not supported") gracefully
        if (data.error) {
            const errMsg = data.error.message || JSON.stringify(data.error);
            console.error("[Agent Error] Server rejected the tool request:", errMsg);
            statusCallback(`⚠️ Agent API Error: Tools might not be supported. Proceeding without context...`);
            break; // Break the loop and fallback to standard coding
        }

        // 🔥 FIX: Ensure choices actually exist before reading them
        if (!data.choices || data.choices.length === 0) {
            console.error("[Agent Error] Invalid response format:", data);
            statusCallback(`⚠️ Agent Error: Unrecognized response format. Proceeding...`);
            break;
        }
        const aiMessage = data.choices[0].message;
        messages.push(aiMessage); // Save AI's response to history

        // Did the AI decide to use a tool?
        if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
            for (const toolCall of aiMessage.tool_calls) {
                const funcName = toolCall.function.name;
                const funcArgs = JSON.parse(toolCall.function.arguments);
                
                // Update the UI so the developer knows what the AI is thinking!
                const uiMsg = funcName === 'read_file' ? `Agent reading: ${funcArgs.filepath}...` : `Agent exploring: ${funcArgs.dirpath}...`;
                statusCallback(`🧠 ${uiMsg}`);
                
                // Execute the physical tool
                const toolResult = await executeAgentTool(toolCall, workspaceRoot);
                
                // Add the result back into the context memory
                gatheredContext += `\n--- Tool Result: ${funcName}(${JSON.stringify(funcArgs)}) ---\n${toolResult}\n`;
                
                // Hand the result back to the LLM
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: toolResult
                });
            }
        } else {
            // The AI didn't use a tool. Did it say it's ready?
            if (aiMessage.content && aiMessage.content.includes("READY_TO_CODE")) {
                statusCallback("💡 Context gathered. Ready to code.");
                break;
            } else {
                // Sometimes local LLMs forget to output the trigger word. We'll just break.
                break;
            }
        }
    }

    return gatheredContext;
}

export async function askQwenToFixError(
    errorOutput: string,
    sourceFilePath: string,
    sourceCode: string,
    testFilePath: string,
    testCode: string
): Promise<{ filepath: string, code: string }> {

    const systemPrompt = `You are an expert debugger. The test suite failed.
    Analyze the terminal error output. Determine if the error is caused by a bug in the source code OR a bug in the test code.
    Fix ONLY the file that is causing the error.
    
    You MUST respond with valid XML tags for the file you fixed:
    <filepath>path/to/the_file_you_fixed.py</filepath>
    <code>[FULL FIXED CODE HERE]</code>`;

    const userPrompt = `Source File (${sourceFilePath}):\n\`\`\`\n${sourceCode}\n\`\`\`
    
    Test File (${testFilePath}):\n\`\`\`\n${testCode}\n\`\`\`
    
    Terminal Error:\n\`\`\`\n${errorOutput}\n\`\`\`
    
    Fix the code to resolve this error.`;
    const { endpoint, model, apiKey } = getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    if (data.error) {
        throw new Error(`LLM API Error: ${data.error.message}`);
    }
    if (!data.choices || data.choices.length === 0) {
        throw new Error("LLM returned an empty or invalid response.");
    }
    let content = data.choices[0].message.content;

    const filepathMatch = content.match(/<filepath>(.*?)<\/filepath>/s);
    const codeMatch = content.match(/<code>(.*?)<\/code>/s);

    if (!filepathMatch || !codeMatch) {
        throw new Error("Auto-healer failed to return expected XML tags.");
    }

    let extractedCode = decodeHTMLEntities(codeMatch[1].trim());
    extractedCode = extractedCode.replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();

    return {
        filepath: filepathMatch[1].trim(),
        code: extractedCode
    };
}

export async function askQwenForAtomicEdits(
    tasks: string[],
    projectContext: string,
    codingStyle: string
): Promise<AtomicEdit[]> {
    const systemPrompt = `You are an expert developer. Process the following list of tasks and return a JSON array of edits.
    Ensure that code in one file (e.g., an export) matches the usage in another file (e.g., an import).
    
    Return ONLY a JSON array matching this schema:
    [
        { "filepath": "src/file1.ts", "code": "...", "action": "replace" },
        { "filepath": "src/file2.ts", "code": "...", "action": "append" }
    ]`;
    const { endpoint, model, apiKey } = getLLMConfig();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Tasks: ${tasks.join(', ')}\n\nContext:\n${projectContext}` }
            ],
            temperature: 0.1
        })
    });

    const data = await response.json() as any;
    if (data.error) {
        throw new Error(`LLM API Error: ${data.error.message}`);
    }
    if (!data.choices || data.choices.length === 0) {
        throw new Error("LLM returned an empty or invalid response.");
    }
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
        onSetup: (action: string, filepath: string, target?: string) => Promise<void>,
        onToken: (token: string) => Promise<void>
    }
): Promise<void> {

    const { endpoint, model, apiKey } = getLLMConfig(); 

    let styleInstructions = "Write highly optimized, concise code.";
    if (codingStyle === "commented") styleInstructions = "Write highly readable code with JSDoc headers.";
    if (codingStyle === "analytical") styleInstructions = "Think step-by-step. Focus heavily on edge cases.";

    const systemPrompt = `You are an expert autonomous coding agent capable of working in ANY programming language (Python, TypeScript, Rust, Go, PHP, etc.).
    
    You have access to these files: [ ${availableFiles.join(', ')} ]
    
    CRITICAL RULE: SINGLE-FILE MODE
    You are executing a single-file edit. You MUST output exactly ONE <filepath>, ONE <action>, and ONE <code> block. 

    CRITICAL: CROSS-FILE CONSISTENCY
    1. You are provided with "REPOSITORY CODEBASE CONTEXT". You MUST analyze this context.
    2. Do NOT invent new CSS classes if the task involves existing UI components.
    
    CODING STYLE DIRECTIVE:
    ${styleInstructions}
    
    CRITICAL RULES FOR "ACTION" TAG:
    1. <action>append</action>: Use this when adding NEW code. Output ONLY the new code snippet.
    2. <action>replace</action>: Use this when you need to rewrite the file.
    3. <action>inject</action>: Use this to insert a specific method INSIDE an existing Class or Module. 
       - You MUST include a <target> tag.

    🔥 XML FORMAT STRICT ORDER 🔥
    Because your output is being streamed live to the user's editor, you MUST output tags in this EXACT top-to-bottom order:
    <filepath>path/to/file.ext</filepath>
    <action>append | replace | inject</action>
    <target>ClassName (Only if inject)</target>
    <code>
    ... code here ...
    </code>
    <command>shell command here</command>`;

    const userPrompt = currentFileContent.trim()
        ? `Task: ${taskDescription}\n\nEXISTING FILE:\n\`\`\`\n${currentFileContent}\n\`\`\``
        : `Task: ${taskDescription}\n\n(File is empty, action must be 'replace')`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1,
            stream: true 
        })
    });

    if (!response.body) throw new Error("No readable stream available.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    let metadataBuffer = ""; 
    let codeBuffer = ""; // Safely holds characters to check for closing tags
    let isCodeBlockOpen = false;
    let setupComplete = false;

    // 🔥 THE SLIDING WINDOW STREAMING LOOP
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
                    
                    // PHASE 1: Collect metadata until we hit <code>
                    if (!setupComplete) {
                        metadataBuffer += token;
                        
                        if (metadataBuffer.includes('<code>')) {
                            let filepath = metadataBuffer.match(/<filepath>(.*?)<\/filepath>/s)?.[1]?.trim() || "unknown";
                            let action = metadataBuffer.match(/<action>(.*?)<\/action>/s)?.[1]?.trim().toLowerCase() || 'replace';
                            let target = metadataBuffer.match(/<target>(.*?)<\/target>/s)?.[1]?.trim();

                            await callbacks.onSetup(action, filepath, target);
                            
                            setupComplete = true;
                            isCodeBlockOpen = true;
                            
                            // Push any code that arrived in the same exact chunk into our codeBuffer
                            const codeStart = metadataBuffer.indexOf('<code>') + 6;
                            const leakedCode = metadataBuffer.substring(codeStart);
                            if (leakedCode) codeBuffer += leakedCode;
                        }
                    } 
                    // PHASE 2: Safely stream code into the buffer
                    else if (isCodeBlockOpen && token) {
                        codeBuffer += token;
                    }

                    // PHASE 3: The 7-Character Lookahead 
                    if (isCodeBlockOpen && codeBuffer.length > 0) {
                        // Watch for the closing tag or a fragmented partial closing tag
                        const closingTagIndex = codeBuffer.indexOf('</code');
                        
                        if (closingTagIndex !== -1) {
                            // The AI started closing the block! Emit everything before it and stop.
                            const safeToEmit = codeBuffer.substring(0, closingTagIndex);
                            if (safeToEmit) await callbacks.onToken(safeToEmit);
                            isCodeBlockOpen = false;
                            break; 
                        } else {
                            // Hold the last 7 characters back just in case they are building up to `</code`
                            if (codeBuffer.length > 7) {
                                const safeToEmit = codeBuffer.substring(0, codeBuffer.length - 7);
                                await callbacks.onToken(safeToEmit);
                                codeBuffer = codeBuffer.substring(codeBuffer.length - 7);
                            }
                        }
                    }
                } catch (e) { /* Ignore incomplete JSON chunks */ }
            }
        }
        if (!isCodeBlockOpen && setupComplete) break; 
    }

    // Catch-all: If the AI stream ended abruptly without properly closing the tag, flush the buffer
    if (isCodeBlockOpen && codeBuffer.length > 0) {
        await callbacks.onToken(codeBuffer);
    }
}