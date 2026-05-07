// src/test/unit/mcpConfig.test.ts
//
// PR P2.1: tests for the MCP config parser.
//
// Pure-function module — no FS, no vscode mocks. Covers:
//   - JSON parse errors → invalid_json
//   - Wrong shape at root → wrong_shape
//   - Wrong mcpServers value type → wrong_shape
//   - Per-server missing/wrong-typed fields → invalid_server_entry
//   - Successful parse with all field permutations
//   - Stable id ordering in the output
//   - envExpand happy path + unknown variables

import {
    parseMcpConfig,
    isMcpConfigError,
    envExpand
} from '../../mcp/mcpConfig';

describe('parseMcpConfig — empty / minimal', () => {
    it('treats empty string as zero servers', () => {
        const r = parseMcpConfig('');
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers).toEqual([]);
        }
    });

    it('treats whitespace-only as zero servers', () => {
        const r = parseMcpConfig('   \n  ');
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers).toEqual([]);
        }
    });

    it('treats {} as zero servers (mcpServers field absent)', () => {
        const r = parseMcpConfig('{}');
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers).toEqual([]);
        }
    });

    it('treats { mcpServers: {} } as zero servers', () => {
        const r = parseMcpConfig('{"mcpServers": {}}');
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers).toEqual([]);
        }
    });
});

describe('parseMcpConfig — invalid JSON', () => {
    it('returns invalid_json with parse error', () => {
        const r = parseMcpConfig('{not valid json');
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_json');
            expect(r.message).toContain('Failed to parse');
        }
    });
});

describe('parseMcpConfig — wrong shape', () => {
    it('rejects array root', () => {
        const r = parseMcpConfig('[]');
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('wrong_shape');
        }
    });

    it('rejects null root', () => {
        const r = parseMcpConfig('null');
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('wrong_shape');
        }
    });

    it('rejects mcpServers as array', () => {
        const r = parseMcpConfig('{"mcpServers": []}');
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('wrong_shape');
            expect(r.message).toContain('mcpServers');
        }
    });

    it('rejects mcpServers as string', () => {
        const r = parseMcpConfig('{"mcpServers": "oops"}');
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('wrong_shape');
        }
    });
});

describe('parseMcpConfig — invalid server entry', () => {
    it('rejects entry without command', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "args": [] }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.serverId).toBe('broken');
            expect(r.message).toContain('command');
        }
    });

    it('rejects entry with empty-string command', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "command": "  " }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.serverId).toBe('broken');
        }
    });

    it('rejects entry with non-array args', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "command": "npx", "args": "should be array" }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.message).toContain('args');
        }
    });

    it('rejects entry with non-string element in args', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "command": "npx", "args": ["ok", 42] }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.message).toContain('args');
        }
    });

    it('rejects entry with non-object env', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "command": "npx", "env": "wrong" }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.message).toContain('env');
        }
    });

    it('rejects entry with non-string env value', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "command": "npx", "env": { "TOKEN": 123 } }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.message).toContain("'TOKEN'");
        }
    });

    it('rejects entry with non-boolean disabled', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "broken": { "command": "npx", "disabled": "yes" }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.code).toBe('invalid_server_entry');
            expect(r.message).toContain('disabled');
        }
    });
});

describe('parseMcpConfig — successful parse', () => {
    it('parses a minimal entry with defaults', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "fs": { "command": "npx" }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers).toHaveLength(1);
            const s = r.servers[0]!;
            expect(s.id).toBe('fs');
            // Discriminated-union narrowing: only stdio entries carry
            // command/args/env; HTTP entries carry url/headers instead.
            // Configs with `command` parse as stdio per mcpConfig.ts.
            expect(s.transport).toBe('stdio');
            if (s.transport === 'stdio') {
                expect(s.command).toBe('npx');
                expect(s.args).toEqual([]);
                expect(s.env).toEqual({});
            }
            expect(s.disabled).toBe(false);
            expect(s.description).toBeUndefined();
        }
    });

    it('parses a fully-specified entry', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "github": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": { "GITHUB_TOKEN": "\${env:GITHUB_TOKEN}" },
                    "disabled": false,
                    "description": "GitHub MCP server"
                }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers).toHaveLength(1);
            const s = r.servers[0]!;
            expect(s.id).toBe('github');
            expect(s.transport).toBe('stdio');
            if (s.transport === 'stdio') {
                expect(s.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
                expect(s.env).toEqual({ GITHUB_TOKEN: '${env:GITHUB_TOKEN}' });
            }
            expect(s.disabled).toBe(false);
            expect(s.description).toBe('GitHub MCP server');
        }
    });

    it('parses a disabled entry', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "github": { "command": "npx", "disabled": true }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers[0]!.disabled).toBe(true);
        }
    });

    it('sorts servers by id for deterministic UI rendering', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "zulu": { "command": "z" },
                "alpha": { "command": "a" },
                "mike": { "command": "m" }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(false);
        if (!isMcpConfigError(r)) {
            expect(r.servers.map((s) => s.id)).toEqual(['alpha', 'mike', 'zulu']);
        }
    });

    it('preserves arg order within an entry (NOT sorted)', () => {
        const r = parseMcpConfig(`{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "server", "/tmp", "--flag"] }
            }
        }`);
        if (!isMcpConfigError(r)) {
            const s = r.servers[0]!;
            expect(s.transport).toBe('stdio');
            if (s.transport === 'stdio') {
                expect(s.args).toEqual(['-y', 'server', '/tmp', '--flag']);
            }
        }
    });

    it('rejects the FIRST invalid entry encountered', () => {
        // First server is bad; we should get an error for IT, not
        // for any later valid/invalid entries.
        const r = parseMcpConfig(`{
            "mcpServers": {
                "bad": { "args": [] },
                "good": { "command": "ok" }
            }
        }`);
        expect(isMcpConfigError(r)).toBe(true);
        if (isMcpConfigError(r)) {
            expect(r.serverId).toBe('bad');
        }
    });
});

describe('envExpand', () => {
    it('expands a single ${env:NAME} reference', () => {
        const out = envExpand('${env:TOKEN}', { TOKEN: 'sekret' });
        expect(out).toBe('sekret');
    });

    it('expands multiple references in one string', () => {
        const out = envExpand('${env:USER}@${env:HOST}', { USER: 'alice', HOST: 'example.com' });
        expect(out).toBe('alice@example.com');
    });

    it('expands an unknown variable to empty string', () => {
        const out = envExpand('${env:DOES_NOT_EXIST}', {});
        expect(out).toBe('');
    });

    it('leaves text without placeholders unchanged', () => {
        expect(envExpand('hello world', {})).toBe('hello world');
    });

    it('leaves malformed placeholders alone', () => {
        // No closing brace → not a valid placeholder, untouched
        expect(envExpand('${env:UNCLOSED', { UNCLOSED: 'x' })).toBe('${env:UNCLOSED');
    });

    it('only matches the documented form (no $VAR or ${VAR})', () => {
        const env = { VAR: 'value' };
        // Bare $VAR — not supported
        expect(envExpand('$VAR', env)).toBe('$VAR');
        // ${VAR} (without env: prefix) — not supported
        expect(envExpand('${VAR}', env)).toBe('${VAR}');
    });

    it('handles undefined values from process.env safely', () => {
        // process.env values are technically `string | undefined`
        const env: Record<string, string | undefined> = { DEFINED: 'ok', UNDEFINED: undefined };
        expect(envExpand('${env:DEFINED}', env)).toBe('ok');
        expect(envExpand('${env:UNDEFINED}', env)).toBe('');
    });
});