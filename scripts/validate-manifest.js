// scripts/validate-manifest.js
//
// Validates that the package.json manifest is internally consistent
// and matches the source code. Wired into `npm run compile` via the
// `validate` script so a typo in a command ID fails the build before
// it can ship to users.
//
// Three independent checks:
//
//   1. registerCommand vs. declared
//        Every `registerCommand("x", ...)` call site in src/ must
//        correspond to a `contributes.commands[].command` entry. A
//        miss means the command can be invoked from code but won't
//        appear in the Command Palette and won't be discoverable.
//
//   2. declared vs. registerCommand
//        Every declared command should have at least one registration.
//        A miss means a stale entry in the manifest — the user can
//        invoke it from the palette but nothing happens. Warning,
//        not error, because some commands are registered conditionally
//        (e.g. only when a workspace folder is open).
//
//   3. menu refs vs. declared
//        Every `contributes.menus[*][].command` reference must point
//        to a declared command. A miss is the most user-visible bug
//        of the three — the menu item appears greyed out or invokes
//        nothing. Migrated here from the legacy root-level validate.js,
//        which can now be deleted (L-4 audit fix).
//
// Exit codes:
//   0 — all checks passed (warnings allowed)
//   1 — at least one error: missing command from manifest, or menu ref
//       to an undeclared command

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const declared = new Set(pkg.contributes?.commands?.map(c => c.command) ?? []);
const referenced = new Set();

// Walk src/ for registerCommand calls.
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
            const text = fs.readFileSync(full, 'utf8');
            for (const m of text.matchAll(/registerCommand\s*\(\s*['"]([^'"]+)['"]/g)) {
                // Skip dynamic command IDs (template-literal placeholders
                // that leaked into the regex).
                if (m[1].includes('<') || m[1].includes('${')) continue;
                referenced.add(m[1]);
            }
        }
    }
}
walk(path.join(__dirname, '..', 'src'));

const missing = [...referenced].filter(c => !declared.has(c));
const unused = [...declared].filter(c => !referenced.has(c));

// Check 3: menus → declared.
const menuRefs = [];
for (const [where, items] of Object.entries(pkg.contributes?.menus || {})) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
        if (item.command && !declared.has(item.command)) {
            menuRefs.push(`${where}: ${item.command}`);
        }
    }
}

let hasError = false;

if (missing.length) {
    console.error('❌ Commands registered in code but missing from package.json:');
    missing.forEach(c => console.error('  ' + c));
    hasError = true;
}

if (menuRefs.length) {
    console.error('❌ Menu items reference undeclared commands:');
    menuRefs.forEach(r => console.error('  ' + r));
    hasError = true;
}

if (unused.length) {
    console.warn('⚠️  Commands declared in package.json but never registered in code:');
    unused.forEach(c => console.warn('  ' + c));
}

if (!hasError) {
    console.log('✅ Manifest validated: ' +
        `${declared.size} declared, ${referenced.size} registered, ` +
        `${Object.values(pkg.contributes?.menus || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)} menu refs.`);
}

process.exit(hasError ? 1 : 0);