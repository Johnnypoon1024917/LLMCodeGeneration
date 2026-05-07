"use strict";
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
exports.log = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Lazy-initialized singleton. We avoid creating the channel at module-load
 * time because some unit tests / the headless CLI import this transitively
 * before vscode is available.
 */
class Logger {
    channel;
    getChannel() {
        if (!this.channel) {
            // `{ log: true }` makes this a LogOutputChannel — VS Code 1.74+
            // formats entries with timestamps, levels, and persists them
            // to disk for the user to attach to bug reports.
            this.channel = vscode.window.createOutputChannel("NexusCode", { log: true });
        }
        return this.channel;
    }
    /** Bring the OutputChannel to the foreground. */
    show(preserveFocus = true) {
        this.getChannel().show(preserveFocus);
    }
    /** Append a fine-grained trace line; visible only at the "Trace" level. */
    trace(message, ...args) {
        this.getChannel().trace(this.format(message, args));
    }
    /** Append a debug line; visible at "Debug" or finer. */
    debug(message, ...args) {
        this.getChannel().debug(this.format(message, args));
    }
    /** Default level for ordinary informational events. */
    info(message, ...args) {
        this.getChannel().info(this.format(message, args));
    }
    /** Recoverable issue — something to investigate but not failing. */
    warn(message, ...args) {
        this.getChannel().warn(this.format(message, args));
    }
    /** Failure — pass the Error to capture its stack trace. */
    error(message, ...args) {
        this.getChannel().error(this.format(message, args));
    }
    /**
     * Attach the channel as a context subscription so VS Code disposes it
     * cleanly on extension shutdown. Call once from `activate(context)`.
     */
    register(context) {
        context.subscriptions.push(this.getChannel());
    }
    format(message, args) {
        if (args.length === 0) {
            return message;
        }
        return `${message} ${args.map(formatArg).join(' ')}`;
    }
}
function formatArg(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    return String(value);
}
/** The singleton. Import as `import { log } from './logger';`. */
exports.log = new Logger();
//# sourceMappingURL=logger.js.map