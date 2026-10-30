const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contrast = require('../media/commander-contrast');
test('highlight chooses the stronger black or white contrast on dark and light theme colors', () => {
  for (const [background, foreground] of [['#ffff00', '#000000'], ['#001133', '#ffffff'], ['rgb(250, 230, 40)', '#000000'], ['rgb(30, 45, 50)', '#ffffff'], ['#fff', '#000000']]) {
    const result = contrast.highlight(background);
    assert.equal(result.foreground, foreground);
    assert.ok(result.ratio >= 4.5);
  }
});
test('translucent or unavailable theme highlights fall back to opaque yellow with black text', () => {
  for (const value of ['', undefined, 'transparent', 'rgba(255, 0, 0, 0.2)', '#ff000055', 'var(--missing)', '#garbage']) {
    assert.deepEqual(contrast.highlight(value), { background: '#ffeb3b', foreground: '#000000', ratio: contrast.highlight('#ffeb3b').ratio });
  }
});
test('stylesheet applies both contrast variables and preserves forced color support', () => {
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.match(css, /mark\s*\{[^}]*color:\s*var\(--match-foreground/);
  assert.match(css, /mark\s*\{[^}]*background:\s*var\(--match-background/);
  assert.match(css, /forced-colors:[\s\S]*mark/);
});
