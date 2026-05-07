#!/usr/bin/env node
/**
 * my-cli — entry point.
 *
 * Subcommand routing without a parsing library. Add new subcommands
 * by adding a file under src/commands/ and wiring it into the
 * COMMANDS map below.
 *
 * Exit codes:
 *   0 — command completed successfully
 *   1 — command failed (runtime error, invalid input, etc.)
 *   2 — usage error (unknown command, missing required arg)
 */

import { greet } from './commands/greet.js';
import { sum } from './commands/sum.js';

type CommandHandler = (args: readonly string[]) => Promise<number> | number;

const COMMANDS: Record<string, { handler: CommandHandler; usage: string }> = {
    greet: {
        handler: greet,
        usage: 'greet --name <name> [--shout]',
    },
    sum: {
        handler: sum,
        usage: 'sum <number> [<number>...]',
    },
};

function printUsage(): void {
    const lines = [
        'Usage: my-cli <command> [options]',
        '',
        'Commands:',
        ...Object.entries(COMMANDS).map(
            ([name, { usage }]) => `  ${name.padEnd(8)} ${usage}`
        ),
        '',
        'Run `my-cli <command> --help` for command-specific options.',
    ];
    console.log(lines.join('\n'));
}

export async function main(argv: readonly string[]): Promise<number> {
    const [command, ...rest] = argv;

    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return command ? 0 : 2;
    }

    const entry = COMMANDS[command];
    if (!entry) {
        console.error(`Unknown command: ${command}`);
        printUsage();
        return 2;
    }

    try {
        return await entry.handler(rest);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        return 1;
    }
}

// Run as CLI when invoked directly (skip when imported by tests).
// `import.meta.url` resolves to a file:// URL; we compare against
// the entry argv to detect direct invocation.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err) => {
            console.error('Fatal:', err);
            process.exit(1);
        }
    );
}
