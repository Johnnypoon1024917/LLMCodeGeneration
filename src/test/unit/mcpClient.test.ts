// src/test/unit/mcpClient.test.ts
//
// PR P2.1 SDK: tests for the pure helpers in mcpClient.ts.
//
// What's covered:
//   - namespaceToolName / parseNamespacedName round-trip + edge cases
//   - mapCallToolResultToDispatchResult: text-only, error, empty
//     content, non-text annotation, mixed
//
// What's NOT covered here:
//   - connectMcpServer's actual SDK plumbing — that's exercised
//     through McpManager tests via the fake-factory injection.
//     Testing the real spawn path would require a live MCP server
//     subprocess, which we don't have in unit tests.

import {
    namespaceToolName,
    parseNamespacedName,
    mapCallToolResultToDispatchResult
} from '../../mcp/mcpClient';

describe('namespaceToolName / parseNamespacedName', () => {
    it('produces names in the documented format', () => {
        const name = namespaceToolName('filesystem', 'read_file');
        expect(name).toBe('mcp__filesystem__read_file');
    });

    it('round-trips through parse', () => {
        const name = namespaceToolName('github', 'create_issue');
        const parsed = parseNamespacedName(name);
        expect(parsed).toEqual({ serverId: 'github', toolName: 'create_issue' });
    });

    it('returns null for non-MCP names (built-in tools)', () => {
        expect(parseNamespacedName('read_file')).toBeNull();
        expect(parseNamespacedName('bash_exec')).toBeNull();
        expect(parseNamespacedName('tool')).toBeNull();
    });

    it('returns null for malformed namespaced names', () => {
        // Missing the second separator
        expect(parseNamespacedName('mcp__justaserver')).toBeNull();
        // Empty server
        expect(parseNamespacedName('mcp____toolname')).toBeNull();
        // Empty tool
        expect(parseNamespacedName('mcp__server__')).toBeNull();
    });

    it('handles tool names containing single underscores', () => {
        // The double-underscore separator means tool names with single
        // underscores survive the round-trip — that's the whole point
        // of the convention.
        const name = namespaceToolName('fs', 'read_file_async');
        const parsed = parseNamespacedName(name);
        expect(parsed).toEqual({ serverId: 'fs', toolName: 'read_file_async' });
    });

    it('handles server ids with hyphens', () => {
        const name = namespaceToolName('my-cool-server', 'do_thing');
        expect(parseNamespacedName(name)).toEqual({
            serverId: 'my-cool-server',
            toolName: 'do_thing'
        });
    });
});

describe('mapCallToolResultToDispatchResult', () => {
    it('maps a single text content block to kind: string', () => {
        const r = mapCallToolResultToDispatchResult(
            { content: [{ type: 'text', text: 'hello world' }] },
            'fs',
            'read_file'
        );
        expect(r.uiPayload.kind).toBe('string');
        expect(r.llmContent).toBe('hello world');
        if (r.uiPayload.kind === 'string') {
            expect(r.uiPayload.content).toBe('hello world');
        }
    });

    it('joins multiple text blocks with newlines', () => {
        const r = mapCallToolResultToDispatchResult(
            {
                content: [
                    { type: 'text', text: 'first line' },
                    { type: 'text', text: 'second line' }
                ]
            },
            'srv',
            'tool'
        );
        expect(r.llmContent).toBe('first line\nsecond line');
    });

    it('treats isError: true as kind: error', () => {
        const r = mapCallToolResultToDispatchResult(
            {
                content: [{ type: 'text', text: 'permission denied' }],
                isError: true
            },
            'fs',
            'write_file'
        );
        expect(r.uiPayload.kind).toBe('error');
        if (r.uiPayload.kind === 'error') {
            expect(r.uiPayload.message).toContain('permission denied');
        }
    });

    it('annotates non-text content blocks in llmContent', () => {
        const r = mapCallToolResultToDispatchResult(
            {
                content: [
                    { type: 'text', text: 'here is the chart' },
                    { type: 'image', data: 'base64...', mimeType: 'image/png' }
                ]
            },
            'srv',
            'render_chart'
        );
        expect(r.llmContent).toContain('here is the chart');
        // The non-text block's type is mentioned so the LLM knows it
        // didn't see something
        expect(r.llmContent).toContain('image');
        expect(r.llmContent).toContain('non-text content block');
    });

    it('handles content with ONLY non-text blocks', () => {
        const r = mapCallToolResultToDispatchResult(
            { content: [{ type: 'image', data: 'base64...' }] },
            'srv',
            'tool'
        );
        // No text portion, but the annotation IS there
        expect(r.llmContent).toContain('image');
        expect(r.llmContent).toContain('non-text content block');
    });

    it('handles empty content array', () => {
        const r = mapCallToolResultToDispatchResult(
            { content: [] },
            'srv',
            'tool'
        );
        expect(r.uiPayload.kind).toBe('string');
        expect(r.llmContent).toContain("empty result");
        expect(r.llmContent).toContain('tool');
    });

    it('handles missing content field', () => {
        const r = mapCallToolResultToDispatchResult(
            {},
            'srv',
            'tool'
        );
        expect(r.uiPayload.kind).toBe('string');
        expect(r.llmContent).toContain("empty result");
    });

    it('handles malformed content entries gracefully', () => {
        const r = mapCallToolResultToDispatchResult(
            {
                content: [
                    null,
                    { type: 'text', text: 'good text' },
                    'string-entry-not-object',
                    { /* no type field */ },
                    { type: 'text' /* no text field */ }
                ]
            },
            'srv',
            'tool'
        );
        // Only the well-formed text block survives
        expect(r.llmContent).toBe('good text');
    });

    it('produces a fallback message when isError + empty content', () => {
        const r = mapCallToolResultToDispatchResult(
            { content: [], isError: true },
            'srv',
            'tool'
        );
        expect(r.uiPayload.kind).toBe('error');
        if (r.uiPayload.kind === 'error') {
            // Message includes the tool name so the user can identify
            // which tool errored
            expect(r.uiPayload.message).toContain('tool');
        }
    });
});