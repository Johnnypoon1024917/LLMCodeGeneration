// webview-ui/src/components/ScaffoldConfirmationDialog.tsx
//
// V2.1.2b — modal dialog for project scaffolding confirmation.
//
// Renders when the user submits a chat / spec prompt that the host
// classified as greenfield. The user picks a template (or skips,
// or cancels). The component is purely presentational — it doesn't
// own the state machine; the parent (App.tsx) drives all state via
// scaffoldDecisionState.ts and just passes props down.
//
// UX rules:
//   - Escape key → onCancel (treats as cancel, drops the prompt)
//   - "Skip scaffolding" → onPick('skip', null) (keeps the prompt;
//     user just doesn't want to scaffold)
//   - "Cancel" → onCancel
//   - Pick template + Apply → onPick('apply', templateId)
//   - Pre-selects stackHint if it matches a real template id
//   - Disables all buttons + selector when busy (i.e., apply in flight)
//   - Surfaces lastError above the action row when present

import React, { useEffect, useRef, useState } from 'react';
import type { TemplateInfo } from '../scaffoldDecisionTypes';

export interface ScaffoldConfirmationDialogProps {
    /** Templates available to pick from. Order from the host already
     *  has workspace overrides first then built-ins. */
    templates: TemplateInfo[];
    /** Pre-selection hint from greenfield detection. Matched against
     *  template ids — if no match, dropdown defaults to first template. */
    stackHint?: string | undefined;
    /** Detection confidence — surfaced as a small hint to set user
     *  expectation ("we're confident" vs "wasn't sure"). */
    confidence: 'low' | 'medium' | 'high';
    /** True when the host is processing an apply. Disables interaction
     *  to prevent double-submit. */
    busy: boolean;
    /** Last error from a failed apply, if any. Null on first open. */
    lastError: string | null;
    /** Called when user picks a template and clicks Apply, OR clicks
     *  the "Skip scaffolding" button. */
    onPick: (action: 'apply' | 'skip', templateId: string | null) => void;
    /** Called on Cancel button or Escape key. */
    onCancel: () => void;
}

export const ScaffoldConfirmationDialog: React.FC<ScaffoldConfirmationDialogProps> = ({
    templates,
    stackHint,
    confidence,
    busy,
    lastError,
    onPick,
    onCancel,
}) => {
    // Pre-select the stackHint template if it exists in the list.
    // Otherwise default to the first template (workspace ones first
    // because the host sorts them that way).
    const initialId = (stackHint && templates.find(t => t.id === stackHint))
        ? stackHint
        : templates[0]?.id ?? '';
    const [selectedId, setSelectedId] = useState<string>(initialId);

    // Focus the dropdown on mount so keyboard users land on the
    // primary control. Use a ref + effect rather than autoFocus so
    // re-renders (e.g. on lastError change) don't re-focus and steal
    // focus from wherever the user moved it.
    const selectRef = useRef<HTMLSelectElement>(null);
    useEffect(() => {
        selectRef.current?.focus();
    }, []);

    // Escape key dismisses. Listen at document level so it fires
    // even if focus has wandered.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                onCancel();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [busy, onCancel]);

    const selected = templates.find(t => t.id === selectedId);

    return (
        <div className="nexus-scaffold-overlay" role="dialog" aria-modal="true" aria-label="Project scaffolding">
            <div className="nexus-scaffold-dialog">
                <div className="nexus-scaffold-dialog__header">
                    <div className="nexus-scaffold-dialog__title">
                        I detected a new project
                    </div>
                    <div className="nexus-scaffold-dialog__subtitle">
                        Scaffold a starter project for you, or skip and let me build from scratch?
                        {confidence === 'medium' && (
                            <span className="nexus-scaffold-dialog__confidence">
                                {' '}(detection confidence: medium — feel free to skip if I got it wrong)
                            </span>
                        )}
                    </div>
                </div>

                <div className="nexus-scaffold-dialog__body">
                    <label className="nexus-scaffold-dialog__field-label" htmlFor="nexus-scaffold-template-select">
                        Template
                    </label>
                    <select
                        id="nexus-scaffold-template-select"
                        ref={selectRef}
                        className="nexus-scaffold-dialog__select"
                        value={selectedId}
                        onChange={(e) => setSelectedId(e.target.value)}
                        disabled={busy}
                    >
                        {templates.map(t => (
                            <option key={t.id} value={t.id}>
                                {t.displayName}
                                {t.source === 'workspace' ? ' (your team)' : ''}
                            </option>
                        ))}
                    </select>

                    {selected && (
                        <div className="nexus-scaffold-dialog__description">
                            {selected.description}
                            {selected.stackTags.length > 0 && (
                                <div className="nexus-scaffold-dialog__tags">
                                    {selected.stackTags.map(tag => (
                                        <span key={tag} className="nexus-scaffold-dialog__tag">{tag}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {lastError && (
                    <div className="nexus-scaffold-dialog__error" role="alert">
                        <strong>Scaffold failed:</strong> {lastError}
                    </div>
                )}

                <div className="nexus-scaffold-dialog__actions">
                    <button
                        type="button"
                        className="nexus-scaffold-dialog__btn nexus-scaffold-dialog__btn--ghost"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="nexus-scaffold-dialog__btn nexus-scaffold-dialog__btn--secondary"
                        onClick={() => onPick('skip', null)}
                        disabled={busy}
                        title="Don't scaffold a starter project — let the agent build everything from scratch"
                    >
                        Skip scaffolding
                    </button>
                    <button
                        type="button"
                        className="nexus-scaffold-dialog__btn nexus-scaffold-dialog__btn--primary"
                        onClick={() => selected && onPick('apply', selected.id)}
                        disabled={busy || !selected}
                    >
                        {busy ? 'Applying…' : 'Apply template'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ScaffoldConfirmationDialog;