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

test('progress text retains readable contrast over both filled and unfilled theme backgrounds', () => {
  const luminance = hex => {
    const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  for (const [foreground, background, accent] of [
    ['#cccccc', '#252526', '#007fd4'], ['#333333', '#ffffff', '#007acc'],
    ['#ffffff', '#007acc', '#ffcc00'], ['#000000', '#ffffff', '#0000ff'],
    ['#ffffff', '#000000', '#ffff00'], ['#aaaaaa', '#aaaaaa', '#ff0000']
  ]) {
    const result = contrast.progressColors(foreground, background, accent);
    assert.ok(ratio(result.foreground, background) >= 4.5, `unfilled ${background}`);
    assert.ok(ratio(result.foreground, result.fill) >= 4.5, `filled ${result.fill}`);
    if (ratio(foreground, background) >= 4.5) assert.equal(result.foreground, foreground);
  }
  assert.equal(contrast.progressColors('var(--missing)', 'transparent', ''), null);
});
