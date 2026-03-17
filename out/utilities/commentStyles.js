"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAIHeader = getAIHeader;
// src/utilities/commentStyles.ts
const path = __importStar(require("path"));
function getAIHeader(filepath, taskName, existingContent = "") {
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
        }
        else if (isXmlLang) {
            const match = existingContent.match(xmlRegex);
            if (match) {
                return match[0].replace("-->", `\n    ${taskLine}\n-->`);
            }
        }
        else {
            const match = existingContent.match(blockRegex);
            if (match) {
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
//# sourceMappingURL=commentStyles.js.map