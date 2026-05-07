"use strict";
// src/agents/tools/_pathGuard.ts
//
// Shared workspace-path validation for file-touching tools (read_file,
// list_directory, write_file, edit_file, search_codebase).
//
// Why this exists:
//   The agent tool descriptions all say "relative path" (e.g.
//   'src/components'), but nothing was enforcing it. Models —
//   especially aggressively quantized ones — sometimes emit absolute
//   paths like 'c:\Users\me\proj\src\App.tsx'. On Windows, Node's
//   path.join silently DROPS the workspace root when the second arg
//   is absolute, so the absolute path "works" the first time. But:
//
//     1. The tool description and model's mental model diverge —
//        the model thinks the absolute path is normal, then drifts
//        further (e.g. token-confusion corruption: 'johnnypoon' ->
//        'johnnypoonoon'), producing paths that no longer resolve
//     2. By the time corruption appears, we've burned ReAct steps
//        on broken paths the planner has no way to recover from
//
//   The honest fix: reject absolute paths at the tool boundary with a
//   clear corrective message. The model gets immediate feedback on
//   its FIRST absolute-path call ("use a relative path") and can
//   self-correct before any drift sets in.
//
// What "absolute" means cross-platform:
//   - Windows: starts with a drive letter and colon (`C:\`, `c:/`,
//     also `\\server\share` UNC paths)
//   - POSIX: starts with `/`
//   We use Node's path.isAbsolute which handles both correctly when
//   running on the matching platform. We also explicitly check for
//   the cross-platform Windows pattern — on a POSIX runtime,
//   path.isAbsolute won't recognize `C:\foo` as absolute, but if a
//   model emits that path we should still reject it.
//
// Path traversal is a separate concern (covered by the existing
// vscode.Uri.joinPath behavior + workspace boundary). This module
// only handles the absolute-path / wrong-shape category.
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
exports.validateWorkspacePath = validateWorkspacePath;
const path = __importStar(require("path"));
/**
 * Returns null when the path is acceptable; otherwise returns a
 * human-readable error string suitable for echoing back to the LLM.
 *
 * Acceptable: a non-empty relative path containing no Windows drive
 * letters or POSIX root prefix.
 *
 * Use the returned error verbatim in the tool's `llmContent` and
 * `uiPayload.message` so the LLM receives consistent feedback.
 */
function validateWorkspacePath(p, argName = 'path') {
    if (!p) {
        return `'${argName}' argument is required and must be non-empty.`;
    }
    // Cross-platform absolute-path check: catches Windows drive
    // letters even when running on POSIX, and POSIX-style root
    // even when running on Windows.
    const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
    const isPosixAbsolute = p.startsWith('/');
    if (isWindowsAbsolute || isPosixAbsolute || path.isAbsolute(p)) {
        return (`Absolute path '${p}' is not allowed. ` +
            `Use a relative path from the workspace root instead, e.g., 'src/components/Button.tsx'. ` +
            `Do not include drive letters (C:\\), leading slashes (/), or UNC prefixes.`);
    }
    return null;
}
//# sourceMappingURL=_pathGuard.js.map