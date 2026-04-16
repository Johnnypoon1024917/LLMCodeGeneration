// src/llm/api.ts
import * as vscode from 'vscode';
import { globalContext } from '../extension';

export async function getLLMConfig() {
    const config = vscode.workspace.getConfiguration('nexuscode');
    const secureKey = await globalContext.secrets.get('nexuscode_apikey');

    return {
        endpoint: config.get<string>('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions',
        model: config.get<string>('model') || 'qwen2.5-coder',
        apiKey: secureKey || config.get<string>('apiKey') || 'lm-studio',
        enableTools: config.get<boolean>('enableTools') || false
    };
}