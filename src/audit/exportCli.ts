// src/audit/exportCli.ts
//
// Implementation of the `nexuscode audit export` CLI subcommand.
//
// Goal: let compliance auditors pull audit logs out of a deployed
// NexusCode workspace into formats they can use (CSV for Excel,
// JSONL for further programmatic processing).
//
// Usage:
//   nexuscode audit export                      # all records, JSONL to stdout
//   nexuscode audit export --format csv         # CSV instead
//   nexuscode audit export --since 2026-04-01   # filter by date
//   nexuscode audit export --until 2026-04-30
//   nexuscode audit export --output audit.csv   # write to file
//   nexuscode audit verify                      # check chain integrity
//
// The export is read-only — never modifies the source log files.

import * as fs from 'fs/promises';
import { getDeps } from '../container';
import type { AuditRecord } from './types';

export interface ExportOptions {
    format?: 'jsonl' | 'csv';
    since?: string; // ISO date string
    until?: string; // ISO date string
    output?: string; // filepath; if omitted, writes to stdout
}

export async function runExport(options: ExportOptions): Promise<void> {
    const filter: { since?: Date; until?: Date } = {};
    if (options.since) {
        const sinceDate = new Date(options.since);
        if (isNaN(sinceDate.getTime())) {
            throw new Error(`Invalid --since date: ${options.since}. Use ISO format (e.g. 2026-04-01).`);
        }
        filter.since = sinceDate;
    }
    if (options.until) {
        const untilDate = new Date(options.until);
        if (isNaN(untilDate.getTime())) {
            throw new Error(`Invalid --until date: ${options.until}. Use ISO format (e.g. 2026-04-30).`);
        }
        // End-of-day for "until" so users naturally include the full day
        untilDate.setHours(23, 59, 59, 999);
        filter.until = untilDate;
    }

    const records = await getDeps().audit.readRecords(filter);

    const format = options.format ?? 'jsonl';
    const output = format === 'csv' ? toCsv(records) : toJsonl(records);

    if (options.output) {
        await fs.writeFile(options.output, output, 'utf-8');
        process.stderr.write(`Exported ${records.length} records to ${options.output}\n`);
    } else {
        process.stdout.write(output);
    }
}

export async function runVerify(): Promise<void> {
    const result = await getDeps().audit.verifyChain();
    if (result.valid) {
        process.stdout.write(`Chain integrity: OK\n`);
        process.exit(0);
    } else {
        process.stdout.write(`Chain integrity: BROKEN\n`);
        process.stdout.write(`Records with hash mismatches:\n`);
        for (const id of result.brokenAt) {
            process.stdout.write(`  ${id}\n`);
        }
        process.exit(1);
    }
}

// ─── Formatters ────────────────────────────────────────────────────

function toJsonl(records: AuditRecord[]): string {
    return records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

/**
 * Flatten records to CSV. The payload column is JSON-stringified to keep
 * each record on one row (CSV can't naturally represent nested data).
 *
 * Quoting follows RFC 4180:
 *   - Fields with comma, double-quote, or newline are quoted with "
 *   - Embedded " is doubled
 */
function toCsv(records: AuditRecord[]): string {
    const headers = ['id', 'timestamp', 'actor', 'sessionId', 'kind', 'summary', 'parentId', 'prevHash', 'payload'];
    const rows = [headers.join(',')];
    for (const r of records) {
        rows.push([
            csvEscape(r.id),
            csvEscape(r.timestamp),
            csvEscape(r.actor),
            csvEscape(r.sessionId),
            csvEscape(r.kind),
            csvEscape(r.summary),
            csvEscape(r.parentId ?? ''),
            csvEscape(r.prevHash),
            csvEscape(JSON.stringify(r.payload))
        ].join(','));
    }
    return rows.join('\n') + '\n';
}

function csvEscape(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}