// src/test/unit/auditLog.test.ts
//
// Unit tests for AuditLog. Each test gets its own temp directory so they
// can run in parallel without stepping on each other's chains.
//
// Coverage targets:
//   - emit() writes JSONL records correctly
//   - hash chain links correctly across emits
//   - chain survives across daily file rotation (simulated via two files)
//   - readRecords() filters by date range
//   - verifyChain() detects tampering
//   - verifyChain() reports OK on clean chain
//   - export formatters produce correct CSV / JSONL

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditLog, computeRecordHash } from '../../audit/AuditLog';
import { GENESIS_HASH, type AuditRecord } from '../../audit/types';

async function makeTempWorkspace(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-audit-test-'));
    return dir;
}

describe('AuditLog — basic emit', () => {
    test('writes a JSONL record file in .nexus/audit/', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logLlmCall({
            model: 'qwen2.5-coder',
            endpoint: 'http://test/v1',
            status: 'ok',
            promptTokens: 100,
            completionTokens: 50
        });

        const auditDir = path.join(ws, '.nexus', 'audit');
        const files = await fs.readdir(auditDir);
        const auditFiles = files.filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'));
        expect(auditFiles).toHaveLength(1);

        const content = await fs.readFile(path.join(auditDir, auditFiles[0]!), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        expect(lines).toHaveLength(1);

        const record = JSON.parse(lines[0]!) as AuditRecord;
        expect(record.kind).toBe('llm_call');
        expect(record.payload).toMatchObject({ model: 'qwen2.5-coder', status: 'ok' });
        expect(record.prevHash).toBe(GENESIS_HASH);
    });

    test('serializes concurrent emits in order', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        // Fire 5 emits without awaiting individually — let writeQueue serialize
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(log.logConfigChange({
                key: `test.key.${i}`,
                newValue: String(i)
            }));
        }
        await Promise.all(promises);

        const records = await log.readRecords();
        expect(records).toHaveLength(5);
        // Records emitted in order should appear in order
        for (let i = 0; i < 5; i++) {
            const payload = records[i]!.payload as { key: string };
            expect(payload.key).toBe(`test.key.${i}`);
        }
    });
});

describe('AuditLog — hash chain', () => {
    test('chains records via prevHash', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logConfigChange({ key: 'a', newValue: '1' });
        await log.logConfigChange({ key: 'b', newValue: '2' });
        await log.logConfigChange({ key: 'c', newValue: '3' });

        const records = await log.readRecords();
        expect(records).toHaveLength(3);

        // First record's prevHash is GENESIS
        expect(records[0]!.prevHash).toBe(GENESIS_HASH);
        // Subsequent records' prevHash matches previous record's full hash
        expect(records[1]!.prevHash).toBe(computeRecordHash(records[0]!));
        expect(records[2]!.prevHash).toBe(computeRecordHash(records[1]!));
    });

    test('verifyChain returns valid for an untampered chain', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logConfigChange({ key: 'a', newValue: '1' });
        await log.logConfigChange({ key: 'b', newValue: '2' });

        const result = await log.verifyChain();
        expect(result.valid).toBe(true);
        expect(result.brokenAt).toEqual([]);
    });

    test('verifyChain detects tampering', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logConfigChange({ key: 'a', newValue: 'original' });
        await log.logConfigChange({ key: 'b', newValue: 'two' });
        await log.logConfigChange({ key: 'c', newValue: 'three' });

        // Tamper: rewrite the second record's payload directly on disk
        const auditDir = path.join(ws, '.nexus', 'audit');
        const files = await fs.readdir(auditDir);
        const filepath = path.join(auditDir, files[0]!);
        const content = await fs.readFile(filepath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        const record = JSON.parse(lines[1]!) as AuditRecord;
        const payload = record.payload as { key: string; newValue: string };
        payload.newValue = 'TAMPERED'; // change the value
        lines[1] = JSON.stringify(record);
        await fs.writeFile(filepath, lines.join('\n') + '\n', 'utf-8');

        // Verify should now detect that record[2].prevHash doesn't match
        // record[1]'s recomputed hash.
        const result = await log.verifyChain();
        expect(result.valid).toBe(false);
        expect(result.brokenAt.length).toBeGreaterThan(0);
    });

    test('chain survives restart (continues from disk)', async () => {
        const ws = await makeTempWorkspace();
        const log1 = new AuditLog(ws);
        await log1.init();
        await log1.logConfigChange({ key: 'before-restart', newValue: '1' });

        // Simulate process restart: new instance, same workspace
        const log2 = new AuditLog(ws);
        await log2.init();
        await log2.logConfigChange({ key: 'after-restart', newValue: '2' });

        // The two records should still chain together
        const records = await log2.readRecords();
        expect(records).toHaveLength(2);
        expect(records[1]!.prevHash).toBe(computeRecordHash(records[0]!));

        // Verifying the whole chain should still pass
        const result = await log2.verifyChain();
        expect(result.valid).toBe(true);
    });
});

describe('AuditLog — readRecords filtering', () => {
    test('returns all records when no filter applied', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logConfigChange({ key: 'a' });
        await log.logConfigChange({ key: 'b' });
        await log.logConfigChange({ key: 'c' });

        const records = await log.readRecords();
        expect(records).toHaveLength(3);
    });

    test('filters by since (after a future date returns nothing)', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();
        await log.logConfigChange({ key: 'a' });

        const future = new Date();
        future.setDate(future.getDate() + 10);
        const records = await log.readRecords({ since: future });
        expect(records).toEqual([]);
    });

    test('filters by until (before a past date returns nothing)', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();
        await log.logConfigChange({ key: 'a' });

        const past = new Date();
        past.setDate(past.getDate() - 10);
        const records = await log.readRecords({ until: past });
        expect(records).toEqual([]);
    });
});

describe('AuditLog — typed helpers', () => {
    test('logLlmCall uses sensible default summary', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logLlmCall({
            model: 'qwen2.5-coder',
            endpoint: 'http://test/v1',
            status: 'ok'
        });

        const records = await log.readRecords();
        expect(records[0]!.summary).toContain('qwen2.5-coder');
        expect(records[0]!.summary).toContain('ok');
    });

    test('logFileWrite encodes operation in summary', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logFileWrite({
            filepath: 'src/foo.ts',
            fileHash: 'abc123',
            bytes: 256,
            operation: 'create'
        });

        const records = await log.readRecords();
        expect(records[0]!.kind).toBe('file_write');
        expect(records[0]!.summary).toContain('create');
        expect(records[0]!.summary).toContain('src/foo.ts');
    });

    test('parentId links records together', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        await log.init();

        await log.logLlmCall({
            model: 'qwen2.5-coder',
            endpoint: 'http://test/v1',
            status: 'ok'
        });

        const llmRecords = await log.readRecords();
        const llmId = llmRecords[0]!.id;

        await log.logToolCall({
            tool: 'read_file',
            input: { path: 'README.md' },
            status: 'ok'
        }, undefined, llmId);

        const allRecords = await log.readRecords();
        expect(allRecords).toHaveLength(2);
        expect(allRecords[1]!.parentId).toBe(llmId);
    });
});

describe('AuditLog — error tolerance', () => {
    test('non-existent audit dir before init returns 0 records', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        // Deliberately skip init() — readRecords should still not throw
        const records = await log.readRecords();
        expect(records).toEqual([]);
    });

    test('lazy init if emit called before init', async () => {
        const ws = await makeTempWorkspace();
        const log = new AuditLog(ws);
        // No await log.init() here
        await log.logConfigChange({ key: 'should-still-work' });

        const records = await log.readRecords();
        expect(records).toHaveLength(1);
    });
});