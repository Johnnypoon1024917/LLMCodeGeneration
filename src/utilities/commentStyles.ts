// src/utilities/commentStyles.ts
import * as path from 'path';

export function getAIHeader(filepath: string, taskName: string, existingContent: string = ""): string {
    const timestamp = new Date().toLocaleString();
    const extension = filepath.split('.').pop()?.toLowerCase() || "";
    const filename = path.basename(filepath);
    const marker = "✨ AI Generated Content";
    const taskLine = `Task [${timestamp}]: ${taskName}`;

    // 1. DEFINE LANGUAGE STYLES
    const isHashLang = ['py', 'sh', 'yaml', 'yml', 'gitignore', 'env'].includes(extension);
    const isXmlLang = ['html', 'xml', 'svg'].includes(extension);
    
    // 2. DETECT EXISTING BLOCK
    if (existingContent && existingContent.length > 0) {
        // Regex for JS/TS/CSS (Block Comments)
        const blockRegex = /\/\*\*?[\s\S]*?✨ AI Generated Content[\s\S]*?(\n?\s*\*\/)/;
        // Regex for Python/Shell (Hash blocks)
        const hashRegex = /# ✨ AI Generated Content[\s\S]*?# --- End AI ---/;
        
        // FIX: Replaced the broken comment with a valid regular expression
        const xmlRegex = /<!--\s*✨ AI Generated Content[\s\S]*?-->/;

        if (isHashLang) {
            const match = existingContent.match(hashRegex);
            if (match) {
                return match[0].replace("# --- End AI ---", `# ${taskLine}\n# --- End AI ---`);
            }
        } else if (isXmlLang) {
            const match = existingContent.match(xmlRegex);
            if (match && match[0] !== undefined) {
                return match[0].replace("-->", `\n    ${taskLine}\n-->`);
            }
        } else {
            const match = existingContent.match(blockRegex);
            if (match && match[0] !== undefined && match[1] !== undefined) {
                const closingBrace = match[1];
                // Inject the new task line before the closing characters
                return match[0].replace(closingBrace, `\n * ${taskLine}${closingBrace}`);
            }
        }
    }

    // 3. GENERATE NEW HEADER (Language Specific)
    if (isHashLang) {
        return `# ${marker}\n# File: ${filename}\n# ${taskLine}\n# --- End AI ---\n\n`;
    }

    if (isXmlLang) {
        // FIX: Restored the proper XML comment format
        return `<!--\n    ${marker}\n    File: ${filename}\n    ${taskLine}\n-->\n\n`;
    }

    // Default to JS/CSS style
    const headerStart = (extension === 'css' || extension === 'scss') ? '/*' : '/**';
    return `${headerStart}\n * ${marker}\n * File: ${filename}\n * ${taskLine}\n */\n\n`;
}