const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');
const send = (app, data) => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
function fixture(left = '/repo', right = '/plain') {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, realFilesystem: true, snapshotId: 'location-menu', active: 0, panes: [pane(left), pane(right)], folders: { [left]: [], [right]: [], '/': [] } };
}
function git(app) {
  const request = app.messages.find(message => message.type === 'git-status');
  send(app, { ...request, type: 'git-status-result', directories: { '/repo': { ok: true, repository: true, branch: 'main', statuses: {} }, '/plain': { ok: true, repository: false } } });
}

test('plain folders have one filled star with direct favorites and no additional path glyph', t => {
  const app = createApp(t, fixture());
  const button = app.document.querySelector('[data-favorites]');
  assert.ok(button.querySelector('.codicon-star-full'));
  assert.equal(app.document.querySelector('.path [data-location-icon]'), null);
  assert.equal(button.querySelector('[data-location-badge]'), null);
  app.click(button);
  assert.ok(app.document.querySelector('[data-favorite-toggle]'));
  assert.equal(app.document.querySelector('[data-location-section]'), null);
});

test('Git context combines the icon and badge and binds branch selection to the originating panel', t => {
  const app = createApp(t, fixture('/plain', '/repo')); git(app);
  const button = app.document.querySelector('[data-pane="1"] [data-favorites]');
  assert.ok(button.querySelector('svg.bi-git'));
  assert.ok(button.querySelector('[data-location-badge] .codicon-star-full'));
  app.click(button);
  const menu = app.document.querySelector('[data-favorite-menu]');
  assert.deepEqual([...menu.children].filter(node => node.matches('button')).map(node => node.textContent), ['Favoriten', 'Git']);
  app.click(menu.querySelector('[data-location-section="git"]'));
  app.click(app.document.querySelector('[data-location-action="git-branches"]'));
  assert.equal(app.messages.filter(message => message.type === 'git-branches').at(-1).path, '/repo');
  assert.equal(app.document.querySelector('[data-favorite-menu]'), null);
});

test('open menus keep their original structure and focus during asynchronous Git discovery', t => {
  const app = createApp(t, fixture()), button = app.document.querySelector('[data-favorites]');
  app.click(button);
  const menu = app.document.querySelector('[data-favorite-menu]'), focused = app.document.activeElement, html = menu.innerHTML;
  git(app);
  assert.equal(menu.innerHTML, html); assert.equal(app.document.activeElement, focused);
  assert.ok(button.querySelector('.codicon-star-full'));
  assert.equal(button.querySelector('svg.bi-git'), null);
  app.key('Escape');
  assert.equal(app.document.activeElement, button);
  assert.ok(button.querySelector('svg.bi-git'));
  app.click(button);
  assert.ok(app.document.querySelector('[data-location-section="git"]'));
});

test('ZIP context offers archive navigation instead of actions for its containing repository', t => {
  const root = 'zip:%2Frepo%2Fa.zip!', nested = root + '/docs', state = fixture(nested);
  state.archiveLocations = { [root]: { archive: '/repo/a.zip', parent: '/repo' }, [nested]: { archive: '/repo/a.zip', parent: root } };
  state.folders[root] = []; state.folders['/repo'] = [];
  const app = createApp(t, state);
  app.click(app.document.querySelector('[data-favorites]'));
  assert.equal(app.document.querySelector('[data-location-section="git"]'), null);
  app.click(app.document.querySelector('[data-location-section="zip"]'));
  app.click(app.document.querySelector('[data-location-action="archive-root"]'));
  assert.equal(app.state().panes[0].tabs[0], root);
  app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-location-section="zip"]'));
  app.click(app.document.querySelector('[data-location-action="archive-exit"]'));
  assert.equal(app.messages.filter(message => message.type === 'filesystem-navigate').at(-1).path, '/repo');
});

test('context colors distinguish the symbols and remain readable after theme changes', async t => {
  const app = createApp(t, fixture()); git(app);
  const root = app.document.documentElement.style;
  const ratio = require('../media/commander-file-colors').ratio;
  for (const background of ['#ffffff', '#202020']) {
    root.setProperty('--vscode-sideBar-background', background);
    root.setProperty('--vscode-editor-background', background);
    root.setProperty('--vscode-list-inactiveSelectionBackground', background);
    root.setProperty('--vscode-toolbar-hoverBackground', background);
    root.setProperty('--vscode-toolbar-activeBackground', background);
    await new Promise(resolve => setImmediate(resolve));
    const button = app.document.querySelector('[data-favorites]');
    const gitColor = button.style.getPropertyValue('--location-color'), star = button.style.getPropertyValue('--location-star-color');
    assert.notEqual(gitColor, star);
    assert.ok(ratio(gitColor, background) >= 4.5);
    assert.ok(ratio(star, button.style.getPropertyValue('--location-badge-background')) >= 4.5);
  }
});

test('archive entry names containing exclamation marks do not change the archive root', t => {
  const root = 'zip:%2Frepo%2Fa.zip!', nested = root + '/docs!old/sub', state = fixture(nested);
  state.archiveLocations = { [root]: { archive: '/repo/a.zip', parent: '/repo' }, [nested]: { archive: '/repo/a.zip', parent: root + '/docs!old' } };
  state.folders[root] = [];
  const app = createApp(t, state);
  app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-location-section="zip"]'));
  app.click(app.document.querySelector('[data-location-action="archive-root"]'));
  assert.equal(app.state().panes[0].tabs[0], root);
});

test('ordinary folders containing exclamation marks retain favorites and receive Git detection', t => {
  const path = 'C:/work/release!old', app = createApp(t, fixture(path));
  assert.ok(app.messages.find(message => message.type === 'git-status').directories.includes(path));
  const button = app.document.querySelector('[data-favorites]'); app.click(button);
  assert.equal(app.document.querySelector('[data-location-section="zip"]'), null);
  assert.ok(app.document.querySelector('[data-favorite-toggle]'));
  assert.ok(button.querySelector('.codicon-star-full'));
});

test('Git favorites stay first and Escape returns through the submenu to the original button', t => {
  const app = createApp(t, fixture()); git(app);
  const button = app.document.querySelector('[data-favorites]'); app.click(button);
  const favorites = app.document.querySelector('[data-location-section="favorites"]');
  assert.equal(app.document.activeElement, favorites);
  app.key('ArrowRight');
  assert.ok(app.document.activeElement.matches('[data-favorite-toggle]'));
  app.key('Escape'); assert.equal(app.document.activeElement, favorites);
  app.key('Escape'); assert.equal(app.document.activeElement, button);
  assert.equal(button.getAttribute('aria-label'), 'Ortsmenü: Favoriten und Aktionen');
  assert.equal(button.getAttribute('aria-description'), 'Git');
});

for (const activation of ['click', 'keyboard']) test(`favorites navigate during a running background pack job through ${activation}`, t => {
  const state = fixture();
  state.folders['/repo'] = [{ id: '/reposta.txt', name: 'a.txt', type: 'text', fsSource: '/repo/a.txt', size: 5 }];
  const app = createApp(t, state);
  send(app, { type: 'favorite-settings', settings: { entries: { elsewhere: '/elsewhere' }, order: ['elsewhere'] } });
  app.action('select-all'); app.action('pack');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = app.messages.find(message => message.type === 'zip-write');
  const progress = completedBytes => send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { phase: 'packing', currentPath: 'a.txt', completedBytes, totalBytes: 100 } });
  progress(25);
  const button = app.document.querySelector('[data-pane="0"] [data-favorites]');
  if (activation === 'click') app.click(button);
  else { const list = app.document.querySelector('[data-pane="0"] .list'); list.focus(); app.key('d', { ctrlKey: true }, list); }
  assert.ok(app.document.querySelector('[data-favorite-menu]'), 'the menu opens while the pack job is running');
  progress(50);
  assert.ok(app.document.querySelector('[data-favorite-menu]'), 'a progress update leaves the menu open');
  const favorite = app.document.querySelector('[data-favorite-entry]');
  if (activation === 'click') app.click(favorite);
  else { favorite.focus(); app.key('Enter', {}, favorite); }
  assert.equal(app.messages.filter(message => message.type === 'filesystem-navigate').at(-1)?.path, '/elsewhere');
  assert.equal(app.messages.filter(message => message.type === 'zip-write').length, 1, 'navigating must not start another file operation');
});

test('favorites remain locked during a foreground rename operation', t => {
  const state = fixture(); state.folders['/repo'] = [{ id: '/reposta.txt', name: 'a.txt', type: 'text', fsSource: '/repo/a.txt', size: 5 }];
  const app = createApp(t, state);
  app.action('select-all'); app.action('rename');
  app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  const button = app.document.querySelector('[data-favorites]'); app.click(button);
  assert.equal(app.document.querySelector('[data-favorite-menu]'), null);
});

test('Escape closes favorites during a background pack without cancelling the job', t => {
  const state = fixture(); state.folders['/repo'] = [{ id: 'a', name: 'a.txt', type: 'text', fsSource: '/repo/a.txt', size: 5 }];
  const app = createApp(t, state); send(app, { type: 'favorite-settings', settings: { entries: { elsewhere: '/elsewhere' }, order: ['elsewhere'] } });
  app.action('select-all'); app.action('pack'); app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = app.messages.find(message => message.type === 'zip-write');
  send(app, { type: 'filesystem-progress', operationId: request.operationId, progress: { phase: 'packing', completedBytes: 10, totalBytes: 100 } });
  const button = app.document.querySelector('[data-favorites]'); app.click(button);
  app.key('Escape');
  assert.equal(app.document.querySelector('[data-favorite-menu]'), null);
  assert.equal(app.document.activeElement, button);
  assert.equal(app.messages.some(message => message.type === 'filesystem-cancel'), false);
  assert.equal(app.document.querySelector('#jobs-toggle .jobs-count').textContent, '1');
});

test('a captured menu action cannot run after a tab change even when its path is unchanged', t => {
  const app = createApp(t, fixture()); git(app);
  app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-location-section="git"]'));
  const action = app.document.querySelector('[data-location-action="git-branches"]');
  app.action('new-tab'); app.click(action);
  assert.equal(app.messages.some(message => message.type === 'git-branches'), false);
});

test('Git refresh requests only the originating repository and keeps the current context visible', t => {
  const app = createApp(t, fixture()); git(app);
  const previous = app.messages.filter(message => message.type === 'git-status').length;
  app.click(app.document.querySelector('[data-favorites]'));
  app.click(app.document.querySelector('[data-location-section="git"]'));
  app.click(app.document.querySelector('[data-location-action="git-refresh"]'));
  const requests = app.messages.filter(message => message.type === 'git-status');
  assert.equal(requests.length, previous + 1);
  assert.deepEqual(Array.from(requests.at(-1).directories), ['/repo']);
  assert.ok(app.document.querySelector('[data-favorites] svg.bi-git'));
});

test('all interaction surfaces keep distinct context colors and a readable badge', async t => {
  const zip = 'zip:%2Frepo%2Fa.zip!', state = fixture('/repo', zip);
  state.archiveLocations = { [zip]: { archive: '/repo/a.zip', parent: '/repo' } };
  const app = createApp(t, state); git(app);
  const ratio = require('../media/commander-file-colors').ratio, root = app.document.documentElement.style;
  for (const [background, hover, active] of [['#ffffff', '#dddddd', '#111111'], ['#202020', '#555555', '#eeeeee']]) {
    root.setProperty('--vscode-sideBar-background', background);
    root.setProperty('--vscode-list-inactiveSelectionBackground', 'rgba(0, 0, 0, 0.05)');
    root.setProperty('--vscode-toolbar-hoverBackground', hover); root.setProperty('--vscode-toolbar-activeBackground', active);
    await new Promise(resolve => setImmediate(resolve));
    const values = [...app.document.querySelectorAll('[data-favorites]')].map(button => button.style);
    for (const style of values) {
      assert.ok(ratio(style.getPropertyValue('--location-color'), style.getPropertyValue('--location-badge-background')) >= 4.5);
      for (const state of ['hover', 'active']) assert.ok(ratio(style.getPropertyValue(`--location-${state}-color`), style.getPropertyValue(`--location-${state}-background`)) >= 4.5);
      assert.ok(ratio(style.getPropertyValue('--location-star-color'), style.getPropertyValue('--location-badge-background')) >= 4.5);
    }
    assert.equal(new Set([values[0].getPropertyValue('--location-color'), values[1].getPropertyValue('--location-color'), values[0].getPropertyValue('--location-star-color')]).size, 3);
  }
});

test('the recessed composition stays within its button and uses system colors in forced contrast', t => {
  const app = createApp(t, fixture()); git(app);
  const style = app.document.createElement('style'); style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8'); app.document.head.append(style);
  const icon = app.document.querySelector('[data-favorites] [data-location-icon]'), badge = icon.querySelector('[data-location-badge]');
  const base = app.window.getComputedStyle(icon), overlay = app.window.getComputedStyle(badge);
  assert.equal(base.width, 'var(--icon-size)'); assert.equal(base.height, 'var(--icon-size)');
  assert.equal(overlay.width, 'var(--icon-size)'); assert.equal(overlay.height, 'var(--icon-size)');
  assert.equal(overlay.left, '-2px'); assert.equal(overlay.bottom, '-2px');
  const rules = [...style.sheet.cssRules];
  assert.ok(rules.some(rule => rule.selectorText?.includes('.main-menu, .menu-surface, .pathbar') && rule.style.getPropertyValue('--icon-size') === 'var(--icon-base-size)'));
  const grid = app.window.CommanderIcons.layout();
  assert.ok((grid.control - grid.size) / 2 + parseFloat(overlay.left) - 1 >= 0);
  assert.ok((grid.control - grid.size) / 2 + parseFloat(overlay.bottom) - 1 >= 0);
  assert.equal(icon.querySelectorAll('.codicon-star-full').length, 1);
  const forced = [...style.sheet.cssRules].find(rule => rule.conditionText === '(forced-colors: active)');
  assert.ok([...forced.cssRules].some(rule => rule.selectorText === '.location-favorite-badge' && rule.style.color.toLowerCase() === 'canvastext'));
});

test('English menus translate the common entry and archive navigation labels', t => {
  const root = 'zip:%2Frepo%2Fa.zip!', state = fixture(root); state.archiveLocations = { [root]: { archive: '/repo/a.zip', parent: '/repo' } };
  const app = createApp(t, state, { language: 'en' });
  app.click(app.document.querySelector('[data-favorites]'));
  assert.equal(app.document.querySelector('[data-location-section="favorites"] .menu-label').textContent, 'Favorites');
  app.click(app.document.querySelector('[data-location-section="zip"]'));
  assert.match(app.document.querySelector('[data-location-action="archive-exit"]').textContent, /Leave archive/);
});
