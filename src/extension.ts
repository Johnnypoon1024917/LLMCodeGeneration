import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ChatViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('llm.chatView', provider)
    );
}

export function deactivate() {}