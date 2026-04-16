// src/engine/ToolParser.ts
export interface ParsedToolCall {
    toolName: string;
    parameters: Record<string, string>;
    rawText: string;
    isMalformed: boolean;
    parseError?: string;
}

export class ToolParser {
    /**
     * Parses output looking for strict XML blocks, e.g.,
     * <invoke name="read_file">
     * <path>src/main.ts</path>
     * </invoke>
     */
    static extractDefensively(llmResponse: string): ParsedToolCall | null {
        const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/i;
        const match = llmResponse.match(invokeRegex);

        if (!match) return null; // No tool called, assume normal text response

        const toolName = match[1];
        const paramString = match[2];
        const parameters: Record<string, string> = {};

        // Extract internal tags as parameters
        const paramRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
        let paramMatch;
        
        try {
            while ((paramMatch = paramRegex.exec(paramString)) !== null) {
                parameters[paramMatch[1]] = paramMatch[2].trim();
            }
            return { toolName, parameters, rawText: match[0], isMalformed: false };
        } catch (error) {
             return { 
                 toolName, 
                 parameters: {}, 
                 rawText: match[0], 
                 isMalformed: true, 
                 parseError: "Unclosed XML parameter tags detected." 
             };
        }
    }
}