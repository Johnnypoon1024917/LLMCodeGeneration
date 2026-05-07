/**
 * `greet` subcommand — demonstrates flag parsing.
 *
 * Usage:
 *   my-cli greet --name Alice
 *   my-cli greet --name Alice --shout
 */

interface GreetOptions {
    name: string;
    shout: boolean;
}

function parseArgs(args: readonly string[]): GreetOptions {
    let name: string | undefined;
    let shout = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--name') {
            const value = args[i + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--name requires a value');
            }
            name = value;
            i++;
        } else if (arg === '--shout') {
            shout = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: my-cli greet --name <name> [--shout]');
            // Help is signaled by a sentinel — caller checks via exception.
            throw new HelpRequested();
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!name) {
        throw new Error('--name is required');
    }
    return { name, shout };
}

class HelpRequested extends Error {
    constructor() {
        super('help requested');
        this.name = 'HelpRequested';
    }
}

export function greet(args: readonly string[]): number {
    let opts: GreetOptions;
    try {
        opts = parseArgs(args);
    } catch (err) {
        if (err instanceof HelpRequested) {
            return 0;
        }
        throw err;
    }
    const message = `Hello, ${opts.name}!`;
    console.log(opts.shout ? message.toUpperCase() : message);
    return 0;
}
