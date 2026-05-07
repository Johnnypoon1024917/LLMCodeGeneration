/**
 * Tests for the CLI entry point. Uses node:test (Node 20+ built-in)
 * so there's no external dev dependency to keep the scaffold thin.
 *
 * Run with: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.ts';

describe('main()', () => {
    it('returns 2 when no command is given', async () => {
        const code = await main([]);
        assert.equal(code, 2);
    });

    it('returns 0 for --help', async () => {
        const code = await main(['--help']);
        assert.equal(code, 0);
    });

    it('returns 2 for an unknown command', async () => {
        const code = await main(['nonexistent']);
        assert.equal(code, 2);
    });

    it('runs greet successfully', async () => {
        const code = await main(['greet', '--name', 'World']);
        assert.equal(code, 0);
    });

    it('returns 1 when greet is missing --name', async () => {
        const code = await main(['greet']);
        assert.equal(code, 1);
    });

    it('runs sum successfully', async () => {
        const code = await main(['sum', '1', '2', '3']);
        assert.equal(code, 0);
    });

    it('returns 1 when sum receives non-numeric input', async () => {
        const code = await main(['sum', '1', 'banana']);
        assert.equal(code, 1);
    });
});
