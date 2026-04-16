// src/engine/types.ts

export type AgentEvent = 
    | { type: 'text_chunk'; content: string }
    | { type: 'tool_start'; toolName: string; params: Record<string, string> }
    | { type: 'tool_end'; toolName: string; result: string }
    | { type: 'state_change'; state: 'idle' | 'thinking' | 'executing' | 'awaiting_user' }
    | { type: 'diff_ready'; filePath: string }; // Crucial for Government QA

export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface ToolResult {
    success: boolean;
    output: string;
}

export interface LocalLLMClient {
    generate(history: Message[]): Promise<string>;
}