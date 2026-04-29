// src/test/unit/tools/filesystem.test.ts
//
// Per-tool tests for filesystem-touching tools:
//   - read_file
//   - list_directory
//   - search_codebase
//   - write_file
//   - edit_file
//
// We use the shared vscode mock at __mocks__/vscode.ts (configured
// in jest.config.js's moduleNameMapper) and override the specific
// fs methods per test by reassigning them on the imported vscode
// object. This is more portable than per-file `jest.mock('vscode',...)`
// which produced module-load-order issues on Windows.

// Import vscode FIRST so the shared mock is loaded.
import * as vscode from 'vscode';

// Import tools through the registry. The barrel auto-registers all
// 10 tools at module load — vscode mock is in place by this point.
import { dispatchTool, type ToolExecutionContext } from '../../../agents/toolRegistry';
import '../../../agents/tools';

// Cast the mocked methods so jest assertions and overrides type-check.
// The shared mock wires these as jest.fn() with default rejected/
// resolved values; we override per-test.
const mockedFs = vscode.workspace.fs as unknown as {
    stat: jest.Mock;
    readFile: jest.Mock;
    writeFile: jest.Mock;
    readDirectory: jest.Mock;
    createDirectory: jest.Mock;
};
const mockedFindFiles = vscode.workspace.findFiles as unknown as jest.Mock;

describe('read_file tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: '/repo' };

    beforeEach(() => {
        mockedFs.stat.mockReset();
        mockedFs.readFile.mockReset();
    });

    test('returns file_contents uiPayload for valid file', async () => {
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.File });
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('hello world'));

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"src/x.ts"}' } },
            ctx
        );

        expect(result.uiPayload).toEqual({
            kind: 'file_contents',
            filepath: 'src/x.ts',
            content: 'hello world'
        });
        expect(result.llmContent).toBe('hello world');
    });

    test('returns error when file does not exist', async () => {
        mockedFs.stat.mockRejectedValueOnce(new Error('ENOENT'));

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"missing.ts"}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('does not exist');
    });

    test('returns error when path is a directory', async () => {
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"src"}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('is a directory');
    });

    test('returns error for missing filepath argument', async () => {
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain("'filepath'");
    });
});

describe('list_directory tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: '/repo' };

    beforeEach(() => {
        mockedFs.stat.mockReset();
        mockedFs.readDirectory.mockReset();
    });

    test('returns directory uiPayload with entries', async () => {
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory });
        mockedFs.readDirectory.mockResolvedValueOnce([
            ['file1.ts', vscode.FileType.File],
            ['subdir', vscode.FileType.Directory],
            ['link', vscode.FileType.SymbolicLink]
        ]);

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"dirpath":"src"}' } },
            ctx
        );

        expect(result.uiPayload).toEqual({
            kind: 'directory',
            path: 'src',
            entries: [
                { name: 'file1.ts', kind: 'file' },
                { name: 'subdir', kind: 'dir' },
                { name: 'link', kind: 'symlink' }
            ]
        });
        expect(result.llmContent).toContain('[FILE] file1.ts');
        expect(result.llmContent).toContain('[DIR] subdir');
    });

    test('returns empty directory message when readDirectory returns empty', async () => {
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory });
        mockedFs.readDirectory.mockResolvedValueOnce([]);

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"dirpath":"empty"}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('directory');
        expect((result.uiPayload as { entries: unknown[] }).entries).toEqual([]);
        expect(result.llmContent).toContain('empty');
    });

    test('returns error when path is a file', async () => {
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.File });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'list_directory', arguments: '{"dirpath":"x.ts"}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('is a file');
    });
});

describe('search_codebase tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: '/repo' };

    beforeEach(() => {
        mockedFindFiles.mockReset();
        mockedFs.readFile.mockReset();
    });

    test('returns search_matches uiPayload with relevant lines', async () => {
        mockedFindFiles.mockResolvedValueOnce([
            { fsPath: '/repo/src/a.ts' },
            { fsPath: '/repo/src/b.ts' }
        ]);
        mockedFs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
            if (uri.fsPath === '/repo/src/a.ts') {
                return new TextEncoder().encode('line1\ncalculateTax(input)\nline3');
            }
            return new TextEncoder().encode('no relevant content');
        });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'search_codebase', arguments: '{"keyword":"calculateTax"}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('search_matches');
        const matches = (result.uiPayload as { matches: Array<{ filepath: string; line: number; text: string }> }).matches;
        expect(matches).toHaveLength(1);
        expect(matches[0]!.filepath).toBe('src/a.ts');
        expect(matches[0]!.line).toBe(2);
        expect(matches[0]!.text).toBe('calculateTax(input)');
    });

    test('returns string uiPayload (no matches) with helpful message', async () => {
        mockedFindFiles.mockResolvedValueOnce([{ fsPath: '/repo/src/a.ts' }]);
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('nothing relevant here'));

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'search_codebase', arguments: '{"keyword":"NotFoundXyz"}' } },
            ctx
        );

        // search_matches with empty array, llmContent says 'No results'
        expect(result.uiPayload.kind).toBe('search_matches');
        const matches = (result.uiPayload as { matches: unknown[] }).matches;
        expect(matches).toEqual([]);
        expect(result.llmContent).toContain('No results');
    });
});

describe('write_file tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: '/repo' };

    beforeEach(() => {
        mockedFs.stat.mockReset();
        mockedFs.readFile.mockReset();
        mockedFs.writeFile.mockReset();
        mockedFs.createDirectory.mockReset().mockResolvedValue(undefined);
    });

    test('creates new file with empty before in diff', async () => {
        mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
        mockedFs.writeFile.mockResolvedValueOnce(undefined);

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"filepath":"src/new.ts","content":"export const x = 1;"}' } },
            ctx
        );

        expect(result.uiPayload).toEqual({
            kind: 'diff',
            filepath: 'src/new.ts',
            before: '',
            after: 'export const x = 1;'
        });
        expect(result.llmContent).toContain('Created');
        expect(mockedFs.writeFile).toHaveBeenCalledTimes(1);
    });

    test('overwrites existing file with previous content as before', async () => {
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('old content'));
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.File });
        mockedFs.writeFile.mockResolvedValueOnce(undefined);

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"filepath":"src/x.ts","content":"new content"}' } },
            ctx
        );

        expect(result.uiPayload).toEqual({
            kind: 'diff',
            filepath: 'src/x.ts',
            before: 'old content',
            after: 'new content'
        });
        expect(result.llmContent).toContain('Overwrote');
    });

    test('detects no-op when content matches', async () => {
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('same'));
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.File });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"filepath":"src/x.ts","content":"same"}' } },
            ctx
        );

        // Should NOT call writeFile when content is unchanged
        expect(mockedFs.writeFile).not.toHaveBeenCalled();
        expect(result.llmContent).toContain('No changes');
    });

    test('returns error when target path is a directory', async () => {
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode(''));
        mockedFs.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"filepath":"src","content":"x"}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('is a directory');
    });
});

describe('edit_file tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: '/repo' };

    beforeEach(() => {
        mockedFs.readFile.mockReset();
        mockedFs.writeFile.mockReset();
    });

    test('applies a successful edit and returns diff payload', async () => {
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('hello world'));
        mockedFs.writeFile.mockResolvedValueOnce(undefined);

        const result = await dispatchTool(
            {
                id: 'c1', type: 'function',
                function: {
                    name: 'edit_file',
                    arguments: JSON.stringify({ filepath: 'src/x.ts', old_text: 'hello', new_text: 'hi' })
                }
            },
            ctx
        );

        expect(result.uiPayload).toEqual({
            kind: 'diff',
            filepath: 'src/x.ts',
            before: 'hello world',
            after: 'hi world'
        });
        expect(result.llmContent).toContain('Edited');
    });

    test('returns error when file does not exist', async () => {
        mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

        const result = await dispatchTool(
            {
                id: 'c1', type: 'function',
                function: {
                    name: 'edit_file',
                    arguments: JSON.stringify({ filepath: 'missing.ts', old_text: 'x', new_text: 'y' })
                }
            },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('does not exist');
    });

    test('returns error when old_text is empty', async () => {
        const result = await dispatchTool(
            {
                id: 'c1', type: 'function',
                function: {
                    name: 'edit_file',
                    arguments: JSON.stringify({ filepath: 'x.ts', old_text: '', new_text: 'y' })
                }
            },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('non-empty');
    });

    test('returns error when old_text is not unique', async () => {
        // applyBlock from searchReplace.ts rejects ambiguous matches
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('foo foo foo'));

        const result = await dispatchTool(
            {
                id: 'c1', type: 'function',
                function: {
                    name: 'edit_file',
                    arguments: JSON.stringify({ filepath: 'x.ts', old_text: 'foo', new_text: 'bar' })
                }
            },
            ctx
        );

        // applyBlock throws when match is ambiguous; we surface as error.
        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('Error applying edit');
        expect(result.llmContent).toContain('matches 3 regions');
    });
});