// src/scaffold/greenfieldDetector.ts
//
// Pure greenfield detection logic for V2.1 project scaffolder.
//
// Greenfield = workspace where the user wants to start a new project,
// vs an existing project they want to extend. We detect it from THREE
// signals, deterministically combinable so callers can decide their
// own confidence threshold:
//
//   1. Workspace shape — empty workspace (or near-empty, no canonical
//      project marker) is a strong greenfield signal.
//
//   2. Prompt verbs — "build a new", "create a", "scaffold", "make me"
//      with no anaphoric reference to "this codebase" / "this project"
//      is a moderate greenfield signal.
//
//   3. Stack hint — extracted from the prompt for downstream template
//      pre-selection. "build a Python CLI" → stackHint='python'.
//
// We DO NOT auto-scaffold in V2.1, even on high confidence. The UI
// always confirms with the user. The confidence is informational —
// it lets us pre-select the most-likely template in the dropdown
// and order suggestions sensibly.
//
// Pure module: no fs reads, no vscode imports. Caller passes in the
// workspace file inventory. This keeps the logic testable without
// spinning up VS Code.

/**
 * The set of "this is a real project" marker files. Presence of ANY
 * of these in the workspace root strongly indicates the workspace
 * is NOT greenfield — the user has an existing project they want
 * to extend.
 *
 * Order doesn't matter; we just check for any match.
 */
export const PROJECT_MARKER_FILES: ReadonlyArray<string> = [
    // Node ecosystem
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    // Python ecosystem
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'Pipfile',
    'poetry.lock',
    // Rust
    'Cargo.toml',
    'Cargo.lock',
    // Go
    'go.mod',
    'go.sum',
    // Java/Kotlin/JVM
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    // Ruby
    'Gemfile',
    'Gemfile.lock',
    // PHP
    'composer.json',
    'composer.lock',
    // Swift
    'Package.swift',
    // C/C++/CMake
    'CMakeLists.txt',
    'Makefile',
    // .NET
    '*.csproj',
    '*.fsproj',
    '*.sln',
    // Misc
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
];

/**
 * Verbs that strongly suggest the user wants to START SOMETHING NEW
 * rather than modify an existing thing. Lowercased — caller passes
 * lowercased prompt.
 *
 * "build" alone is intentionally NOT in the list — "build the test
 * suite" or "build out the auth module" are existing-project actions.
 * We require a determiner ("a", "me", "us") or "new" to disambiguate.
 */
const GREENFIELD_VERB_PATTERNS: ReadonlyArray<RegExp> = [
    /\bbuild\s+(a|me|us|the)\s+new\b/i,
    /\bbuild\s+(a|me|us)\s+\w+/i,           // "build a CLI" / "build me an API"
    /\bcreate\s+(a|me|us|the)\s+new\b/i,
    /\bcreate\s+(a|me|us)\s+\w+/i,
    /\bmake\s+(me|us)\s+a\s+/i,
    /\bscaffold\s+(a|me|us|the)\s+/i,
    /\bset\s*up\s+(a|me|us|the)\s+new\b/i,
    /\bstart\s+(a|me|us|the)\s+new\b/i,
    /\bnew\s+project\b/i,
    /\bfrom\s+scratch\b/i,
];

/**
 * Phrases that indicate the user is referring to AN EXISTING codebase
 * — "in this repo", "this project", "the existing code", etc. Strong
 * signal NOT to auto-scaffold even if other signals say greenfield.
 *
 * We lowercase before matching to keep the pattern set small.
 */
const ANAPHORIC_PROJECT_PHRASES: ReadonlyArray<RegExp> = [
    /\bthis\s+(repo|repository|codebase|project)\b/i,
    /\bthe\s+(repo|repository|codebase|project)\b/i,
    /\bexisting\s+(code|codebase|project)\b/i,
    /\bin\s+this\s+(folder|directory|workspace)\b/i,
    /\badd\s+(to|into|onto)\b/i,
    /\bextend\s+(this|the)\b/i,
    /\bmodify\s+(this|the)\b/i,
    /\bedit\s+(this|the|existing)\b/i,
    /\brefactor\b/i,
    /\bfix\s+(this|the|a)\s+bug/i,
];

/**
 * Stack-hint patterns. Maps user-language phrases to a normalized
 * stack identifier. Caller can use this to pre-select the right
 * template in the confirmation dialog. NOT exhaustive — we only
 * include the stacks V2.1 ships first-class templates for; other
 * stacks fall through to LLM-fallback scaffolding (not implemented
 * in V2.1.1, comes in V2.1.3).
 */
const STACK_HINT_PATTERNS: ReadonlyArray<{ pattern: RegExp; stack: string }> = [
    // React + Vite first because "react" alone could be Next.js,
    // CRA, or Vite. We prefer Vite for new projects per current
    // ecosystem trends. If user explicitly wants Next, that's
    // LLM-fallback territory.
    { pattern: /\b(react.*vite|vite.*react)\b/i, stack: 'react-vite' },
    { pattern: /\bnext\.?js\b/i, stack: 'react-vite' }, // approximate — LLM-fallback later
    { pattern: /\breact\b/i, stack: 'react-vite' },

    // Node + TypeScript variants
    { pattern: /\b(node|typescript).*\b(api|rest|http|server|express|fastify)\b/i, stack: 'node-ts-api' },
    { pattern: /\b(api|rest|http|server|express|fastify).*\b(node|typescript|ts)\b/i, stack: 'node-ts-api' },
    { pattern: /\btypescript.*\b(cli|command.line|tool)\b/i, stack: 'node-ts-cli' },
    { pattern: /\b(cli|command.line|tool).*\btypescript\b/i, stack: 'node-ts-cli' },
    { pattern: /\btypescript\b/i, stack: 'node-ts-cli' },
    { pattern: /\bts\b/i, stack: 'node-ts-cli' },
    { pattern: /\bnode\.?js?\b/i, stack: 'node-ts-cli' },

    // Python
    { pattern: /\b(python|py).*\b(api|fastapi|flask|web)\b/i, stack: 'python-fastapi' },
    { pattern: /\bfastapi\b/i, stack: 'python-fastapi' },
    { pattern: /\bpython\b/i, stack: 'python-cli' },
];

/**
 * Inputs the detector needs. Caller is responsible for collecting
 * the workspace file list and passing it in — this module doesn't
 * touch the filesystem. The list should contain top-level entries
 * (one or two levels deep is fine; the detector only uses presence
 * of marker filenames).
 */
export interface GreenfieldDetectionInput {
    /** The user's prompt as typed. Detector lowercases internally. */
    prompt: string;
    /** Top-level filenames in the workspace (NOT full paths — just
     *  basenames). Caller pre-filters node_modules / .git etc. */
    topLevelFilenames: ReadonlyArray<string>;
    /** Total file count in workspace (excluding common ignored dirs).
     *  Used as a tiebreaker — a workspace with 100 random files is
     *  almost certainly NOT greenfield even if no marker files exist. */
    totalFileCount: number;
}

/**
 * Detection result. `confidence` describes how sure we are this is
 * greenfield; `stackHint` is the pre-selection guess for the dropdown.
 *
 * The UI ALWAYS asks the user before scaffolding regardless of
 * confidence — confidence just orders the suggestions.
 */
export interface GreenfieldDetectionResult {
    isGreenfield: boolean;
    confidence: 'low' | 'medium' | 'high';
    /** Best-guess stack identifier for pre-selection in the dropdown.
     *  Undefined when no confident hint is found. */
    stackHint?: string;
    /** Internal reasoning surfaced for debugging / audit log. Not
     *  user-facing today; future v2.6 governance work may surface
     *  these in the audit trail. */
    signals: {
        workspaceEmpty: boolean;
        hasProjectMarker: boolean;
        promptHasGreenfieldVerb: boolean;
        promptHasAnaphoricRef: boolean;
    };
}

/**
 * Detect whether the user's intent is greenfield project creation.
 *
 * Decision tree:
 *
 *   - hasProjectMarker → NOT greenfield (regardless of prompt)
 *     A workspace with package.json is a real project. Even if the
 *     user says "build me a new CLI", they probably want it added
 *     to their existing project, not a separate scaffold.
 *
 *   - promptHasAnaphoricRef → NOT greenfield (regardless of workspace)
 *     "Add a feature to this codebase" overrides any empty-workspace
 *     signal. The user has explicitly told us not to scaffold.
 *
 *   - workspaceEmpty + promptHasGreenfieldVerb → HIGH confidence greenfield
 *     The clean case: user typed "build me a Node CLI" in an empty
 *     folder. Pre-select the matching template, ask for confirmation.
 *
 *   - workspaceEmpty + no greenfield verb → MEDIUM confidence greenfield
 *     User opened an empty folder and asked for something — we should
 *     still ask, but the prompt didn't explicitly say scaffold-this.
 *     UI shows the dropdown but defaults to "Skip scaffolding."
 *
 *   - otherwise → LOW confidence (effectively NOT greenfield)
 *     Workspace has files but no canonical marker. Could be a docs
 *     repo, a sub-project, or a recently-cleaned scratchpad. Don't
 *     scaffold without explicit user instruction.
 */
export function detectGreenfield(input: GreenfieldDetectionInput): GreenfieldDetectionResult {
    const filenameSet = new Set(input.topLevelFilenames);

    const hasProjectMarker = PROJECT_MARKER_FILES.some(marker => {
        if (marker.includes('*')) {
            // Wildcard markers like *.csproj — check by extension
            const ext = marker.replace('*', '');
            return Array.from(filenameSet).some(f => f.endsWith(ext));
        }
        return filenameSet.has(marker);
    });

    // "Empty enough" — fewer than 5 total files AND no project marker.
    // The 5-file threshold tolerates README + LICENSE + .gitignore +
    // CHANGELOG without considering them a real project.
    const workspaceEmpty = !hasProjectMarker && input.totalFileCount < 5;

    const promptLower = input.prompt.toLowerCase();
    const promptHasGreenfieldVerb = GREENFIELD_VERB_PATTERNS.some(p => p.test(promptLower));
    const promptHasAnaphoricRef = ANAPHORIC_PROJECT_PHRASES.some(p => p.test(promptLower));

    // Stack hint extraction — first match wins; patterns are ordered
    // by specificity in the const above.
    let stackHint: string | undefined;
    for (const { pattern, stack } of STACK_HINT_PATTERNS) {
        if (pattern.test(promptLower)) {
            stackHint = stack;
            break;
        }
    }

    const signals = {
        workspaceEmpty,
        hasProjectMarker,
        promptHasGreenfieldVerb,
        promptHasAnaphoricRef,
    };

    // Decision tree
    if (hasProjectMarker) {
        const result: GreenfieldDetectionResult = {
            isGreenfield: false,
            confidence: 'low',
            signals,
        };
        if (stackHint !== undefined) { result.stackHint = stackHint; }
        return result;
    }
    if (promptHasAnaphoricRef) {
        const result: GreenfieldDetectionResult = {
            isGreenfield: false,
            confidence: 'low',
            signals,
        };
        if (stackHint !== undefined) { result.stackHint = stackHint; }
        return result;
    }
    if (workspaceEmpty && promptHasGreenfieldVerb) {
        const result: GreenfieldDetectionResult = {
            isGreenfield: true,
            confidence: 'high',
            signals,
        };
        if (stackHint !== undefined) { result.stackHint = stackHint; }
        return result;
    }
    if (workspaceEmpty) {
        const result: GreenfieldDetectionResult = {
            isGreenfield: true,
            confidence: 'medium',
            signals,
        };
        if (stackHint !== undefined) { result.stackHint = stackHint; }
        return result;
    }
    const result: GreenfieldDetectionResult = {
        isGreenfield: false,
        confidence: 'low',
        signals,
    };
    if (stackHint !== undefined) { result.stackHint = stackHint; }
    return result;
}