import * as vscode from 'vscode';
import { LLMService } from './LLMService';
import { EditorManager } from './EditorManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private llmService = new LLMService();
    private editorManager = new EditorManager();

    constructor(private readonly extensionUri: vscode.Uri) {}

    private getWebviewContent(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'webview.js')
        );
        const toolkitUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.js')
        );
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'index.css')
        );

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource};">
                <link rel="stylesheet" href="${cssUri}">
                <script type="module" src="${toolkitUri}"></script>
            </head>
            <body>
                <div id="root"></div>
                <script type="module" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webviewView.webview.html = this.getWebviewContent(webviewView.webview);

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
}