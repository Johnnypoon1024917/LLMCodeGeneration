"use strict";
// src/utilities/commentStyles.ts
//
// Builds an "AI Generated Content" header for tracking provenance. The
// header is concatenated as a prefix to the file the agent wrote, so
// the comment syntax has to match the file's language.
//
// Three-way classification:
//   - hash:    # prefix (Python, shell, YAML, .env, .gitignore, TOML)
//   - xml:     <!-- ... --> block (HTML, XML, SVG, Markdown)
//   - block:   /** ... */ block (JS/TS/JSX/TSX, CSS/SCSS, Java, C-family)
//   - none:    extensions that don't support comments natively. Header
//              is suppressed entirely — header function returns empty
//              string. The caller's `header + content` concat then
//              produces just the LLM's output verbatim.
//
// V2.2 hotfix: JSON files were getting `/** ... */` headers because the
// fall-through default was the JS/CSS block style. Result: every
// agent-generated package.json was invalid JSON. Fixed by adding the
// 'none' classification that returns "" early.
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
const path = __importStar(require("path"));
/**
 * Extensions that DO NOT support comments. The header function returns
 * "" for these so the caller's concatenation produces just the file
 * content with no header injection.
 *
 * Notable members:
 *   json:   strict JSON forbids comments. ALL package.json, tsconfig
 *           extends, prisma schemas, manifests etc.
 *   lock:   package-lock.json, yarn.lock — agent shouldn't touch
 *           these but defensive.
 *   csv/tsv: data files; comments unsupported.
 *
 * Notable EXCLUSIONS (these DO support comments and stay in their
 * respective lang families):
 *   json5/jsonc: support comments, treated as JS/block.
 *   toml:        supports # comments, treated as hash.
 *   ini:         comment syntax varies (; or #). Treating as hash
 *                works in practice on most parsers.
 *   md:          treated as xml (HTML comments work in markdown).
 *
 * If you add a format here, also confirm the file-write path tolerates
 * an empty header (it does today — the concat is just header + content
 * + "\n" elsewhere).
 */
const NO_COMMENT_EXTENSIONS = new Set([
    'json',
    'lock', // package-lock.json's secondary extension; rare but safe
    'csv',
    'tsv',
]);
function getAIHeader(filepath, taskName, existingContent = "") {
    const timestamp = new Date().toLocaleString();
    const extension = filepath.split('.').pop()?.toLowerCase() || "";
    const filename = path.basename(filepath);
    const marker = "✨ AI Generated Content";
    const taskLine = `Task [${timestamp}]: ${taskName}`;
    // 0. NO-COMMENT EXTENSIONS — return early. The caller concatenates
    //    header + content; an empty header means the file gets the
    //    LLM's output verbatim. Without this guard, JSON files received
    //    `/** ... */` headers and became invalid (V2.2 hotfix bug #3).
    if (NO_COMMENT_EXTENSIONS.has(extension)) {
        return "";
    }
    // Special case: package-lock.json has a "double extension" that
    // ends in .json. The split('.').pop() above already catches this
    // because the last segment is "json". Listed here for the reader's
    // benefit, not as a separate code path.
    // 1. DEFINE LANGUAGE STYLES
    // toml: # comments. .env, gitignore: # comments.
    const isHashLang = ['py', 'sh', 'yaml', 'yml', 'gitignore', 'env', 'toml', 'ini', 'conf'].includes(extension);
    // md: HTML comments work in markdown. Add it here so the agent's
    // generated readme/spec markdown gets a proper header instead of
    // a stray /** ... */ block at the top.
    const isXmlLang = ['html', 'xml', 'svg', 'md', 'markdown'].includes(extension);
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
            if (match && match[0] !== undefined) {
                return match[0].replace("-->", `\n    ${taskLine}\n-->`);
            }
        }
        else {
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
    // Default to JS/CSS style. Reached for: js, ts, jsx, tsx, mjs, cjs,
    // css, scss, less, java, c, cpp, h, go, rs, swift, kt, etc. — any
    // language that uses C-family /* */ block comments OR the agent's
    // unknown-extension fallback (where a JS-style header is harmless
    // because most modern editors render it as a comment regardless).
    const headerStart = (extension === 'css' || extension === 'scss') ? '/*' : '/**';
    return `${headerStart}\n * ${marker}\n * File: ${filename}\n * ${taskLine}\n */\n\n`;
}
//# sourceMappingURL=commentStyles.js.map