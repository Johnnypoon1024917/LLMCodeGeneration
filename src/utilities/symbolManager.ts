// src/utilities/symbolManager.ts (REPLACEMENT)
import * as vscode from 'vscode';

export async function getInjectionPosition(
    _extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    symbolName: string
): Promise<vscode.Position | null> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
    );
    if (!symbols) return null;

    const target = findSymbol(symbols, symbolName);
    if (!target) return null;

    // Insert just before the closing brace of the symbol body
    const endLine = target.range.end.line;
    const lineText = document.lineAt(endLine).text;
    const closingBraceCol = lineText.indexOf('}');
    if (closingBraceCol === -1) return new vscode.Position(endLine, 0);
    return new vscode.Position(endLine, closingBraceCol);
}

function findSymbol(symbols: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | null {
    for (const s of symbols) {
        if (s.name === name) return s;
        const child = findSymbol(s.children, name);
        if (child) return child;
    }
    return null;
}