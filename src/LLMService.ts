import * as vscode from 'vscode';

export class LLMService {
    private abortController: AbortController | null = null;

    public async streamResponse(prompt: string, onChunk: (text: string) => void) {
        this.abortController = new AbortController();
        const config = vscode.workspace.getConfiguration('localLlm');
        const endpoint = config.get<string>('endpoint')!;
        const style = config.get<string>('codingStyle')!;

        const systemPrompt = `You are an expert developer. Output code only. Follow this style: ${style}`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: "local-model",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt }
                    ],
                    stream: true
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (!response.body) throw new Error("No response body");

            // Web Streams API (Node 18+)
            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ""; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.trim() === "" || line.startsWith(":")) continue;
                    if (line.startsWith("data: ")) {
                        const data = line.slice(6);
                        if (data === "[DONE]") return;
                        
                        try {
                            const parsed = JSON.parse(data);
                            const chunk = parsed.choices[0]?.delta?.content || "";
                            if (chunk) onChunk(chunk);
                        } catch (e) {
                            console.error("Parse error:", e);
                        }
                    }
                }
            }
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                vscode.window.showErrorMessage(`LLM Error: ${err.message}`);
            }
        }
    }

    public stopStream() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }
}