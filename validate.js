// validate.js
const p = require('./package.json');
const cmds = new Set(p.contributes.commands.map(c => c.command));
const refs = [];
for (const [where, items] of Object.entries(p.contributes.menus || {})) {
    for (const item of items) {
        if (item.command && !cmds.has(item.command)) {
            refs.push(`${where}: ${item.command}`);
        }
    }
}
console.log(refs.length ? 'UNDEFINED command refs: ' + refs.join(', ') : 'OK — all menu refs resolve to defined commands');