const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const declared = new Set(pkg.contributes?.commands?.map(c => c.command) ?? []);
const referenced = new Set();

// Walk src/ for registerCommand calls
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
            const text = fs.readFileSync(full, 'utf8');
            for (const m of text.matchAll(/registerCommand\s*\(\s*['"]([^'"]+)['"]/g)) {
                // Skip dynamic command IDs (template-literal placeholders that leaked into the regex)
                if (m[1].includes('<') || m[1].includes('${')) continue;
                referenced.add(m[1]);
            }
        }
    }
}
walk(path.join(__dirname, '..', 'src'));

const missing = [...referenced].filter(c => !declared.has(c));
const unused = [...declared].filter(c => !referenced.has(c));

if (missing.length) {
    console.error('❌ Commands registered in code but missing from package.json:');
    missing.forEach(c => console.error('  ' + c));
}
if (unused.length) {
    console.warn('⚠️  Commands declared in package.json but never registered in code:');
    unused.forEach(c => console.warn('  ' + c));
}
process.exit(missing.length ? 1 : 0);