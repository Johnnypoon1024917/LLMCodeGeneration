// src/audit/types.ts
//
// Types for the audit logging system.
//
// Records are append-only and form a hash chain for tamper-evidence:
// each record's `prevHash` field points to the SHA-256 of the previous
// record's full payload. Verifying chain integrity means recomputing
// each `prevHash` from scratch and checking it matches.
//
// All audit data is persisted as JSONL (one record per line) at
// `.nexus/audit/audit-<YYYY-MM-DD>.jsonl`. The JSONL format is
// deliberately human-readable (greppable, importable to Excel via
// jq/csv conversion). It is NOT encrypted at rest; per the design
// decision, encryption is a v2 concern when a customer specifically
// requires data-at-rest protection.

/**
 * Event kinds that get audited. Keep this list intentionally small —
 * extending it requires version-bumping the schema and writing a
 * migration story for existing log files.
 *
 * If you find yourself wanting to add a new kind, first ask: would a
 * compliance auditor specifically request this? If not, it doesn't
 * belong here.
 */
export type AuditEventKind =
    /** LLM API call: model invoked, prompt + response tracked. */
    | 'llm_call'
    /** Agent tool invocation: read_file, grep, bash, write_file, etc. */
    | 'tool_call'
    /** File modification by the agent (post-verification). */
    | 'file_write'
    /** Spec workflow change: requirement edit, plan revision, task status. */
    | 'spec_edit'
    /** User config change: API endpoint, model, autopilot toggles. */
    | 'config_change'
    /** Hook fire: a .nexus/hooks/*.md hook was triggered. P1.4 added
     *  this so security-conscious users can audit hook activity
     *  separately from agent activity. Hooks are a different category
     *  of write because they fire automatically (file save / schedule)
     *  rather than as part of an explicit user-initiated agent run. */
    | 'hook_fire';

/**
 * A single audit record. Written one-per-line as JSON.
 *
 * Field stability: this shape is part of the on-disk format. Adding new
 * fields is fine (older parsers tolerate). Renaming or removing fields
 * requires a schema-version bump and migration logic.
 */
export interface AuditRecord {
    /** UUIDv4 for cross-record reference. Generated at write time. */
    id: string;
    /** ISO 8601 timestamp with timezone. Generated at write time. */
    timestamp: string;
    /** Identity of the actor: "user@host" in v1.0 from os.userInfo(). */
    actor: string;
    /** Session ID — one per Coordinator/CLI session, groups related records. */
    sessionId: string;
    /** Event kind discriminator. */
    kind: AuditEventKind;
    /** Human-readable one-liner. Used in grep / portal previews. */
    summary: string;
    /** Structured payload. Shape varies per kind — see docstring below. */
    payload: Record<string, unknown>;
    /**
     * Optional parent record ID. For example, a `tool_call` triggered
     * by an `llm_call` would set parentId to the LLM call's id, allowing
     * reconstruction of the agent's decision tree.
     */
    parentId?: string;
    /**
     * SHA-256 hex digest of the previous record's serialized form,
     * including its own prevHash. The first record of a session uses
     * the previous-day's last-record hash, OR the genesis hash
     * (sha256('') = 'e3b0c44...') if this is the first record ever.
     *
     * Verification: re-compute this field from prior record. Mismatch
     * means tampering. Specifically:
     *   prevHash[i] === sha256(JSON.stringify(records[i-1]))
     */
    prevHash: string;
}

/**
 * Payload shapes per kind. Documented but not type-enforced (we keep
 * `payload: Record<string, unknown>` in the record so older parsers
 * tolerate schema evolution). Use the helper functions below to
 * construct payloads with the right shape.
 */
export interface LlmCallPayload {
    /** Model name as the user would recognize it (e.g. "qwen3.6-27b"). */
    model: string;
    /** API endpoint URL hit (no auth tokens included). */
    endpoint: string;
    /** Token counts. May be undefined if the response was aborted. */
    promptTokens?: number;
    completionTokens?: number;
    /** Approximate prompt size for sanity-check (first 200 chars). */
    promptPreview?: string;
    /** Whether the call completed successfully or errored. */
    status: 'ok' | 'error' | 'aborted';
    /** Error message if status is 'error'. */
    errorMessage?: string;
}

export interface ToolCallPayload {
    /** Tool name: "read_file" | "grep" | "bash" | "write_file" | etc. */
    tool: string;
    /** Tool input arguments. Sensitive content (env vars, secrets) should be redacted by callers. */
    input: Record<string, unknown>;
    /** Tool execution status. */
    status: 'ok' | 'error' | 'aborted';
    /** Error message if status is 'error'. */
    errorMessage?: string;
    /** Output preview (first 500 chars) for compliance review. Full output not stored to keep log size manageable. */
    outputPreview?: string;
}

export interface FileWritePayload {
    /** Workspace-relative path of the file written. */
    filepath: string;
    /** SHA-256 of the new file content (verifies what was written). */
    fileHash: string;
    /** Number of bytes written. */
    bytes: number;
    /** Whether this was a new file or modification of an existing one. */
    operation: 'create' | 'modify' | 'delete';
}

export interface SpecEditPayload {
    /** Spec slug (e.g. "main", "user-auth"). */
    spec: string;
    /** Phase touched: requirements, design, or tasks. */
    phase: 'requirements' | 'design' | 'tasks';
    /** Brief summary of change (e.g. "Added 3 requirements", "Marked task 2 complete"). */
    description: string;
}

export interface ConfigChangePayload {
    /** Config key (e.g. "nexuscode.apiEndpoint"). */
    key: string;
    /** Old value (redacted for sensitive keys like apiKey). */
    oldValue?: string;
    /** New value (redacted for sensitive keys). */
    newValue?: string;
}

/**
 * P1.4: hook fire audit payload.
 *
 * Captures enough detail for compliance review: which hook ran, what
 * triggered it, what file (if any), how long, terminal status. The
 * full hook prompt and full output are NOT included by default — they
 * can be large and may contain sensitive content; hook-output content
 * is best surfaced via chat UI, not the audit log. If a customer needs
 * full prompt/output capture they can extend this payload with an
 * explicit opt-in.
 */
export interface HookFirePayload {
    /** Hook id (filename without `.md`). */
    hookId: string;
    /** Human-readable hook name from frontmatter. */
    hookName: string;
    /** What triggered the fire. */
    triggerType: 'onFileSave' | 'onCommand' | 'onSchedule';
    /** File that triggered (workspace-relative), when applicable. */
    filePath?: string;
    /** Wall-clock duration ms. */
    durationMs: number;
    /** Terminal status. Mirrors HookFireCompletedEvent.status. */
    status: 'success' | 'error' | 'timeout' | 'skipped';
    /** Cause string for error/timeout/skipped. Absent for success. */
    errorMessage?: string;
}

/**
 * Genesis hash — used as the prevHash for the very first audit record
 * ever written. It is the SHA-256 of the empty string, which is the
 * standard "no input" hash in cryptographic contexts.
 */
export const GENESIS_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';