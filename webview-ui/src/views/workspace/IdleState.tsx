// webview-ui/src/views/workspace/IdleState.tsx
//
// Empty-state hero shown when the conversation has no messages.
// Pulled out of App.tsx into a proper component as part of Sprint 2
// PR 2.1.
//
// This is a structural extraction — no visual change. Same i18n keys,
// same class names. The component reads the brand icon from props
// rather than referencing the App-level Icons object directly, so it
// stays decoupled from the legacy icon registry.

import { useTranslation } from 'react-i18next';

interface IdleStateProps {
    /** The brand/logo icon. Passed from App.tsx — currently the Lucide
     *  Bot icon wrapped in the legacy Icons.Nexus span. PR 3.x will
     *  replace this with the proper hex-mark from the redesign. */
    brandIcon: React.ReactNode;
}

export function IdleState({ brandIcon }: IdleStateProps) {
    const { t } = useTranslation();

    return (
        <div className="nexus-chat-empty">
            <div className="nexus-chat-empty-icon">{brandIcon}</div>
            <h3 className="nexus-chat-empty-title">
                {t('chat.empty.title') || 'Plan, code, verify.'}
            </h3>
            <p className="nexus-chat-empty-hint">
                {t('chat.empty.hint') ||
                    'Describe a feature, paste an error, or ask about your codebase. NexusCode will plan the change, write it across files, and run the verifier — you review the diff.'}
            </p>
            <div className="nexus-chat-empty-shortcuts">
                <span className="nexus-chat-empty-shortcut">
                    {t('chat.empty.shortcut_attach') || '@ to attach files'}
                </span>
                <span className="nexus-chat-empty-shortcut">
                    {t('chat.empty.shortcut_send') || 'Enter to send'}
                </span>
                <span className="nexus-chat-empty-shortcut">
                    {t('chat.empty.shortcut_newline') || 'Shift+Enter for newline'}
                </span>
            </div>
        </div>
    );
}