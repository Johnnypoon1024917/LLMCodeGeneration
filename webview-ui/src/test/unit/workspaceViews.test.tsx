// webview-ui/src/test/unit/workspaceViews.test.tsx
//
// Smoke tests for the Sprint 2 PR 2.1 workspace components:
// IdleState and Message. Same philosophy as uiPrimitives.test.tsx —
// render with default props, check the DOM has the expected
// content. We don't snapshot or test interaction.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IdleState } from '../../views/workspace/IdleState';
import { Message } from '../../views/workspace/Message';

// Tiny stub icons so the tests don't depend on Lucide / the App-level
// Icons registry.
const stubIcon = <span data-testid="icon">icon</span>;

// File-local cleanup — registers in this file's lifecycle so it can't
// be defeated by setup.ts loading-order issues on Windows. See
// bashApprovalCard.test.tsx header comment for context.
afterEach(() => {
    cleanup();
});

describe('workspace views — smoke', () => {
    it('IdleState renders the empty-state structure', () => {
        const { container } = render(<IdleState brandIcon={stubIcon} />);
        // The component renders the standard empty-state class hierarchy.
        // We check for structural presence rather than specific text
        // because i18next without a loaded locale returns the key string
        // (e.g., "chat.empty.title") rather than the fallback English.
        // This matches the behavior in App.tsx — t() everywhere uses the
        // same pattern, and tests don't initialize i18n.
        expect(container.querySelector('.nexus-chat-empty')).toBeInTheDocument();
        expect(container.querySelector('.nexus-chat-empty-title')).toBeInTheDocument();
        expect(container.querySelector('.nexus-chat-empty-hint')).toBeInTheDocument();
        expect(container.querySelectorAll('.nexus-chat-empty-shortcut')).toHaveLength(3);
    });

    it('Message renders normal user message with content', () => {
        const { container } = render(
            <Message
                message={{ role: 'user', content: 'Hello' }}
                userIcon={stubIcon}
                assistantIcon={stubIcon}
                archiveIcon={stubIcon}
                fileIcon={stubIcon}
            />
        );
        expect(screen.getByText('Hello')).toBeInTheDocument();
        // Message has the user-role class, regardless of what the i18n
        // label resolves to.
        expect(container.querySelector('.nexus-message.user')).toBeInTheDocument();
        expect(container.querySelector('.nexus-message-header.user')).toBeInTheDocument();
    });

    it('Message renders assistant message', () => {
        const { container } = render(
            <Message
                message={{ role: 'assistant', content: 'Hi there' }}
                userIcon={stubIcon}
                assistantIcon={stubIcon}
                archiveIcon={stubIcon}
                fileIcon={stubIcon}
            />
        );
        expect(screen.getByText('Hi there')).toBeInTheDocument();
        expect(container.querySelector('.nexus-message.assistant')).toBeInTheDocument();
    });

    it('Message renders compacted variant with summary', () => {
        const { container } = render(
            <Message
                message={{ role: 'assistant', isCompacted: true, content: 'old summary' }}
                userIcon={stubIcon}
                assistantIcon={stubIcon}
                archiveIcon={stubIcon}
                fileIcon={stubIcon}
            />
        );
        // The compacted variant uses a <details> element with a known class.
        expect(container.querySelector('details.nexus-message-compacted')).toBeInTheDocument();
        expect(container.querySelector('.nexus-message-compacted-body')).toBeInTheDocument();
        expect(screen.getByText('old summary')).toBeInTheDocument();
    });

    it('Message renders user attachments when present', () => {
        render(
            <Message
                message={{
                    role: 'user',
                    content: 'Look at this',
                    attachments: [{ file: 'src/foo.ts', code: 'const x = 1;', language: 'typescript' }]
                }}
                userIcon={stubIcon}
                assistantIcon={stubIcon}
                archiveIcon={stubIcon}
                fileIcon={stubIcon}
            />
        );
        expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
        expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
    });

    it('Message renders children (used for inline plan-card slot)', () => {
        render(
            <Message
                message={{ role: 'assistant', content: 'Plan ready' }}
                userIcon={stubIcon}
                assistantIcon={stubIcon}
                archiveIcon={stubIcon}
                fileIcon={stubIcon}
            >
                <div data-testid="plan-slot">plan card here</div>
            </Message>
        );
        expect(screen.getByTestId('plan-slot')).toBeInTheDocument();
    });
});