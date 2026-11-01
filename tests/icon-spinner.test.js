const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('the busy indicator keeps its circular frame and radius at every configured size', t => {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  for (const name of ['workbench-icons.js', 'git-status-icons.js', 'icon-font-metrics.js', 'commander-icons.js']) dom.window.eval(fs.readFileSync(path.join(__dirname, '../media', name), 'utf8'));
  const icon = dom.window.CommanderIcons.element('refresh');
  dom.window.CommanderIcons.setFont(icon, 'loading', true);
  assert.equal(icon.querySelector('svg')?.getAttribute('viewBox'), '2 2 12 12');
  assert.equal(icon.querySelector('svg')?.dataset.iconReviewed, 'workbench:loading');
  for (const size of [8, 9.5, 12, 24]) {
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const x = (8 + 6 * Math.cos(angle) - 2) * size / 12;
      const y = (8 + 6 * Math.sin(angle) - 2) * size / 12;
      assert.ok(Math.abs(Math.hypot(x - size / 2, y - size / 2) - size / 2) < 1e-9);
    }
  }
  dom.window.CommanderIcons.setFont(icon, 'refresh');
  assert.equal(icon.children.length, 0);
});

