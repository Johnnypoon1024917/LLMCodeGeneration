export async function askQwenForStructure(prompt: string) {
    const systemPrompt = `You are an expert AI architect. Break down the user's high-level request into a structured JSON format. 
    You must reply ONLY with valid JSON matching this schema: 
    { "folderStructure": ["path/to/file1.ts"], "implementationTasks": ["Step 1 description", "Step 2 description"] }`;

    const response = await fetch('http://192.168.192.199:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: "/home/Qwen/Qwen2.5-72B-Instruct-AWQ/",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.1 
        })
    });

    const data = await response.json();
    let content = data.choices[0].message.content;

    // FIX: Strip out markdown code blocks that Qwen might add
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
        return JSON.parse(content);
    } catch (e) {
        console.error("Failed to parse LLM JSON", content);
        // Fallback so it doesn't crash the UI
        return { folderStructure: [], implementationTasks: ["Error: Qwen did not return valid JSON."] };
    }
}
// src/llmService.ts

export async function askQwenForCode(
    taskDescription: string, 
    availableFiles: string[] = [],
    currentFileContent: string = "", // NEW: Pass the current file state!
    codingStyle: string = "precise"
): Promise<{filepath: string, code: string}> {
    
    let styleInstructions = "";
    if (codingStyle === "precise") {
        styleInstructions = "Write highly optimized, concise code. Do NOT include redundant comments. Only comment on highly complex regex or math.";
    } else if (codingStyle === "commented") {
        styleInstructions = "Write highly readable code. You MUST include JSDoc/Docstring headers for every function, and inline comments explaining the 'why' behind complex logic.";
    } else if (codingStyle === "analytical") {
        styleInstructions = "Think step-by-step. Focus heavily on edge cases, error handling, and robust typing. Prioritize security and stability over brevity.";
    }

    const systemPrompt = `You are an expert autonomous coding agent. 
    You have access to these files: [ ${availableFiles.join(', ')} ]
    
    Based on the task, choose the EXACT correct file path and write the code.
    
    CODING STYLE DIRECTIVE:
    ${styleInstructions}
    
    CRITICAL RULES:
    1. Output your response EXACTLY using the XML tags below. Do not use JSON.
    2. Inside the <code> tag, you MUST output the ENTIRE updated content of the file.
    
    <filepath>path/to/file.ts</filepath>
    <code>
    [ENTIRE FULL FILE CODE HERE]
    </code>`;

    // Give Qwen the existing code so it knows what to modify!
    const userPrompt = currentFileContent.trim() 
        ? `Task: ${taskDescription}\n\nCurrent file content:\n\`\`\`\n${currentFileContent}\n\`\`\``
        : `Task: ${taskDescription}\n\n(The file is currently empty)`;

    const response = await fetch('http://192.168.192.199:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: "/home/Qwen/Qwen2.5-72B-Instruct-AWQ/",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1 
        })
    });

    const data = await response.json();
    let content = data.choices[0].message.content;
    
    const filepathMatch = content.match(/<filepath>(.*?)<\/filepath>/s);
    const codeMatch = content.match(/<code>(.*?)<\/code>/s);

    if (!filepathMatch || !codeMatch) {
        console.error("Failed to parse LLM output:", content);
        throw new Error("Qwen did not return the expected <filepath> and <code> tags.");
    }

    let extractedCode = codeMatch[1].trim();
    extractedCode = extractedCode.replace(/^```[\w]*\n/, '').replace(/\n```$/, '').trim();

    return {
        filepath: filepathMatch[1].trim(),
        code: extractedCode
    };
}