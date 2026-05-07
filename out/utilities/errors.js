"use strict";
// src/utilities/errors.ts
// Helpers for narrowing `catch (e: unknown)` to readable shapes.
// Why this exists: TS 4.4+ defaults catch clauses to `unknown` when
// `useUnknownInCatchVariables` is on (or when the codebase opts in). Reading
// `.message` directly off an `unknown` is a type error. These helpers do the
// narrowing once, in one place, instead of every catch site re-implementing it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMessage = errorMessage;
exports.errorStack = errorStack;
exports.errorName = errorName;
exports.isAbortError = isAbortError;
exports.execErrorOutput = execErrorOutput;
/** Extract a readable string from anything thrown. */
function errorMessage(e) {
    if (e instanceof Error) {
        return e.message;
    }
    if (typeof e === 'string') {
        return e;
    }
    if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
        return e.message;
    }
    try {
        return JSON.stringify(e);
    }
    catch {
        return String(e);
    }
}
/** Extract a stack trace if present. */
function errorStack(e) {
    return e instanceof Error ? e.stack : undefined;
}
/** Extract the `.name` property if present (commonly used to check 'AbortError'). */
function errorName(e) {
    if (e instanceof Error) {
        return e.name;
    }
    if (e && typeof e === 'object' && 'name' in e && typeof e.name === 'string') {
        return e.name;
    }
    return undefined;
}
/** True if the error is an AbortError (from AbortController.signal). */
function isAbortError(e) {
    if (errorName(e) === 'AbortError') {
        return true;
    }
    // Fallback: some libraries set the name correctly only after wrapping.
    const msg = errorMessage(e).toLowerCase();
    return msg.includes('aborted') || msg.includes('the operation was aborted');
}
/**
 * Errors thrown by Node's child_process exec/execFile/spawnSync attach
 * `.stdout` and `.stderr` strings to the Error. This pulls out the most
 * useful text (preferring stderr, falling back to stdout, then message).
 */
function execErrorOutput(e) {
    if (e && typeof e === 'object') {
        const obj = e;
        const stderr = typeof obj.stderr === 'string' ? obj.stderr : undefined;
        const stdout = typeof obj.stdout === 'string' ? obj.stdout : undefined;
        if (stderr && stderr.trim()) {
            return stderr;
        }
        if (stdout && stdout.trim()) {
            return stdout;
        }
    }
    return errorMessage(e);
}
//# sourceMappingURL=errors.js.map