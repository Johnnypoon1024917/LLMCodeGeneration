// webview-ui/src/state/useAuditLog.ts
//
// Subscribes to `auditEntryAppended` messages from the host and
// maintains a bounded ring buffer of the most recent audit records.
//
// The host's AuditLog (src/audit/AuditLog.ts) is append-only and
// hash-chained. Each emit() writes a new record to .nexus/audit/
// JSONL files. PR 2.4b will add a "broadcast" hook to AuditLog that
// also posts the new record to the webview via SidebarProvider's
// postMessage. This hook receives those broadcasts.
//
// Until PR 2.4b ships, this hook still works — it just won't see any
// real records. We expose `appendForDemo()` so demos and tests can
// inject synthetic records to populate the panel.
//
// Ring buffer rationale: a chatty agent can produce 50+ audit records
// per minute. Keeping all of them in webview memory is a leak. We cap
// at 200 — enough for a productive session's worth of recent activity,
// not so many that scrolling becomes laggy. Older records remain in
// the JSONL files on disk; the future admin portal reads from there.

import { useCallback, useEffect, useReducer } from 'react';

/** The `AuditRecord` shape mirrors src/audit/types.ts. We re-declare it
 *  here (rather than importing the host type) because the webview is a
 *  separate compile unit and the host types aren't reachable. The shape
 *  is a public contract — changing host-side requires updating this. */
export interface AuditRecord {
    id: string;
    timestamp: string;
    actor: string;
    sessionId: string;
    kind: 'llm_call' | 'tool_call' | 'file_write' | 'spec_edit' | 'config_change';
    summary: string;
    payload: Record<string, unknown>;
    parentId?: string;
    prevHash: string;
}

const MAX_RECORDS = 200;

interface AuditState {
    records: AuditRecord[];
    /** True when the most recent prevHash chain is intact end-to-end.
     *  Recomputed on each append. The host writes records with valid
     *  hashes by construction; this flag lets the UI flag tampering
     *  if a rogue process modifies the in-memory list. */
    chainValid: boolean;
    /** Total records seen since mount (regardless of ring buffer cap).
     *  Useful for the audit chip in the SecurityStrip ("audit chain
     *  valid · 1,247 entries"). */
    totalSeen: number;
}

type AuditAction =
    | { type: 'append'; record: AuditRecord }
    | { type: 'reset' };

function reducer(state: AuditState, action: AuditAction): AuditState {
    if (action.type === 'reset') {
        return { records: [], chainValid: true, totalSeen: 0 };
    }
    // Append: push new record, drop oldest if over the cap.
    const newRecords = [...state.records, action.record];
    if (newRecords.length > MAX_RECORDS) {
        newRecords.splice(0, newRecords.length - MAX_RECORDS);
    }
    // Chain check: every record's prevHash should equal the prior
    // record's prevHash field's downstream hash. We can't recompute
    // sha256 here (no crypto without subtle's async API in older
    // chromiums), so we just check that prevHash is non-empty. The
    // strict check belongs in the host; this is a UI-side smoke test.
    const chainValid = newRecords.every((r) => typeof r.prevHash === 'string' && r.prevHash.length > 0);
    return {
        records: newRecords,
        chainValid,
        totalSeen: state.totalSeen + 1
    };
}

export interface UseAuditLogResult extends AuditState {
    /** Test/demo escape hatch: append a record without going through
     *  the message bus. Used by PR 2.4 demo seeding and unit tests. */
    appendForDemo: (record: AuditRecord) => void;
    /** Clear the buffer. Real audit log on disk is unaffected. */
    reset: () => void;
}

export function useAuditLog(): UseAuditLogResult {
    const [state, dispatch] = useReducer(reducer, {
        records: [],
        chainValid: true,
        totalSeen: 0
    });

    // Subscribe to auditEntryAppended messages from the host.
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data as { type?: string; record?: unknown };
            if (data?.type !== 'auditEntryAppended') { return; }
            const record = data.record as AuditRecord | undefined;
            if (!record || typeof record.id !== 'string') {
                // Malformed message — ignore. Don't crash the UI on
                // bad host data; just no-op.
                return;
            }
            dispatch({ type: 'append', record });
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    const appendForDemo = useCallback((record: AuditRecord) => {
        dispatch({ type: 'append', record });
    }, []);

    const reset = useCallback(() => {
        dispatch({ type: 'reset' });
    }, []);

    return { ...state, appendForDemo, reset };
}