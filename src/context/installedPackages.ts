// src/context/installedPackages.ts
//
// V2.3 bundle 3: package.json-aware library hints for the Coder.
//
// Without this, the Coder uses training-data assumptions about
// which packages are available and what their APIs look like. That
// caused production failures like:
//   - Importing `rrule` when it wasn't installed
//   - Referencing `Prisma.BookingWhereInput` when the installed Prisma
//     version doesn't export that type
//
// With this, the Coder gets a concrete list injected into its system
// prompt:
//   "INSTALLED PACKAGES (only import these):
//     prisma@5.10.2
//     @prisma/client@5.10.2
//     express@4.18.2
//     ..."
//
// And a directive: "If you genuinely need a package not listed,
// mention it in your one-line summary AFTER the tool call."
//
// Implementation: read package.json (declared deps). Best-effort
// read node_modules/<pkg>/package.json for installed-version truth.
// Fall back to declared version when node_modules read fails.

import * as vscode from 'vscode';
import { log } from '../logger';

export interface InstalledPackage {
    name: string;
    version: string;     // installed version if found, otherwise declared
    isDev: boolean;      // came from devDependencies
    isInstalled: boolean; // verified present in node_modules (best-effort)
}

export interface InstalledPackagesResult {
    /** Sorted list of packages — runtime deps first, then devDeps. */
    packages: InstalledPackage[];
    /** Was a package.json found? If false, the project may not be Node. */
    hasPackageJson: boolean;
    /** Other manifest files we noticed (not yet supported but useful for
     *  the prompt to mention so the Coder doesn't get confused). */
    otherManifests: string[];
}

/** Empty result for non-Node projects or unreadable workspaces. */
const EMPTY_RESULT: InstalledPackagesResult = {
    packages: [],
    hasPackageJson: false,
    otherManifests: [],
};

/**
 * Detect installed packages for the workspace. Best-effort: failures
 * return EMPTY_RESULT rather than throwing — the Coder can still
 * function without this hint, just less informed.
 */
export async function detectInstalledPackages(workspaceRoot: vscode.Uri): Promise<InstalledPackagesResult> {
    try {
        // 1. Read package.json
        const pkgJsonUri = vscode.Uri.joinPath(workspaceRoot, 'package.json');
        let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        try {
            const data = await vscode.workspace.fs.readFile(pkgJsonUri);
            pkgJson = JSON.parse(new TextDecoder().decode(data));
        } catch {
            // No package.json — check for other manifests so the
            // prompt can be honest about what kind of project this is.
            const otherManifests: string[] = [];
            for (const candidate of ['pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'requirements.txt', 'Pipfile']) {
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceRoot, candidate));
                    otherManifests.push(candidate);
                } catch {
                    // not present
                }
            }
            return { packages: [], hasPackageJson: false, otherManifests };
        }

        // 2. Build the declared list.
        const declared: { name: string; version: string; isDev: boolean }[] = [];
        for (const [name, version] of Object.entries(pkgJson.dependencies || {})) {
            declared.push({ name, version, isDev: false });
        }
        for (const [name, version] of Object.entries(pkgJson.devDependencies || {})) {
            declared.push({ name, version, isDev: true });
        }

        // 3. For each declared package, try to read the installed
        //    version from node_modules/<name>/package.json. Best
        //    effort — node_modules might not exist if user hasn't
        //    run `npm install` yet.
        const packages: InstalledPackage[] = [];
        for (const dep of declared) {
            const nodeModulesPkg = vscode.Uri.joinPath(workspaceRoot, 'node_modules', dep.name, 'package.json');
            let installedVersion: string | null = null;
            try {
                const data = await vscode.workspace.fs.readFile(nodeModulesPkg);
                const parsed = JSON.parse(new TextDecoder().decode(data));
                if (parsed && typeof parsed.version === 'string') {
                    installedVersion = parsed.version;
                }
            } catch {
                // not installed (or node_modules doesn't exist)
            }
            packages.push({
                name: dep.name,
                // Strip semver range prefix from declared if we fall back.
                // "^4.18.2" -> "4.18.2 (declared)". Keeps the prompt clean.
                version: installedVersion ?? dep.version.replace(/^[\^~>=<]+/, ''),
                isDev: dep.isDev,
                isInstalled: installedVersion !== null,
            });
        }

        // 4. Sort: runtime deps first (alphabetical), then devDeps.
        //    Coder's most likely import is a runtime dep — surface those.
        packages.sort((a, b) => {
            if (a.isDev !== b.isDev) { return a.isDev ? 1 : -1; }
            return a.name.localeCompare(b.name);
        });

        return { packages, hasPackageJson: true, otherManifests: [] };
    } catch (e) {
        log.warn('[detectInstalledPackages] failed:', String(e));
        return EMPTY_RESULT;
    }
}

/**
 * Render the installed-packages list as a prompt section. Return
 * empty string if there's nothing useful to say (no manifests found).
 *
 * Format:
 *   ════════════════════════════════════
 *   INSTALLED PACKAGES (use only these)
 *   ════════════════════════════════════
 *   Runtime:
 *     express@4.18.2
 *     @prisma/client@5.10.2
 *     ...
 *   Dev:
 *     typescript@5.4.5
 *     @types/express@4.17.21
 *     ...
 *
 *   If you need a package not listed, mention it in your one-line
 *   summary AFTER the tool call. Do NOT import it speculatively —
 *   the import will fail to resolve and the verifier will reject.
 *
 * For very large dependency lists (50+ packages), we cap at the
 * top 30 by alphabetical order to keep the prompt size bounded.
 * Power users with mega-monorepos can still see truncation note.
 */
export function renderPackagesPromptSection(result: InstalledPackagesResult): string {
    if (!result.hasPackageJson && result.otherManifests.length === 0) {
        return ''; // no manifests of any kind — be silent
    }
    if (!result.hasPackageJson) {
        // Non-Node project. Tell the Coder what manifests exist so
        // it doesn't try to invent npm/yarn package imports.
        return `═══════════════════════════════════════════════════════════════════════
PROJECT MANIFEST
═══════════════════════════════════════════════════════════════════════
This is NOT a Node.js project (no package.json found). Other manifests
detected: ${result.otherManifests.join(', ')}.
Use the language conventions appropriate to those manifests
(Python imports for pyproject.toml, Go imports for go.mod, etc.).

`;
    }

    if (result.packages.length === 0) {
        return `═══════════════════════════════════════════════════════════════════════
INSTALLED PACKAGES
═══════════════════════════════════════════════════════════════════════
This Node project's package.json declares no dependencies. Use only
the Node standard library (fs, path, http, etc.) unless you need to
add a dependency — in which case mention it in your post-tool-call
summary.

`;
    }

    const runtime = result.packages.filter((p) => !p.isDev);
    const dev = result.packages.filter((p) => p.isDev);

    const TRUNCATE_AT = 30;
    const formatList = (pkgs: InstalledPackage[]): string => {
        const truncated = pkgs.slice(0, TRUNCATE_AT);
        const lines = truncated.map((p) => {
            const installedFlag = p.isInstalled ? '' : ' (declared, not yet installed)';
            return `    ${p.name}@${p.version}${installedFlag}`;
        });
        if (pkgs.length > TRUNCATE_AT) {
            lines.push(`    ... and ${pkgs.length - TRUNCATE_AT} more (truncated to keep context bounded — use read_file on package.json if you need the full list)`);
        }
        return lines.join('\n');
    };

    const sections: string[] = [];
    sections.push('═══════════════════════════════════════════════════════════════════════');
    sections.push('INSTALLED PACKAGES (use only these — do not import anything not listed)');
    sections.push('═══════════════════════════════════════════════════════════════════════');
    if (runtime.length > 0) {
        sections.push('Runtime dependencies:');
        sections.push(formatList(runtime));
    }
    if (dev.length > 0) {
        if (runtime.length > 0) { sections.push(''); }
        sections.push('Dev dependencies (build/test tooling — usable from test files only):');
        sections.push(formatList(dev));
    }
    sections.push('');
    sections.push('Rules:');
    sections.push('1. Imports must reference packages from this list OR Node standard library.');
    sections.push('2. Type names must exist in the INSTALLED version. If you saw a type name in');
    sections.push('   training data that doesn\'t match the installed version, use read_file');
    sections.push('   on the package\'s .d.ts to find the actual exported name.');
    sections.push('3. If you genuinely need a NEW package, mention it in your one-line summary');
    sections.push('   AFTER the write_file tool call. Do NOT import it speculatively.');
    sections.push('');

    return sections.join('\n');
}