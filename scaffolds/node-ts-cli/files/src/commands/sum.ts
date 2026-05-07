/**
 * `sum` subcommand — demonstrates positional argument handling
 * and input validation.
 *
 * Usage:
 *   my-cli sum 1 2 3 4   # → 10
 */

export function sum(args: readonly string[]): number {
    if (args.length === 0) {
        throw new Error('sum requires at least one number');
    }

    const numbers = args.map((arg, idx) => {
        const n = Number(arg);
        if (!Number.isFinite(n)) {
            throw new Error(`Argument ${idx + 1} is not a finite number: ${arg}`);
        }
        return n;
    });

    const total = numbers.reduce((acc, n) => acc + n, 0);
    console.log(String(total));
    return 0;
}
