const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('one base size determines icon frames, badges, gaps and required control space', () => {
  const layout = require('../media/icon-layout');
  assert.deepEqual(layout.resolve(), { size: 16, gap: 4, badge: 8, control: 24, row: 22 });
  assert.deepEqual(layout.resolve(28), { size: 28, gap: 7, badge: 14, control: 42, row: 35 });
  for (const value of [null, '28', 0, 99, 16.5]) assert.equal(layout.resolve(value).size, 16);
});

test('icons share a fixed frame across text fonts and update from live settings', t => {
  const app = createApp(t);
  assert.equal(app.document.body.style.getPropertyValue('--icon-base-size'), '16px');
  assert.equal(app.window.CommanderIcons.observeText, undefined);
  assert.equal(app.window.CommanderIcons.referenceText, undefined);
  const refresh = app.document.querySelector('[data-refresh-icon]');
  app.window.CommanderIcons.setFont(refresh, 'loading', true);
  const frame = refresh.querySelector('svg').getAttribute('viewBox');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'file-settings', settings: { iconSize: 28 } } }));
  assert.equal(app.document.body.style.getPropertyValue('--icon-base-size'), '28px');
  assert.equal(app.document.body.style.getPropertyValue('--icon-text-gap'), '7px');
  assert.equal(app.document.body.style.getPropertyValue('--icon-badge-size'), '14px');
  assert.equal(refresh.querySelector('svg').getAttribute('viewBox'), frame);
  assert.equal(frame, '2 2 12 12');
  app.document.body.style.fontSize = '32px';
  assert.equal(app.window.CommanderIcons.layout().size, 28);
  const fs = require('node:fs'), path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  assert.doesNotMatch(css, /\b1cap\b|icon-baseline-offset/);
  assert.match(css, /#status-message \[data-status-icon\] svg \{ width: var\(--icon-size\); height: var\(--icon-size\); \}/);
  assert.match(css, /body \.statusbar \{ height: var\(--icon-row-size\); min-height: var\(--icon-row-size\); \}/);
});

test('native settings expose one localized scalar icon size with the shared default', () => {
  const manifest = require('../package.json');
  const setting = manifest.contributes.configuration.flatMap(group => Object.entries(group.properties)).find(([key]) => key === 'bitfroest.appearance.iconSize')?.[1];
  assert.ok(setting);
  assert.equal(setting.type, 'integer'); assert.equal(setting.default, require('../media/icon-layout').defaults.size);
  assert.equal(setting.scope, 'window');
  const key = setting.description.slice(1, -1);
  for (const locale of ['../package.nls.json', '../package.nls.de.json']) assert.ok(require(locale)[key]);
});
