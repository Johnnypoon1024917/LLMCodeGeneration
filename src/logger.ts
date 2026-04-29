// src/logger.ts
//
// Single OutputChannel-based logger for the entire extension.
//
// Why this exists:
//   `console.log` from an extension goes to the Extension Host log file,
//   which users can't see without enabling debug mode and digging through
//   `~/.vscode/logs/.../exthost-*/output.log`. That makes bug reports
//   useless — users can't paste anything actionable. An OutputChannel,
//   created with `{ log: true }`, gives us a real log file at
//   `~/.vscode/logs/.../exthost*/output_logging_*/N-NexusCode.log`
//   that the user can attach to issues directly.
//
// Migration plan:
//   This file ships in a "additive" form first: it's available as the
//   `log` singleton, and a few critical sites (extension activation,
//   error paths) use it. The bulk migration of ~66 console.* calls
//   across 17 source files is a follow-up patch — this file is the
//   foundation.
//
// Usage:
//   import { log } from './logger';
//   log.info("Webview ready, hydrated", { tasks: tasks.length });
//   log.warn("Skipping malformed step", step);
//   log.error("LLM call failed", err);
//   log.show();   // bring the panel forward (used by error toasts)

import * as vscode from 'vscode';

/** Levels match VS Code's LogOutputChannel levels (which mirror RFC 5424). */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Lazy-initialized singleton. We avoid creating the channel at module-load
 * time because some unit tests / the headless CLI import this transitively
 * before vscode is available.
 */
class Logger {
    private channel: vscode.LogOutputChannel | undefined;

    private getChannel(): vscode.LogOutputChannel {
        if (!this.channel) {
            // `{ log: true }` makes this a LogOutputChannel — VS Code 1.74+
            // formats entries with timestamps, levels, and persists them
            // to disk for the user to attach to bug reports.
            this.channel = vscode.window.createOutputChannel("NexusCode", { log: true });
        }
        return this.channel;
    }

    /** Bring the OutputChannel to the foreground. */
    show(preserveFocus: boolean = true): void {
        this.getChannel().show(preserveFocus);
    }

    /** Append a fine-grained trace line; visible only at the "Trace" level. */
    trace(message: string, ...args: unknown[]): void {
        this.getChannel().trace(this.format(message, args));
    }

    /** Append a debug line; visible at "Debug" or finer. */
    debug(message: string, ...args: unknown[]): void {
        this.getChannel().debug(this.format(message, args));
    }

    /** Default level for ordinary informational events. */
    info(message: string, ...args: unknown[]): void {
        this.getChannel().info(this.format(message, args));
    }

    /** Recoverable issue — something to investigate but not failing. */
    warn(message: string, ...args: unknown[]): void {
        this.getChannel().warn(this.format(message, args));
    }

    /** Failure — pass the Error to capture its stack trace. */
    error(message: string, ...args: unknown[]): void {
        this.getChannel().error(this.format(message, args));
    }

    /**
     * Attach the channel as a context subscription so VS Code disposes it
     * cleanly on extension shutdown. Call once from `activate(context)`.
     */
    register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(this.getChannel());
    }

    private format(message: string, args: unknown[]): string {
        if (args.length === 0) {
            return message;
        }
        return `${message} ${args.map(formatArg).join(' ')}`;
    }
}

function formatArg(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/** The singleton. Import as `import { log } from './logger';`. */
export const log = new Logger();