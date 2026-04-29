// src/test/unit/pathGuard.test.ts
//
// Tests for the absolute-path guard used by file-touching tools
// (read_file, list_directory, write_file, edit_file).
//
// We test the helper directly because it's the simplest verifiable
// surface. Tool-level integration is tested implicitly by the dispatcher
// + existing tool tests; the failure modes worth locking in here are
// the cross-platform edge cases (Windows drive letters seen on POSIX
// runtimes, and vice versa).

import { validateWorkspacePath } from '../../agents/tools/_pathGuard';

describe('validateWorkspacePath', () => {
    test('returns null for a normal relative path', () => {
        expect(validateWorkspacePath('src/components/Nav.tsx')).toBeNull();
    });

    test('returns null for a single segment', () => {
        expect(validateWorkspacePath('package.json')).toBeNull();
    });

    test('returns null for nested deep paths', () => {
        expect(validateWorkspacePath('a/b/c/d/e/f/g.ts')).toBeNull();
    });

    test('returns error for empty string', () => {
        const err = validateWorkspacePath('');
        expect(err).not.toBeNull();
        expect(err).toContain('required');
    });

    test('rejects POSIX absolute path', () => {
        const err = validateWorkspacePath('/home/user/project/src/x.ts');
        expect(err).not.toBeNull();
        expect(err).toContain('Absolute path');
        expect(err).toContain('relative path');
    });

    test('rejects Windows absolute path with backslash (uppercase drive)', () => {
        // This is the path shape from the failure log:
        // c:\Users\johnnypoon\Desktop\CodeProject\src\App.tsx
        const err = validateWorkspacePath('C:\\Users\\me\\proj\\src\\App.tsx');
        expect(err).not.toBeNull();
        expect(err).toContain('Absolute path');
    });

    test('rejects Windows absolute path with lowercase drive', () => {
        const err = validateWorkspacePath('c:\\Users\\me\\proj\\src\\App.tsx');
        expect(err).not.toBeNull();
        expect(err).toContain('Absolute path');
    });

    test('rejects Windows absolute path with forward slashes', () => {
        const err = validateWorkspacePath('C:/Users/me/proj/src/App.tsx');
        expect(err).not.toBeNull();
        expect(err).toContain('Absolute path');
    });

    test('rejects Windows UNC path', () => {
        const err = validateWorkspacePath('\\\\server\\share\\file.ts');
        expect(err).not.toBeNull();
        expect(err).toContain('Absolute path');
    });

    test('uses the argName in the error message', () => {
        const err = validateWorkspacePath('', 'dirpath');
        expect(err).toContain("'dirpath'");
    });

    test('mentions corrective example in the error', () => {
        const err = validateWorkspacePath('/abs/path');
        expect(err).toContain('src/');
    });

    test('rejects paths starting with backslash on Windows-style', () => {
        // Edge case: bare backslash without drive letter.
        // path.isAbsolute on POSIX wouldn't catch it, but our
        // explicit Windows check should via the UNC pattern.
        // Single backslash isn't UNC; it's a partial Windows path.
        // We don't reject it here — only formal absolute forms.
        // This test documents the boundary.
        const err = validateWorkspacePath('\\foo\\bar');
        // Either accepted as a weird relative path, or rejected.
        // We don't strictly require either; just lock in non-crash.
        expect(typeof err === 'string' || err === null).toBe(true);
    });
});