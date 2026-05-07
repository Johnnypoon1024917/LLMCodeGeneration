"use strict";
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
exports.runExport = runExport;
exports.runVerify = runVerify;
const fs = __importStar(require("fs/promises"));
const container_1 = require("../container");
async function runExport(options) {
    const filter = {};
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
    const records = await (0, container_1.getDeps)().audit.readRecords(filter);
    const format = options.format ?? 'jsonl';
    const output = format === 'csv' ? toCsv(records) : toJsonl(records);
    if (options.output) {
        await fs.writeFile(options.output, output, 'utf-8');
        process.stderr.write(`Exported ${records.length} records to ${options.output}\n`);
    }
    else {
        process.stdout.write(output);
    }
}
async function runVerify() {
    const result = await (0, container_1.getDeps)().audit.verifyChain();
    if (result.valid) {
        process.stdout.write(`Chain integrity: OK\n`);
        process.exit(0);
    }
    else {
        process.stdout.write(`Chain integrity: BROKEN\n`);
        process.stdout.write(`Records with hash mismatches:\n`);
        for (const id of result.brokenAt) {
            process.stdout.write(`  ${id}\n`);
        }
        process.exit(1);
    }
}
// ─── Formatters ────────────────────────────────────────────────────
function toJsonl(records) {
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
function toCsv(records) {
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
function csvEscape(value) {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
//# sourceMappingURL=exportCli.js.map