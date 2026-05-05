// webview-ui/src/components/ui/cn.ts
//
// Utility for conditionally composing Tailwind class names without
// duplicate-utility conflicts.
//
// `clsx` builds the class string from its varied input shapes (strings,
// arrays, conditional objects). `twMerge` then resolves any conflicting
// Tailwind utilities — e.g. `cn('p-4', condition && 'p-2')` produces
// just `p-2`, not `p-4 p-2`. This matters because Tailwind's last-wins
// semantics happen at the CSS-cascade level, but raw class concatenation
// can leave both classes in the DOM and surprise readers of the output.
//
// Standard pattern from the Radix/Tailwind ecosystem; lifted as-is so
// any engineer who's worked in shadcn or vanilla Radix recognizes it.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}