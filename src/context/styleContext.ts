// src/context/styleContext.ts
import * as vscode from 'vscode';

export async function getProjectStyleGuides(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return "";

    const rootUri = workspaceFolders[0].uri;
    let styleRules: string[] = [];

    // 1. Check for ESLint
    try {
        const eslintUri = vscode.Uri.joinPath(rootUri, '.eslintrc.json');
        const eslintData = await vscode.workspace.fs.readFile(eslintUri);
        const eslintConfig = JSON.parse(new TextDecoder().decode(eslintData));
        
        if (eslintConfig.rules) {
            const rules = Object.keys(eslintConfig.rules).slice(0, 5).join(', ');
            styleRules.push(`ESLint Rules Active: ${rules}`);
        }
        // Check for specific formatting rules
        if (eslintConfig.rules?.['indent']) styleRules.push(`Indentation: ${JSON.stringify(eslintConfig.rules['indent'])}`);
        if (eslintConfig.rules?.['quotes']) styleRules.push(`Quotes: ${JSON.stringify(eslintConfig.rules['quotes'])}`);
    } catch { /* No ESLint found, ignore */ }

    // 2. Check for TSConfig
    try {
        const tsconfigUri = vscode.Uri.joinPath(rootUri, 'tsconfig.json');
        const tsData = await vscode.workspace.fs.readFile(tsconfigUri);
        // Basic JSON parse (might fail if comments exist, but good enough for MVP)
        const tsConfig = JSON.parse(new TextDecoder().decode(tsData));
        
        if (tsConfig.compilerOptions) {
            if (tsConfig.compilerOptions.strict) styleRules.push("TypeScript Strict Mode: ON (No 'any' type allowed)");
            if (tsConfig.compilerOptions.noImplicitAny) styleRules.push("No Implicit Any: ON");
        }
    } catch { /* No TSConfig found */ }

    // 3. Check for Python (pyproject.toml)
    try {
        const pyUri = vscode.Uri.joinPath(rootUri, 'pyproject.toml');
        const pyData = await vscode.workspace.fs.readFile(pyUri);
        const pyText = new TextDecoder().decode(pyData);
        if (pyText.includes('tool.black')) styleRules.push("Python Formatter: Black (88 chars line limit)");
    } catch { /* No pyproject found */ }

    if (styleRules.length === 0) return "";

    return `\n\n[PROJECT STYLE GUIDE]\nCompliance is mandatory:\n- ${styleRules.join('\n- ')}`;
}