// src/utilities/symbolManager.ts
import * as vscode from 'vscode';

export async function injectCodeIntoSymbol(
    editor: vscode.TextEditor,
    symbolName: string,
    newCode: string
): Promise<boolean> {
    const document = editor.document;
    const text = document.getText();
    
    // 1. Find the symbol definition (e.g., "class MyClass" or "function myFunction")
    const symbolRegex = new RegExp(`(class|function|const|let|async)\\s+${symbolName}\\b`, 'g');
    const match = symbolRegex.exec(text);

    if (!match) {
        console.error(`Symbol ${symbolName} not found for injection.`);
        return false;
    }

    // 2. Find the starting brace of this symbol
    let openBraceIndex = text.indexOf('{', match.index);
    if (openBraceIndex === -1) return false;

    // 3. Brace Counting Logic: Find the matching closing brace
    let braceCount = 1;
    let i = openBraceIndex + 1;
    while (braceCount > 0 && i < text.length) {
        if (text[i] === '{') braceCount++;
        else if (text[i] === '}') braceCount--;
        i++;
    }

    // 4. Perform the Injection
    const closingBraceIndex = i - 1;
    const insertPosition = document.positionAt(closingBraceIndex);

    // Prepare the snippet with proper indentation
    const formattedCode = `\n    ${newCode.split('\n').join('\n    ')}\n`;

    return await editor.edit(editBuilder => {
        // We insert just BEFORE the final closing brace of the class/function
        editBuilder.insert(insertPosition, formattedCode);
    });
}