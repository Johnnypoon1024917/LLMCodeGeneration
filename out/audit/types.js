"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENESIS_HASH = void 0;
/**
 * Genesis hash — used as the prevHash for the very first audit record
 * ever written. It is the SHA-256 of the empty string, which is the
 * standard "no input" hash in cryptographic contexts.
 */
exports.GENESIS_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
//# sourceMappingURL=types.js.map