import * as vscode from 'vscode';
import { LLMService } from './LLMService';
import { EditorManager } from './EditorManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private llmService = new LLMService();
    private editorManager = new EditorManager();

    constructor(private readonly extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'prompt':
                    // Send to Editor
                    await this.llmService.streamResponse(data.value, (chunk) => {
                        this.editorManager.insertStreamedText(chunk);
                        webviewView.webview.postMessage({ type: 'chunk', value: chunk });
                    });
                    break;
                case 'stop':
                    this.llmService.stopStream();
                    break;
                case 'accept':
                    this.editorManager.clearHighlighting();
                    break;
            }
        });
    }

    private getHtmlContent(): string {
        // In a true production app, this HTML string is replaced by a compiled React/Vite bundle.
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <style>
                    body { font-family: var(--vscode-font-family); padding: 10px; }
                    textarea { width: 100%; height: 80px; margin-bottom: 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px; cursor: pointer; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    #chat-log { margin-top: 15px; white-space: pre-wrap; font-family: monospace;}
                </style>
            </head>
            <body>
                <textarea id="prompt" placeholder="Ask the AI to generate code..."></textarea>
                <button id="send">Send</button>
                <button id="stop">Stop</button>
                <button id="accept">Accept Code</button>
                <div id="chat-log"></div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const log = document.getElementById('chat-log');

                    document.getElementById('send').addEventListener('click', () => {
                        log.innerText = '';
                        vscode.postMessage({ type: 'prompt', value: document.getElementById('prompt').value });
                    });

                    document.getElementById('stop').addEventListener('click', () => {
                        vscode.postMessage({ type: 'stop' });
                    });

                    document.getElementById('accept').addEventListener('click', () => {
                        vscode.postMessage({ type: 'accept' });
                    });

                    window.addEventListener('message', event => {
                        if (event.data.type === 'chunk') {
                            log.innerText += event.data.value;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}