"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLog = void 0;
exports.computeRecordHash = computeRecordHash;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
const types_1 = require("./types");
class AuditLog {
    auditDir;
    sessionId;
    actor;
    lastHash = types_1.GENESIS_HASH;
    /**
     * Serialization queue. emit() awaits the previous emit's promise
     * before doing its own write, ensuring strict ordering even under
     * concurrent calls. This matters for hash chain correctness — two
     * records can't share a prevHash, and we can't compute the next
     * prevHash until the previous record is fully written.
     */
    writeQueue = Promise.resolve();
    initialized = false;
    /**
     * Subscribers notified of every successfully-persisted record.
     * Added in PR 2.4b. Use case: SidebarProvider forwards new records
     * to the webview so the AuditLogPanel can render them in real time.
     *
     * Contract:
     *   - Callback fires AFTER the record is written to disk. If the
     *     write fails, no callback fires (consistent with the principle
     *     that subscribers see what's in the JSONL — no false positives).
     *   - Errors thrown by callbacks are caught and logged but don't
     *     break the chain or affect other subscribers. A misbehaving
     *     subscriber can't stall audit emission.
     *   - Subscriptions are not persisted across restarts; subscribers
     *     re-register on each extension activation.
     */
    subscribers = [];
    /**
     * Construct an AuditLog bound to a workspace root.
     *
     * Does NOT initialize state from disk yet — call `init()` first
     * to read the existing chain's last hash. Construction is sync
     * because it's used in setDeps; the async work happens in init().
     */
    constructor(workspaceRoot) {
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
    async init() {
        if (this.initialized) {
            return;
        }
        try {
            await fs.mkdir(this.auditDir, { recursive: true });
            this.lastHash = await this.readLastHashFromDisk();
        }
        catch (e) {
            // Non-fatal: if we can't read the audit dir, we'll fall back
            // to GENESIS_HASH and write to a fresh chain. The IDE/CLI
            // shouldn't fail to start because audit init had a hiccup.
            console.warn('[audit] init failed, starting from genesis hash:', e);
            this.lastHash = types_1.GENESIS_HASH;
        }
        this.initialized = true;
    }
    /**
     * Emit an audit record. Returns a promise that resolves when the
     * record is durably written to disk (or write failed and was logged).
     */
    async emit(args) {
        // Chain through the queue: each emit() awaits the previous
        // emit()'s completion before doing its own work. Prevents
        // hash-chain interleaving under concurrency.
        const prevWrite = this.writeQueue;
        const thisWrite = (async () => {
            await prevWrite.catch(() => { });
            await this.doEmit(args);
        })();
        this.writeQueue = thisWrite;
        return thisWrite;
    }
    /** Convenience helpers for typed payloads. Encourage well-shaped logging. */
    async logLlmCall(payload, summary, parentId) {
        const emit = {
            kind: 'llm_call',
            summary: summary ?? `LLM call to ${payload.model} (${payload.status})`,
            payload: payload,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }
    async logToolCall(payload, summary, parentId) {
        const emit = {
            kind: 'tool_call',
            summary: summary ?? `Tool ${payload.tool} (${payload.status})`,
            payload: payload,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }
    async logFileWrite(payload, parentId) {
        const emit = {
            kind: 'file_write',
            summary: `${payload.operation} ${payload.filepath} (${payload.bytes} bytes)`,
            payload: payload,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }
    async logSpecEdit(payload, parentId) {
        const emit = {
            kind: 'spec_edit',
            summary: `${payload.spec}/${payload.phase}: ${payload.description}`,
            payload: payload,
        };
        if (parentId !== undefined) {
            emit.parentId = parentId;
        }
        return this.emit(emit);
    }
    async logConfigChange(payload) {
        return this.emit({
            kind: 'config_change',
            summary: `Config ${payload.key} changed`,
            payload: payload,
        });
    }
    /**
     * P1.4: log a hook fire to the audit chain.
     *
     * Summary format: "Hook <id> fired (<status>, <duration>ms)" — kept
     * short for grep / portal preview rendering. Full payload includes
     * hookName, triggerType, filePath (when applicable), and
     * errorMessage (when applicable) for compliance review.
     *
     * No parentId: hooks fire outside agent task hierarchies; they're
     * top-level audit events. If a hook's output later triggers a tool
     * call (a v2 use case — e.g. autopilot mode), that call's audit
     * record can reference this hook's id via parentId.
     */
    async logHookFire(payload) {
        return this.emit({
            kind: 'hook_fire',
            summary: `Hook ${payload.hookId} fired (${payload.status}, ${payload.durationMs}ms)`,
            payload: payload,
        });
    }
    /**
     * Read all records from the file system within a date range.
     * Used by the export CLI command and (eventually) the admin portal
     * shipper.
     */
    async readRecords(opts) {
        const records = [];
        try {
            const files = await fs.readdir(this.auditDir);
            const auditFiles = files
                .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
                .sort();
            for (const file of auditFiles) {
                const dateStr = file.slice('audit-'.length, -'.jsonl'.length);
                const fileDate = new Date(dateStr);
                if (opts?.since && fileDate < startOfDay(opts.since)) {
                    continue;
                }
                if (opts?.until && fileDate > opts.until) {
                    continue;
                }
                const content = await fs.readFile(path.join(this.auditDir, file), 'utf-8');
                for (const line of content.split('\n')) {
                    if (line.trim() === '') {
                        continue;
                    }
                    try {
                        const record = JSON.parse(line);
                        const ts = new Date(record.timestamp);
                        if (opts?.since && ts < opts.since) {
                            continue;
                        }
                        if (opts?.until && ts > opts.until) {
                            continue;
                        }
                        records.push(record);
                    }
                    catch {
                        console.warn(`[audit] failed to parse line in ${file}: ${line.substring(0, 80)}`);
                    }
                }
            }
        }
        catch (e) {
            console.warn('[audit] readRecords failed:', e);
        }
        return records;
    }
    /**
     * Verify the hash chain integrity across all log files. Returns
     * a list of record IDs where chain breaks were detected.
     */
    async verifyChain() {
        const records = await this.readRecords();
        const broken = [];
        let expected = types_1.GENESIS_HASH;
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
    /**
     * Subscribe to new audit records. The callback fires for every
     * record successfully persisted via emit(). Records emitted BEFORE
     * subscribe() is called are NOT replayed — subscribers see only
     * forward-going events. To populate UI with historical records,
     * combine readRecords() with subscribe().
     *
     * Returns a disposer function. Call it to unregister; idempotent.
     *
     * @example
     *   const unsubscribe = auditLog.subscribe((record) => {
     *       webview.postMessage({ type: 'auditEntryAppended', record });
     *   });
     *   // later, on dispose:
     *   unsubscribe();
     */
    subscribe(callback) {
        this.subscribers.push(callback);
        return () => {
            const idx = this.subscribers.indexOf(callback);
            if (idx !== -1) {
                this.subscribers.splice(idx, 1);
            }
        };
    }
    /**
     * Remove all subscribers. Used by tests to reset state, and during
     * extension deactivation if the AuditLog instance outlives its
     * subscribers (it shouldn't, but defensive).
     */
    clearSubscribers() {
        this.subscribers = [];
    }
    // ─── Internals ─────────────────────────────────────────────────
    async doEmit(args) {
        if (!this.initialized) {
            // Lazy init if emit() called before init(). Shouldn't happen
            // if container wires correctly but we'd rather log silently
            // than throw.
            await this.init();
        }
        const baseRecord = {
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
        const record = baseRecord;
        const newHash = computeRecordHash(record);
        // Persist
        try {
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const filepath = path.join(this.auditDir, `audit-${today}.jsonl`);
            await fs.appendFile(filepath, JSON.stringify(record) + '\n', 'utf-8');
            this.lastHash = newHash;
            // Notify subscribers AFTER the write succeeds. A failing
            // write skips notification — subscribers should only see
            // records that are durably on disk. Each subscriber is
            // wrapped in try/catch so one misbehaving listener can't
            // stall the audit pipeline or affect other subscribers.
            for (const fn of this.subscribers) {
                try {
                    fn(record);
                }
                catch (subErr) {
                    console.warn('[audit] subscriber threw:', subErr);
                }
            }
        }
        catch (e) {
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
    async readLastHashFromDisk() {
        const files = await fs.readdir(this.auditDir).catch(() => []);
        const auditFiles = files
            .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
            .sort()
            .reverse(); // newest first
        for (const file of auditFiles) {
            const content = await fs.readFile(path.join(this.auditDir, file), 'utf-8').catch(() => '');
            const lines = content.split('\n').filter(l => l.trim() !== '');
            if (lines.length === 0) {
                continue;
            }
            const lastLine = lines[lines.length - 1];
            try {
                const lastRecord = JSON.parse(lastLine);
                return computeRecordHash(lastRecord);
            }
            catch {
                // malformed last line — try the file before it
                continue;
            }
        }
        return types_1.GENESIS_HASH;
    }
}
exports.AuditLog = AuditLog;
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
function computeRecordHash(record) {
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
function canonicalJson(value) {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'undefined')
        return 'null'; // JSON treats undefined as missing/null in objects
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }
    if (typeof value === 'object') {
        const obj = value;
        const keys = Object.keys(obj).sort();
        const parts = keys
            .filter(k => obj[k] !== undefined) // skip undefined fields (matches JSON.stringify behavior)
            .map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
        return '{' + parts.join(',') + '}';
    }
    // Functions, symbols, etc. — JSON.stringify would skip them. Same here.
    return 'null';
}
function startOfDay(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
}
//# sourceMappingURL=AuditLog.js.map