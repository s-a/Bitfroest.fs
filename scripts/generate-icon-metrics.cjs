const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readGlyph } = require('./true-type-metrics.cjs');
const { fitIcon } = require('./icon-metrics.cjs');

function generateFontSet(entries) {
  if (!entries.length) throw new Error('No icon fonts registered.');
  const metrics = {}, faces = [], rules = [], identifiers = new Set(), hash = createHash('sha256');
  const number = value => Number(value.toFixed(10));
  const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  for (const { id, file, source = '', glyphs = {}, font } of entries) {
    if (!identifier.test(id) || identifiers.has(id) || !/^[a-zA-Z\d_/-]+\.ttf$/.test(file)) throw new Error('Invalid or duplicate icon font registration.');
    identifiers.add(id); hash.update(font);
    const mappings = Object.entries(glyphs);
    for (const [, name, hex] of source.matchAll(/\.codicon-([a-z0-9-]+)::before\s*\{\s*content:\s*['"]\\([a-f\d]+)['"];\s*\}/g)) mappings.push([name, parseInt(hex, 16)]);
    if (!mappings.length) throw new Error(`No icon glyph mappings found: ${id}.`);
    const prefix = id === 'codicon' ? 'codicon' : `icon-font-${id}`;
    faces.push(`@font-face{font-family:commander-${id}-metrics;src:url('./${file}') format('truetype');font-weight:normal;font-style:normal;font-display:block;ascent-override:100%;descent-override:0%;line-gap-override:0%}`);
    faces.push(`.${prefix}::before{font-family:commander-${id}-metrics}`);
    for (const [name, codePoint] of mappings) {
      if (!identifier.test(name) || !Number.isInteger(codePoint)) throw new Error('Invalid icon glyph registration.');
      const key = id === 'codicon' ? name : `${id}:${name}`;
      if (Object.hasOwn(metrics, key)) {
        if (metrics[key].codePoint !== codePoint) throw new Error(`Conflicting icon glyph: ${key}.`);
        continue;
      }
      const glyph = readGlyph(font, codePoint), fit = fitIcon(glyph.bounds, glyph.unitsPerEm);
      const glyphClass = id === 'codicon' ? `codicon-${name}` : `${prefix}--${name}`;
      const classes = id === 'codicon' ? ['codicon', glyphClass] : ['icon-font', prefix, glyphClass];
      metrics[key] = { codePoint, fontId: id, classes, ...fit };
      rules.push(`.${glyphClass}::before{font-size:calc(var(--icon-size, 16px) * ${number(fit.fontScale)});left:calc(var(--icon-size, 16px) * ${number(fit.left)});top:calc(var(--icon-size, 16px) * ${number(fit.top)});content:'\\${codePoint.toString(16)}'}`);
    }
  }
  const signature = hash.update(JSON.stringify(metrics)).digest('hex');
  const css = [
    `/* Generated icon metrics. Source SHA-256: ${signature}. */`,
    '.codicon,.icon-font{position:relative;vertical-align:middle}',
    '.icon-font{display:inline-block;width:var(--icon-size, 16px);height:var(--icon-size, 16px);flex:0 0 var(--icon-size, 16px);font-size:16px;line-height:1}',
    '.codicon-modifier-spin{transform-origin:50% 50%;animation:codicon-spin 1s cubic-bezier(0.53, 0.21, 0.29, 0.67) infinite}',
    '@media(prefers-reduced-motion:reduce){.codicon-modifier-spin{animation:none!important}}',
    '.codicon:not([data-icon-reviewed]),.icon-font:not([data-icon-reviewed]),.fileicon:not([data-icon-reviewed]),svg:not([data-icon-reviewed]){visibility:hidden}',
    'svg[data-icon-reviewed]{width:var(--icon-size, 16px);height:var(--icon-size, 16px);flex-shrink:0;vertical-align:middle}',
    '.codicon::before,.icon-font::before{position:absolute;display:block;height:1em;font-style:normal;font-weight:normal;font-synthesis:none;line-height:1;text-align:left;white-space:pre}',
    ...faces, ...rules
  ].join('\n') + '\n';
  return { css, catalog: `/* Generated icon metrics. Source SHA-256: ${signature}. */\nwindow.CommanderIconFontMetrics = Object.freeze(${JSON.stringify(metrics, null, 2)});\n` };
}

function generate(source, font) { return generateFontSet([{ id: 'codicon', file: 'codicon.ttf', source, font }]); }
function generateIconCss(source, font) { return generate(source, font).css; }

function main(check) {
  const root = path.resolve(__dirname, '..');
  const registrations = JSON.parse(fs.readFileSync(path.join(__dirname, 'icon-fonts.json'), 'utf8'));
  const output = generateFontSet(registrations.map(entry => {
    for (const file of [entry.file, entry.source].filter(Boolean)) if (!/^[a-zA-Z\d_/-]+\.(?:ttf|css)$/.test(file)) throw new Error('Invalid icon font asset path.');
    return { ...entry, source: entry.source ? fs.readFileSync(path.join(root, 'media', entry.source), 'utf8') : '', font: fs.readFileSync(path.join(root, 'media', entry.file)) };
  }));
  for (const [file, contents] of [['icon-metrics.css', output.css], ['icon-font-metrics.js', output.catalog]]) {
    const target = path.join(root, 'media', file);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== contents) throw new Error(`Stale icon metrics: ${file}. Run npm run generate:icons.`);
    } else fs.writeFileSync(target, contents);
  }
}

if (require.main === module) main(process.argv.includes('--check'));
module.exports = { generateIconCss, generate, generateFontSet };
