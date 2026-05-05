// webview-ui/src/components/FileChip.tsx
//
// A reusable chip representing an attached file or referenced filepath.
//
// Used by:
//   - Chat input attachment chips (App.tsx)
//   - Spec workflow context attachments (App.tsx)
//   - (future) tool-call card "operating on file X" indicators (T3)
//   - (future) task header card file references (T9)
//
// Design intent (per UI_GAP_ANALYSIS.md CC2):
//   - Path display is just the basename, full path in title tooltip
//   - Optional language badge derived from extension
//   - Optional close affordance for input-attached chips
//   - Compact (designed to wrap multiple chips per row)
//
// Variant pattern: rather than a tall list of boolean flags, the component
// takes the *facts* (file path, language, onRemove handler if applicable)
// and decides what to render. If you find yourself wanting an explicit
// "variant" prop, the component probably needs to be split.

import React from 'react';
import { File as IconFile, X as IconX } from 'lucide-react';

/**
 * Mapping from common file extensions to short uppercase badge labels.
 * Falls back to the uppercase extension if not listed.
 *
 * Keep this list short — fancy multi-color badges per language is a
 * v2 enhancement. For now, all badges are the same neutral color and
 * the only purpose is to give visual scan-ability over a list of chips.
 */
const LANG_BADGES: Record<string, string> = {
    'ts': 'TS',
    'tsx': 'TSX',
    'js': 'JS',
    'jsx': 'JSX',
    'py': 'PY',
    'rs': 'RS',
    'go': 'GO',
    'java': 'JAVA',
    'kt': 'KT',
    'rb': 'RB',
    'php': 'PHP',
    'cs': 'C#',
    'cpp': 'C++',
    'c': 'C',
    'h': 'H',
    'hpp': 'H++',
    'swift': 'SWIFT',
    'css': 'CSS',
    'scss': 'SCSS',
    'html': 'HTML',
    'md': 'MD',
    'json': 'JSON',
    'yaml': 'YAML',
    'yml': 'YAML',
    'toml': 'TOML',
    'sh': 'SH',
    'sql': 'SQL'
};

export interface FileChipProps {
    /**
     * Display path or filename. Can be a full path (`src/foo/bar.ts`) — the
     * component shows just the basename and uses the full path as the
     * tooltip.
     */
    filepath: string;
    /**
     * If provided, renders a small language badge at the right of the chip.
     * Pass the file's language identifier (e.g. "typescript", "ts", "py").
     * The component normalizes to a short uppercase label.
     */
    language?: string;
    /**
     * If provided, renders a close (×) button that calls this when clicked.
     * Omit for read-only chips (e.g. inside agent-emitted tool-call cards).
     */
    onRemove?: () => void;
    /**
     * Tooltip override. Defaults to the full filepath. Pass a richer
     * description (e.g. file contents preview) when useful.
     */
    title?: string;
}

/**
 * Derive a 2-6 character badge label from a language identifier or
 * file extension.
 *
 * Examples:
 *   languageOrExt('typescript') → 'TS'  (via .ts entry)
 *   languageOrExt('py') → 'PY'
 *   languageOrExt('foo') → 'FOO' (uppercase fallback)
 *   languageOrExt(undefined) → ''
 */
function deriveBadgeLabel(language: string | undefined, filepath: string): string {
    if (language) {
        // Lowercase common-form check first
        const norm = language.toLowerCase();
        if (LANG_BADGES[norm]) { return LANG_BADGES[norm]!; }
        // Some VS Code language ids are spelled out — map a few common ones
        const verboseMap: Record<string, string> = {
            'typescript': 'TS',
            'typescriptreact': 'TSX',
            'javascript': 'JS',
            'javascriptreact': 'JSX',
            'python': 'PY',
            'rust': 'RS',
            'csharp': 'C#'
        };
        if (verboseMap[norm]) { return verboseMap[norm]!; }
        // Fall through to extension lookup
    }
    // Derive from extension
    const ext = filepath.split('.').pop()?.toLowerCase() ?? '';
    return LANG_BADGES[ext] ?? ext.toUpperCase();
}

export function FileChip({ filepath, language, onRemove, title }: FileChipProps): React.ReactElement {
    const display = filepath.split('/').pop()?.split('\\').pop() ?? filepath;
    const badge = deriveBadgeLabel(language, filepath);

    return (
        <div className="file-chip" title={title ?? filepath}>
            <span className="file-chip-icon">
                <IconFile size={12} />
            </span>
            <span className="file-chip-name">{display}</span>
            {badge && <span className="file-chip-badge">{badge}</span>}
            {onRemove && (
                <button
                    type="button"
                    className="file-chip-close"
                    onClick={onRemove}
                    aria-label={`Remove ${display}`}
                >
                    <IconX size={12} />
                </button>
            )}
        </div>
    );
}