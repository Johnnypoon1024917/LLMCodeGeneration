// webview-ui/src/views/workspace/Message.tsx
//
// Renders a single conversation message. Two variants:
//   - Compacted: a <details> block summarizing context that was
//     summarized to save tokens. Click to expand.
//   - Normal: header (icon + role label), content (markdown), and
//     optional attachments rendered as collapsible details.
//
// Per-task tool cards (the streaming tool-card region scoped to a
// specific task) stay rendered inline in App.tsx for now. They have
// substantial intertwined state (toolCardsByTask, taskSteps,
// taskReasoning) that's risky to extract in one PR. PR 2.2 will
// extract them as part of the tool-card visual overhaul.
//
// API note: this component intentionally stays "presentational" —
// receives all data via props, fires no side effects, doesn't read
// from the message protocol. State stays in App.tsx until the
// useConversation hook in PR 2.x.

import ReactMarkdown from 'react-markdown';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface AttachedContext {
    file: string;
    code: string;
    language: string;
}

export interface MessageData {
    role: 'user' | 'assistant';
    content?: string;
    attachments?: AttachedContext[];
    isCompacted?: boolean;
}

interface MessageProps {
    message: MessageData;
    /** User icon, passed in to keep this component decoupled from
     *  the App-level Icons registry. */
    userIcon: React.ReactNode;
    /** Assistant icon, same reason. */
    assistantIcon: React.ReactNode;
    /** Archive icon for the compacted-message summary. */
    archiveIcon: React.ReactNode;
    /** File icon for attachment summaries. */
    fileIcon: React.ReactNode;
    /** Optional content rendered inside the message bubble after the
     *  attachments section. PR 2.1 uses this slot for the inline
     *  plan-card rendering that stays in App.tsx until PR 2.2. */
    children?: React.ReactNode;
}

function MessageImpl({
    message,
    userIcon,
    assistantIcon,
    archiveIcon,
    fileIcon,
    children
}: MessageProps) {
    const { t } = useTranslation();

    if (message.isCompacted) {
        return (
            <details className="nexus-message-compacted">
                <summary>
                    {archiveIcon}{' '}
                    {t('chat.compacted_summary') ||
                        'Context Compacted (Old messages summarized to save tokens)'}
                </summary>
                <div className="nexus-message-compacted-body">
                    <ReactMarkdown>{message.content || ''}</ReactMarkdown>
                </div>
            </details>
        );
    }

    return (
        <div className={`nexus-message ${message.role}`}>
            <div className={`nexus-message-header ${message.role}`}>
                {message.role === 'user' ? userIcon : assistantIcon}
                {message.role === 'user'
                    ? (t('chat.user_label') || 'YOU')
                    : (t('chat.assistant_label') || 'NEXUS')}
            </div>

            {message.content && (
                <div className="nexus-message-content markdown-body">
                    <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
            )}

            {message.role === 'user' &&
                message.attachments &&
                message.attachments.length > 0 && (
                    <div className="message-attachments">
                        {message.attachments.map((att, i) => (
                            <details key={i} className="attachment-details">
                                <summary className="nexus-flex-row">
                                    {fileIcon} {att.file}
                                </summary>
                                <div className="markdown-body">
                                    <pre>
                                        <code className={`language-${att.language}`}>
                                            {att.code}
                                        </code>
                                    </pre>
                                </div>
                            </details>
                        ))}
                    </div>
                )}

            {/* Slot for inline content rendered inside the message
                bubble — currently used by App.tsx for the plan-card
                and per-task tool-card region. PR 2.2 will extract
                those too and this slot will become optional. */}
            {children}
        </div>
    );
}

/**
 * P3.2: memoize. Most messages in a conversation are historical and
 * never need to re-render once written — but they were re-rendering
 * on every App-level state change (typing into the input, status
 * updates, etc.). With memo, those skip.
 *
 * Active-task messages still re-render correctly because their
 * `children` prop (the live plan/tool-card region) takes a new
 * reference each time App rebuilds it.
 *
 * The icon props are module-scoped constants in App.tsx so they
 * compare equal across renders — no manual comparator needed.
 */
export const Message = memo(MessageImpl);