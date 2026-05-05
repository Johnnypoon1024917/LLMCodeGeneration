// webview-ui/src/test/unit/toolCardOverhaul.test.tsx
//
// Smoke tests for the PR 2.2 visual overhaul of ToolCallCard and the
// four body components. Verifies that:
//   1. Each archetype's body renders for its tool name
//   2. The header shows the tool name + arg summary + duration
//   3. The status pill/icon reflects the lifecycle state
//   4. The chevron expands/collapses on click
//
// We intentionally don't snapshot the rendered HTML — that would
// couple us to the design tokens and cause noise on every styling
// tweak. Structural assertions (DOM presence + content text) survive
// styling changes.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard } from '../../components/ToolCallCard';
import type { ToolCallState } from '../../toolEvents';

// File-local cleanup — registers in this file's lifecycle so it can't
// be defeated by setup.ts loading-order issues on Windows. See
// bashApprovalCard.test.tsx header comment for context.
afterEach(() => {
    cleanup();
});

// Minimal state factory. Each test overrides the fields it needs.
function stateFor(overrides: Partial<ToolCallState> & { name: string }): ToolCallState {
    return {
        callId: 'call-1',
        taskId: 'task-1',
        name: overrides.name,
        args: overrides.args ?? {},
        source: overrides.source ?? 'coordinator',
        status: overrides.status ?? 'success',
        startSeq: overrides.startSeq ?? 0,
        outputBuffer: overrides.outputBuffer ?? '',
        startedAt: overrides.startedAt ?? 1000,
        ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
        ...(overrides.result !== undefined ? { result: overrides.result } : {})
    };
}

describe('tool-call card — visual overhaul', () => {
    it('renders read_file as InformationalBody with file_contents', () => {
        const s = stateFor({
            name: 'read_file',
            args: { filepath: 'src/foo.ts' },
            status: 'success',
            durationMs: 220,
            result: {
                llmContent: 'file content here',
                uiPayload: {
                    kind: 'file_contents',
                    filepath: 'src/foo.ts',
                    content: 'line1\nline2\nline3',
                    truncated: false
                }
            }
        });
        render(<ToolCallCard state={s} defaultExpanded />);

        // Header surfaces tool name + truncated args + duration.
        expect(screen.getByText(/read_file/)).toBeInTheDocument();
        expect(screen.getByText(/src\/foo\.ts/)).toBeInTheDocument();
        expect(screen.getByText('220ms')).toBeInTheDocument();
        // Body shows line count + content.
        expect(screen.getByText('3 lines')).toBeInTheDocument();
    });

    it('renders write_file as DiffBody with add/remove counts', () => {
        const s = stateFor({
            name: 'write_file',
            args: { filepath: 'src/bar.ts' },
            status: 'success',
            durationMs: 380,
            result: {
                llmContent: 'wrote bar.ts',
                uiPayload: {
                    kind: 'diff',
                    filepath: 'src/bar.ts',
                    before: 'old line\n',
                    after: 'new line\n'
                }
            }
        });
        render(<ToolCallCard state={s} defaultExpanded />);

        // +1 add, −1 remove visible in the diff meta.
        expect(screen.getByText('+1')).toBeInTheDocument();
        expect(screen.getByText('−1')).toBeInTheDocument();
    });

    it('renders bash_exec as ExecutableBody with exit-code pill', () => {
        const s = stateFor({
            name: 'bash_exec',
            args: { command: 'npm test' },
            status: 'success',
            durationMs: 1250,
            outputBuffer: 'all tests passed',
            result: {
                llmContent: 'all tests passed',
                uiPayload: {
                    kind: 'bash_output',
                    stdout: 'all tests passed',
                    stderr: '',
                    exitCode: 0,
                    durationMs: 1250
                }
            }
        });
        render(<ToolCallCard state={s} defaultExpanded />);

        expect(screen.getByText('bash_exec')).toBeInTheDocument();
        expect(screen.getByText(/all tests passed/)).toBeInTheDocument();
        // ExitCodeChip shows "exit 0" via the Pill primitive.
        expect(screen.getByText('exit 0')).toBeInTheDocument();
    });

    it('renders web_fetch as NetworkBody with parsed URL + status', () => {
        const s = stateFor({
            name: 'web_fetch',
            args: { url: 'https://example.com' },
            status: 'success',
            durationMs: 540,
            result: {
                llmContent: 'fetched',
                uiPayload: {
                    kind: 'string',
                    content: 'URL: https://example.com\nStatus: 200 OK\n\n<html>body</html>'
                }
            }
        });
        render(<ToolCallCard state={s} defaultExpanded />);

        // URL link appears.
        const link = screen.getByRole('link', { name: /https:\/\/example\.com/ });
        expect(link).toHaveAttribute('href', 'https://example.com');
        // Status chip via Pill.
        expect(screen.getByText('200 OK')).toBeInTheDocument();
    });

    it('shows running status without duration in the header', () => {
        const s = stateFor({
            name: 'read_file',
            args: { filepath: 'src/x.ts' },
            status: 'running',
            outputBuffer: ''
        });
        const { container } = render(<ToolCallCard state={s} defaultExpanded />);
        // Body shows the running placeholder.
        expect(container).toHaveTextContent('Reading…');
        // No duration shown when it's not present in state. Scope the
        // query to the rendered container — vitest doesn't reset JSDOM
        // between tests in the same file by default, so screen.* would
        // see leftover DOM from earlier tests.
        const duration = container.querySelector('[title="Duration"]');
        expect(duration).toBeNull();
    });

    it('shows error body when result is an error payload', () => {
        const s = stateFor({
            name: 'read_file',
            args: { filepath: 'missing.ts' },
            status: 'error',
            durationMs: 30,
            result: {
                llmContent: 'file not found',
                uiPayload: { kind: 'error', message: 'ENOENT: missing.ts' }
            }
        });
        render(<ToolCallCard state={s} defaultExpanded />);
        expect(screen.getByText(/ENOENT/)).toBeInTheDocument();
    });

    it('header click toggles body visibility', () => {
        const s = stateFor({
            name: 'read_file',
            args: { filepath: 'src/x.ts' },
            status: 'success',
            durationMs: 50,
            result: {
                llmContent: 'content',
                uiPayload: {
                    kind: 'file_contents',
                    filepath: 'src/x.ts',
                    content: 'short content',
                    truncated: false
                }
            }
        });
        // Default for completed-success is collapsed.
        const { rerender } = render(<ToolCallCard state={s} />);
        expect(screen.queryByText('1 lines')).not.toBeInTheDocument();
        // Click the header to expand.
        const header = screen.getByRole('button', { expanded: false });
        fireEvent.click(header);
        expect(screen.getByText('1 lines')).toBeInTheDocument();
        // Re-render with same state — local expanded state should persist.
        rerender(<ToolCallCard state={s} />);
        expect(screen.getByText('1 lines')).toBeInTheDocument();
    });
});