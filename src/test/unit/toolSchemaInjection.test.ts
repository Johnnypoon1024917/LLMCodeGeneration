// src/test/unit/toolSchemaInjection.test.ts
//
// Tests for renderToolSchemasAsSystemPrompt and
// appendToolSchemasToSystemPrompt. Pure-string transformations, no
// network, no async.

import {
    renderToolSchemasAsSystemPrompt,
    appendToolSchemasToSystemPrompt,
} from '../../llm/toolSchemaInjection';
import type { ToolDefinition } from '../../llm/Provider';

const writeFileTool: ToolDefinition = {
    type: 'function',
    function: {
        name: 'write_file',
        description: 'Write content to a file at the given path.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['path', 'content'],
        },
    },
};

const readFileTool: ToolDefinition = {
    type: 'function',
    function: {
        name: 'read_file',
        description: 'Read the content of a file.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
    },
};

describe('renderToolSchemasAsSystemPrompt', () => {
    test('empty array returns empty string', () => {
        expect(renderToolSchemasAsSystemPrompt([])).toBe('');
    });

    test('renders a single tool with its schema and example', () => {
        const out = renderToolSchemasAsSystemPrompt([writeFileTool]);
        expect(out.length).toBeGreaterThan(0);
        expect(out).toContain('write_file');
        expect(out).toContain('Write content to a file');
        expect(out).toContain('<tool_call>');
        expect(out).toContain('</tool_call>');
    });

    test('renders multiple tools', () => {
        const out = renderToolSchemasAsSystemPrompt([writeFileTool, readFileTool]);
        expect(out).toContain('write_file');
        expect(out).toContain('read_file');
    });

    test('compact JSON for tool schemas (no pretty-print)', () => {
        const out = renderToolSchemasAsSystemPrompt([writeFileTool]);
        // Compact output: the tool's JSON should be on one line
        // (no \n inside the braces). Detect by finding the line
        // that starts with `{"name":` and verifying it's a single line.
        const lines = out.split('\n');
        const schemaLine = lines.find(l => l.startsWith('{"name":'));
        expect(schemaLine).toBeDefined();
        expect(schemaLine).toContain('"write_file"');
        expect(schemaLine).toContain('"description"');
        expect(schemaLine).toContain('"parameters"');
    });

    test('omits the OpenAI type:function wrapper for token economy', () => {
        const out = renderToolSchemasAsSystemPrompt([writeFileTool]);
        const lines = out.split('\n');
        const schemaLine = lines.find(l => l.startsWith('{"name":'));
        expect(schemaLine).toBeDefined();
        // The line should be the function object, not wrapped in
        // {type:"function", function:{...}}
        expect(schemaLine!.startsWith('{"name":')).toBe(true);
    });

    test('includes a worked example with write_file', () => {
        const out = renderToolSchemasAsSystemPrompt([writeFileTool]);
        expect(out).toContain('Hello, World');  // from the C example
        expect(out).toContain('main.c');
    });

    test('drops malformed tool entries silently', () => {
        // The `as ToolDefinition[]` cast is the type-narrowing — we
        // deliberately feed in malformed entries to exercise the
        // defensive runtime behavior. Per-element @ts-expect-error
        // directives would be redundant (and TS 5.x correctly flags
        // them as unused since the cast already silences the per-
        // element type errors).
        const tools = [
            writeFileTool,
            { type: 'function', function: { name: 123 } },  // bad name type
            null,
            { type: 'wrong-type', function: { name: 'foo', description: 'bar' } },
        ] as ToolDefinition[];
        const out = renderToolSchemasAsSystemPrompt(tools);
        expect(out).toContain('write_file');
        // The malformed entries should not appear
        expect(out).not.toContain('"123"');
        expect(out).not.toContain('wrong-type');
    });

    test('emphasizes "do not write a tutorial" — the actual failure mode', () => {
        const out = renderToolSchemasAsSystemPrompt([writeFileTool]);
        // The instruction text should explicitly call out the
        // tutorial-prose failure pattern we're trying to fix.
        expect(out.toLowerCase()).toContain('tutorial');
    });
});

describe('appendToolSchemasToSystemPrompt', () => {
    test('empty tools returns existing content unchanged', () => {
        expect(appendToolSchemasToSystemPrompt('You are a helpful assistant.', []))
            .toBe('You are a helpful assistant.');
    });

    test('empty existing + tools = just the rendered tools', () => {
        const out = appendToolSchemasToSystemPrompt('', [writeFileTool]);
        expect(out.startsWith('# Tools available to you')).toBe(true);
    });

    test('non-empty existing + tools = existing then \\n\\n then tools', () => {
        const existing = 'Original system prompt here.';
        const out = appendToolSchemasToSystemPrompt(existing, [writeFileTool]);
        expect(out.startsWith(existing)).toBe(true);
        expect(out).toContain('\n\n# Tools available to you');
        expect(out).toContain('write_file');
    });

    test('preserves caller existing content verbatim', () => {
        const existing = 'You are an expert in C. Always prefer ANSI C.\nUse 4-space indentation.';
        const out = appendToolSchemasToSystemPrompt(existing, [writeFileTool]);
        // The whole original is retained
        expect(out.includes(existing)).toBe(true);
    });

    test('empty tools + empty existing = empty', () => {
        expect(appendToolSchemasToSystemPrompt('', [])).toBe('');
    });
});