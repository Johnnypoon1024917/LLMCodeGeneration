// src/utilities/errors.ts
// Helpers for narrowing `catch (e: unknown)` to readable shapes.
// Why this exists: TS 4.4+ defaults catch clauses to `unknown` when
// `useUnknownInCatchVariables` is on (or when the codebase opts in). Reading
// `.message` directly off an `unknown` is a type error. These helpers do the
// narrowing once, in one place, instead of every catch site re-implementing it.

/** Extract a readable string from anything thrown. */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) {
        return e.message;
    }
    if (typeof e === 'string') {
        return e;
    }
    if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
        return (e as { message: string }).message;
    }
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}

/** Extract a stack trace if present. */
export function errorStack(e: unknown): string | undefined {
    return e instanceof Error ? e.stack : undefined;
}

/** Extract the `.name` property if present (commonly used to check 'AbortError'). */
export function errorName(e: unknown): string | undefined {
    if (e instanceof Error) {
        return e.name;
    }
    if (e && typeof e === 'object' && 'name' in e && typeof (e as { name: unknown }).name === 'string') {
        return (e as { name: string }).name;
    }
    return undefined;
}

/** True if the error is an AbortError (from AbortController.signal). */
export function isAbortError(e: unknown): boolean {
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
export function execErrorOutput(e: unknown): string {
    if (e && typeof e === 'object') {
        const obj = e as { stderr?: unknown; stdout?: unknown };
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