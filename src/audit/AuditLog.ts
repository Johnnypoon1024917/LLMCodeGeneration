// src/audit/AuditLog.ts
//
// The AuditLog class. Append-only, hash-chained, JSONL-backed.
//
// Design constraints encoded here:
//   1. Per-workspace logging: each workspace has its own .nexus/audit/ dir.
//      Multi-workspace setups (rare) get separate logs per workspace; this
//      matches how the rest of .nexus/ scopes.
//   2. Daily file rotation: log files are named audit-YYYY-MM-DD.jsonl.
//      Rotation happens on the first record of a new day; no scheduled
//      midnight job.
//   3. Hash chain across rotation: when a new daily file starts, its first
//      record's prevHash is the SHA-256 of the previous file's last record.
//      This means tampering is detectable across day boundaries.
//   4. Best-effort persistence: a failed write logs a warning but doesn't
//      throw — the IDE shouldn't crash because the audit FS is full. This
//      is a tradeoff: in v2 we may want a strict mode for compliance
//      customers who NEED audit guaranteed.
//   5. No locking: Node's fs.appendFile is atomic for small writes on
//      Linux/Mac/Windows, and we serialize through an in-memory queue so
//      concurrent emit() calls write in order. Multiple VS Code windows
//      on the same workspace would race; mitigation is documented but
//      not implemented (extremely rare in practice).
//
// What this class does NOT do (deliberate):
//   - No network shipping (the future admin portal handles that via a
//     separate "audit shipper" reading these files).
//   - No retention/rotation policy. Files stay forever. The future portal
//     can implement retention on its end.
//   - No encryption. Files are plaintext. Encryption is v2 if a customer
//     needs data-at-rest protection.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type {
    AuditRecord,
    AuditEventKind,
    LlmCallPayload,
    ToolCallPayload,
    FileWritePayload,
    SpecEditPayload,
    ConfigChangePayload
} from './types';
import { GENESIS_HASH } from './types';

// Note on logging: this module deliberately uses console.warn rather than
// the project logger (../logger). The audit log runs in both runtimes —
// the extension host (which has vscode + the rich logger) AND the CLI
// (which has neither). Importing ../logger here would crash the CLI on
// startup because logger transitively requires vscode. Audit warnings
// are rare enough (init failures, parse errors, write failures) that
// going via console.warn is an acceptable tradeoff for runtime portability.

/**
 * Args for emit(). The caller provides the kind, summary, and payload;
 * we add id, timestamp, actor, sessionId, prevHash automatically.
 */
export interface EmitArgs {
    kind: AuditEventKind;
    summary: string;
    payload: Record<string, unknown>;
    parentId?: string;
}

export class AuditLog {
    private readonly auditDir: string;
    private readonly sessionId: string;
    private readonly actor: string;
    private lastHash: string = GENESIS_HASH;
    /**
     * Serialization queue. emit() awaits the previous emit's promise
     * before doing its own write, ensuring strict ordering even under
     * concurrent calls. This matters for hash chain correctness — two
     * records can't share a prevHash, and we can't compute the next
     * prevHash until the previous record is fully written.
     */
    private writeQueue: Promise<void> = Promise.resolve();
    private initialized = false;

    /**
     * Construct an AuditLog bound to a workspace root.
     *
     * Does NOT initialize state from disk yet — call `init()` first
     * to read the existing chain's last hash. Construction is sync
     * because it's used in setDeps; the async work happens in init().
     */
    constructor(workspaceRoot: string) {
        this.auditDir = path.join(workspaceRoot, '.nexus', 'audit');
        // sessionId: per-instance UUID. All records emitted by this
        // AuditLog instance share it, letting log readers reconstruct
        // session boundaries.
        this.sessionId = crypto.randomUUID();
        this.actor = `${os.userInfo().username}@${os.hostname()}`;
    }

    /**
     * Initialize the chain by reading the most recent prior record's
     * hash. Idempotent — safe to call multiple times.
     */
    async init(): Promise<void> {
        if (this.initialized) return;
        try {
            await fs.mkdir(this.auditDir, { recursive: true });
            this.lastHash = await this.readLastHashFromDisk();
        } catch (e: unknown) {
            // Non-fatal: if we can't read the audit dir, we'll fall back
            // to GENESIS_HASH and write to a fresh chain. The IDE/CLI
            // shouldn't fail to start because audit init had a hiccup.
            console.warn('[audit] init failed, starting from genesis hash:', e);
            this.lastHash = GENESIS_HASH;
        }
        this.initialized = true;
    }

    /**
     * Emit an audit record. Returns a promise that resolves when the
     * record is durably written to disk (or write failed and was logged).
     */
    async emit(args: EmitArgs): Promise<void> {
        // Chain through the queue: each emit() awaits the previous
        // emit()'s completion before doing its own work. Prevents
        // hash-chain interleaving under concurrency.
        const prevWrite = this.writeQueue;
        const thisWrite = (async () => {
            await prevWrite.catch(() => { /* don't let prior failures cascade */ });
            await this.doEmit(args);
        })();
        this.writeQueue = thisWrite;
        return thisWrite;
    }

    /** Convenience helpers for typed payloads. Encourage well-shaped logging. */

    async logLlmCall(payload: LlmCallPayload, summary?: string, parentId?: string): Promise<void> {
        const emit: EmitArgs = {
            kind: 'llm_call',
            summary: summary ?? `LLM call to ${payload.model} (${payload.status})`,
            payload: payload as unknown as Record<string, unknown>,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }

    async logToolCall(payload: ToolCallPayload, summary?: string, parentId?: string): Promise<void> {
        const emit: EmitArgs = {
            kind: 'tool_call',
            summary: summary ?? `Tool ${payload.tool} (${payload.status})`,
            payload: payload as unknown as Record<string, unknown>,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }

    async logFileWrite(payload: FileWritePayload, parentId?: string): Promise<void> {
        const emit: EmitArgs = {
            kind: 'file_write',
            summary: `${payload.operation} ${payload.filepath} (${payload.bytes} bytes)`,
            payload: payload as unknown as Record<string, unknown>,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }

    async logSpecEdit(payload: SpecEditPayload, parentId?: string): Promise<void> {
        const emit: EmitArgs = {
            kind: 'spec_edit',
            summary: `${payload.spec}/${payload.phase}: ${payload.description}`,
            payload: payload as unknown as Record<string, unknown>,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }

    async logConfigChange(payload: ConfigChangePayload): Promise<void> {
        return this.emit({
            kind: 'config_change',
            summary: `Config ${payload.key} changed`,
            payload: payload as unknown as Record<string, unknown>,
        });
    }

    /**
     * Read all records from the file system within a date range.
     * Used by the export CLI command and (eventually) the admin portal
     * shipper.
     */
    async readRecords(opts?: { since?: Date; until?: Date }): Promise<AuditRecord[]> {
        const records: AuditRecord[] = [];
        try {
            const files = await fs.readdir(this.auditDir);
            const auditFiles = files
                .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
                .sort();

            for (const file of auditFiles) {
                const dateStr = file.slice('audit-'.length, -'.jsonl'.length);
                const fileDate = new Date(dateStr);

                if (opts?.since && fileDate < startOfDay(opts.since)) continue;
                if (opts?.until && fileDate > opts.until) continue;

                const content = await fs.readFile(path.join(this.auditDir, file), 'utf-8');
                for (const line of content.split('\n')) {
                    if (line.trim() === '') continue;
                    try {
                        const record = JSON.parse(line) as AuditRecord;
                        const ts = new Date(record.timestamp);
                        if (opts?.since && ts < opts.since) continue;
                        if (opts?.until && ts > opts.until) continue;
                        records.push(record);
                    } catch {
                        console.warn(`[audit] failed to parse line in ${file}: ${line.substring(0, 80)}`);
                    }
                }
            }
        } catch (e: unknown) {
            console.warn('[audit] readRecords failed:', e);
        }
        return records;
    }

    /**
     * Verify the hash chain integrity across all log files. Returns
     * a list of record IDs where chain breaks were detected.
     */
    async verifyChain(): Promise<{ valid: boolean; brokenAt: string[] }> {
        const records = await this.readRecords();
        const broken: string[] = [];
        let expected = GENESIS_HASH;

        for (const record of records) {
            if (record.prevHash !== expected) {
                broken.push(record.id);
                // Continue checking from this point with the actual
                // value, so we report all break points not just the first.
                expected = computeRecordHash(record);
                continue;
            }
            expected = computeRecordHash(record);
        }
        return { valid: broken.length === 0, brokenAt: broken };
    }

    // ─── Internals ─────────────────────────────────────────────────

    private async doEmit(args: EmitArgs): Promise<void> {
        if (!this.initialized) {
            // Lazy init if emit() called before init(). Shouldn't happen
            // if container wires correctly but we'd rather log silently
            // than throw.
            await this.init();
        }

        const baseRecord: Omit<AuditRecord, 'parentId'> & { parentId?: string } = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            actor: this.actor,
            sessionId: this.sessionId,
            kind: args.kind,
            summary: args.summary,
            payload: args.payload,
            prevHash: this.lastHash,
        };
        if (args.parentId !== undefined) {
            baseRecord.parentId = args.parentId;
        }

        // Compute hash AFTER prevHash is set — the hash includes prevHash
        // so the chain is well-defined.
        const record: AuditRecord = baseRecord;
        const newHash = computeRecordHash(record);

        // Persist
        try {
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const filepath = path.join(this.auditDir, `audit-${today}.jsonl`);
            await fs.appendFile(filepath, JSON.stringify(record) + '\n', 'utf-8');
            this.lastHash = newHash;
        } catch (e: unknown) {
            // Per design: don't throw. Log and continue. lastHash is NOT
            // updated, so the next record will retry the chain link to
            // the previous hash (re-establishing on success).
            console.warn(`[audit] write failed for ${args.kind}:`, e);
        }
    }

    /**
     * Read the most recent record's hash from disk. Used at startup to
     * resume the chain across sessions/restarts.
     */
    private async readLastHashFromDisk(): Promise<string> {
        const files = await fs.readdir(this.auditDir).catch(() => []);
        const auditFiles = files
            .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
            .sort()
            .reverse(); // newest first

        for (const file of auditFiles) {
            const content = await fs.readFile(path.join(this.auditDir, file), 'utf-8').catch(() => '');
            const lines = content.split('\n').filter(l => l.trim() !== '');
            if (lines.length === 0) continue;
            const lastLine = lines[lines.length - 1]!;
            try {
                const lastRecord = JSON.parse(lastLine) as AuditRecord;
                return computeRecordHash(lastRecord);
            } catch {
                // malformed last line — try the file before it
                continue;
            }
        }
        return GENESIS_HASH;
    }
}

/**
 * Compute the hash of a record's full serialized form, including its
 * own prevHash. This is what the NEXT record stores as prevHash.
 *
 * Canonicalization: we use a recursive sorted-key serializer so the same
 * record always hashes the same way, regardless of in-memory key order
 * or whether the record came fresh from emit() versus parsed from disk.
 *
 * NOTE: do NOT use `JSON.stringify(record, Object.keys(record).sort())`.
 * That looks correct but has a subtle bug: when the second arg is an
 * array, it acts as a key WHITELIST and filters out nested object
 * properties whose names aren't in the array — so payload contents
 * silently get dropped, defeating tamper detection on the payload.
 */
export function computeRecordHash(record: AuditRecord): string {
    return crypto.createHash('sha256').update(canonicalJson(record)).digest('hex');
}

/**
 * Recursive canonical-form serializer:
 *   - Object keys are sorted alphabetically at every depth
 *   - Arrays preserve order (semantic — order matters in arrays)
 *   - Primitives are serialized as JSON.stringify would
 *
 * Two records with identical data always produce identical output,
 * regardless of how their keys were ordered in memory. Tampering with
 * any field at any depth changes the output, which is what we need.
 */
function canonicalJson(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'undefined') return 'null'; // JSON treats undefined as missing/null in objects
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const parts = keys
            .filter(k => obj[k] !== undefined) // skip undefined fields (matches JSON.stringify behavior)
            .map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
        return '{' + parts.join(',') + '}';
    }
    // Functions, symbols, etc. — JSON.stringify would skip them. Same here.
    return 'null';
}

function startOfDay(d: Date): Date {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
}