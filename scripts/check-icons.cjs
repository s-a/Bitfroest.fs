const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

function inspectIconSource(source, filename = 'source.js') {
  const violations = [];
  const report = node => violations.push(`${filename}:${node.loc.start.line}: Icon output must use the central renderer.`);
  const markup = /<(?:svg\b|(?:span|img|i)\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:codicon|icon-font|fileicon)\b)/i;
  const iconClass = /\b(?:codicon|icon-font|fileicon)(?:-[\w-]+)?\b/;
  if (/\.css$/.test(filename)) {
    source.split(/\r?\n/).forEach((line, index) => {
      if (/(?:^|[;{])\s*content\s*:\s*['"][^'"]+['"]/.test(line)) violations.push(`${filename}:${index + 1}: Icon glyph content must be generated from registered fonts.`);
    });
    return violations;
  }
  if (/\.html$/.test(filename)) {
    source.split(/\r?\n/).forEach((line, index) => { if (markup.test(line) || /data-icon-reviewed|>[×✓▾▸☆]\s*</.test(line)) violations.push(`${filename}:${index + 1}: Static icon output must use the central renderer.`); });
    return violations;
  }
  const tree = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MemberExpression' && ['CommanderWorkbenchIcons', 'CommanderStatusIcons', 'CommanderIconFontMetrics'].includes(node.property.name || node.property.value)) report(node);
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const method = node.callee.property.name;
      if (method === 'createElement' && ['svg', 'img'].includes(node.arguments[0]?.value) || method === 'createElementNS' && /svg/.test(node.arguments[0]?.value || '')) report(node);
      if (method === 'setAttribute' && node.arguments[0]?.value === 'class' && iconClass.test(node.arguments[1]?.value || '')) report(node);
    }
    if (node.type === 'NewExpression' && node.callee.name === 'Image') report(node);
    const value = node.type === 'Literal' && typeof node.value === 'string' ? node.value : node.type === 'TemplateElement' ? node.value.raw : null;
    if (value !== null) {
      const fileContent = ancestors.some(parent => parent.type === 'CallExpression' && parent.callee.name === 'entry' && parent.arguments.slice(3).some(argument => argument === node));
      const classAssignment = ancestors.some(parent => parent.type === 'AssignmentExpression' && parent.left.property?.name === 'className');
      const classCall = ancestors.some(parent => parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression' && parent.callee.object?.property?.name === 'classList' && ['add', 'toggle', 'replace'].includes(parent.callee.property.name));
      if (!fileContent && (markup.test(value) || /data-icon-reviewed|[×✓▾▸☆]/.test(value) || iconClass.test(value) && (classAssignment || classCall))) report(node);
    }
    const next = [...ancestors, node];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, next));
      else if (value && typeof value === 'object') visit(value, next);
    }
  }
  visit(tree);
  return [...new Set(violations)];
}

function checkProduct() {
  const root = path.resolve(__dirname, '..');
  const excluded = new Set(['.git', '.vscode', '.agents', '.codex', 'node_modules', 'scripts', 'tests', 'Docs', 'coverage', 'design']);
  const resources = new Set(['media/commander-icons.js', 'media/workbench-icons.js', 'media/git-status-icons.js', 'media/icon-font-metrics.js', 'media/codicons.css', 'media/icon-metrics.css']);
  function files(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
      if (!prefix && excluded.has(item.name)) return [];
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      return item.isDirectory() ? files(path.join(directory, item.name), name) : /\.(?:js|html|css)$/.test(name) && !resources.has(name) ? [name] : [];
    });
  }
  const violations = files(root).flatMap(name => inspectIconSource(fs.readFileSync(path.join(root, name), 'utf8'), name));
  if (violations.length) throw new Error(violations.join('\n'));
}

if (require.main === module) checkProduct();
module.exports = { inspectIconSource, checkProduct };
