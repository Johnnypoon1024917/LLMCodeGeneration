// src/engine/AgenticLoop.ts (Updated for Sprint 2)
import { ToolParser } from './ToolParser';
import { ToolRegistry } from './ToolRegistry';
import { Message, LocalLLMClient, AgentEvent } from './types';

export class AgenticLoop {
    private contextHistory: Message[] = [];
    private readonly MAX_RECURSION = 10;
    private toolRegistry: ToolRegistry;

    // Inject the telemetry callback to talk to the React Webview
    constructor(
        private qwenClient: LocalLLMClient, 
        private workspacePath: string,
        private emitEvent: (event: AgentEvent) => void 
    ) {
        this.toolRegistry = new ToolRegistry(this.workspacePath);
    }

    async run(userPrompt: string): Promise<void> {
        this.contextHistory.push({ role: 'user', content: userPrompt });
        this.emitEvent({ type: 'state_change', state: 'thinking' });

        let recursionCount = 0;

        while (recursionCount < this.MAX_RECURSION) {
            recursionCount++;
            
            // Note: In production, qwenClient.generate should yield tokens via a stream 
            // so we can emit 'text_chunk' events here for a typewriter effect.
            const response = await this.qwenClient.generate(this.contextHistory);
            this.contextHistory.push({ role: 'assistant', content: response });

            const toolCall = ToolParser.extractDefensively(response);

            if (!toolCall) {
                // Agent is just talking to the user
                this.emitEvent({ type: 'text_chunk', content: response });
                this.emitEvent({ type: 'state_change', state: 'idle' });
                break; 
            }

            if (toolCall.isMalformed) {
                this.contextHistory.push({
                    role: 'system',
                    content: `ERROR: ${toolCall.parseError}. Fix syntax.`
                });
                continue; 
            }

            // TELEMETRY: Inform UI that a tool is running
            this.emitEvent({ type: 'state_change', state: 'executing' });
            this.emitEvent({ type: 'tool_start', toolName: toolCall.toolName, params: toolCall.parameters });
            
            const toolResult = await this.toolRegistry.execute(toolCall.toolName, toolCall.parameters);
            
            // TELEMETRY: Inform UI of completion
            this.emitEvent({ type: 'tool_end', toolName: toolCall.toolName, result: toolResult });
            
            this.contextHistory.push({
                role: 'system',
                content: `Tool '${toolCall.toolName}' Result:\n${toolResult}`
            });

            // If the agent edited a file, trigger the native VS Code Diff view
            if (toolCall.toolName === 'edit_file') {
                this.emitEvent({ type: 'diff_ready', filePath: toolCall.parameters.file });
                // We pause the loop here and wait for the user to Approve/Reject the diff
                this.emitEvent({ type: 'state_change', state: 'awaiting_user' });
                break; 
            }
        }
    }
}