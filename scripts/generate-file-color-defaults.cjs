const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const groups = require('../file-type-colors.json');
const defaults = {}, seen = new Set();
for (const group of groups) {
  if (!/^#[\da-f]{6}$/i.test(group.color)) throw new Error('Invalid group color: ' + group.id);
  for (const pattern of group.patterns) {
    if (seen.has(pattern.toLowerCase()) || /[/\\]/.test(pattern) || !pattern || pattern === '*') throw new Error('Invalid or duplicate pattern: ' + pattern);
    seen.add(pattern.toLowerCase()); defaults[pattern] = group.color;
  }
}
const file = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
properties['bitfroest.colors.rules'].default = defaults;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
