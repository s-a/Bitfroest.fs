const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./support/webview.cjs');

test('Help opens license acknowledgements by mouse and keyboard without changing the file lists', t => {
  for (const language of ['de', 'en']) for (const key of [null, 'Enter', ' ']) {
    const app = createApp(t, undefined, { language });
    const menu = app.document.querySelector('[data-main-menu]');
    const help = [...menu.querySelectorAll(':scope > button')].at(-1);
    app.click(help);
    const entry = menu.querySelector('[data-menu-action="licenses"]');
    assert.ok(entry, 'Help contains the active license entry');
    assert.equal(entry.hidden, false);
    assert.notEqual(entry.getAttribute('aria-disabled'), 'true');
    assert.equal(entry.textContent.trim(), language === 'de' ? 'Lizenzen und Danksagungen' : 'Licenses and acknowledgements');
    const before = JSON.stringify(app.state());
    const messages = app.messages.length;
    if (key) { entry.focus(); app.key(key, {}, entry); } else app.click(entry);
    assert.equal(menu.querySelector('[role="menu"]').hidden, true);
    assert.equal(app.document.activeElement, help);
    const sent = app.messages.slice(messages).filter(message => message.type !== 'inputFocus');
    assert.equal(sent.length, 1); assert.equal(sent[0].type, 'show-licenses'); assert.match(sent[0].requestId, /^ui-action-\d+$/);
    assert.equal(JSON.stringify(app.state()), before);
  }
});

test('application menu exposes supported reference groups without placeholders', t => {
  for (const language of ['de', 'en']) {
    const app = createApp(t, undefined, { language });
    const menu = app.document.querySelector('[data-main-menu]');
    assert.deepEqual([...menu.querySelectorAll(':scope > button')].map(button => button.textContent), language === 'de'
      ? ['Dateien', 'Markierung', 'Befehle', 'Ansicht', 'Konfigurieren', 'Hilfe']
      : ['Files', 'Mark', 'Commands', 'View', 'Configuration', 'Help']);
    assert.doesNotMatch(menu.textContent, /Mock|Platzhalter/);
    for (const trigger of menu.querySelectorAll(':scope > button')) {
      app.click(trigger);
      const popup = menu.querySelector('[role="menu"]');
      assert.equal(popup.getAttribute('aria-label'), trigger.textContent);
      const entries = [...popup.querySelectorAll('[role="menuitem"]')].filter(item => !item.hidden);
      assert.ok(entries.length);
      assert.ok(entries.every(item => item.dataset.menuAction && item.getAttribute('aria-disabled') !== 'true'));
      app.key('Escape', {}, app.document.activeElement);
      assert.equal(app.document.activeElement, trigger);
    }
  }
});

function choose(app, command, key) {
  const item = app.document.querySelector(`[data-menu-action="${command}"]`);
  assert.ok(item, command);
  app.click(app.document.querySelector(`[data-menu-group="${item.dataset.group}"]`));
  if (key) { item.focus(); app.key(key, {}, item); } else app.click(item);
}

test('menu selection actions affect the active pane by mouse and keyboard', t => {
  for (const key of [null, 'Enter', ' ']) {
    const app = createApp(t);
    const other = JSON.stringify(app.state().panes[1]);
    choose(app, 'select-all', key);
    assert.ok(app.state().panes[0].selected.length > 0);
    assert.equal(app.document.querySelector('[role="menu"]').hidden, true);
    choose(app, 'invert', key);
    assert.equal(app.state().panes[0].selected.length, 0);
    choose(app, 'select-all', key); choose(app, 'clear', key);
    assert.equal(app.state().panes[0].selected.length, 0);
    assert.equal(JSON.stringify(app.state().panes[1]), other);
  }
});

test('menu reuses tab, search, archive, rename and settings actions', t => {
  for (const [command, verify] of [
    ['new-tab', app => assert.equal(app.state().panes[0].tabs.length, 4)],
    ['search', app => assert.ok(app.document.querySelector('[data-file-search]'))],
    ['pack', app => assert.equal(app.document.querySelector('dialog').open, true)],
    ['rename', app => assert.equal(app.document.querySelector('dialog').open, true)],
    ['settings', app => assert.equal(app.messages.filter(message => message.type === 'configure-settings').length, 1)]
  ]) for (const key of [null, 'Enter', ' ']) {
    const app = createApp(t);
    if (['pack', 'rename'].includes(command)) app.click(app.row('README.md'));
    choose(app, command, key); verify(app);
  }
});

test('menu focus contains file shortcuts and shows only the active category rows', t => {
  const app = createApp(t);
  const trigger = app.document.querySelector('[data-main-menu] [aria-haspopup="true"]');
  trigger.focus();
  const open = new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  trigger.dispatchEvent(open);
  assert.equal(open.defaultPrevented, true);
  const popup = app.document.querySelector('[role="menu"]');
  assert.equal(popup.hidden, false);
  assert.equal(app.document.activeElement, popup.querySelector('[data-group="Dateien"]'));
  assert.equal(app.window.getComputedStyle(popup.querySelector('[data-group="Hilfe"]')).display, 'none');
  const initialState = JSON.stringify(app.state());
  const initialMessages = app.messages.length;
  for (const key of ['F5', 'Delete', 'Insert', 'ContextMenu']) {
    let bubbled = false;
    const observe = () => { bubbled = true; };
    app.document.addEventListener('keydown', observe, { once: true });
    const event = new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    app.document.activeElement.dispatchEvent(event);
    assert.equal(bubbled, false, `${key} stays inside the menu`);
    assert.equal(event.defaultPrevented, true, `${key} is consumed`);
  }
  assert.equal(app.document.querySelector('dialog').open, false);
  assert.equal(JSON.stringify(app.state()), initialState);
  assert.equal(app.messages.length, initialMessages);
  for (const key of ['ArrowUp', 'Enter', ' ']) {
    trigger.focus();
    const event = new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(app.document.activeElement, popup.querySelector('[data-group="Dateien"]'));
    app.key('Escape', {}, app.document.activeElement);
  }
  trigger.focus();
  app.key('ArrowDown', {}, trigger);
  let tabBubbled = false;
  app.document.addEventListener('keydown', () => { tabBubbled = true; }, { once: true });
  const tab = new app.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  app.document.activeElement.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(tabBubbled, false);
  assert.equal(popup.hidden, true);
});


test('view menu sorts the active list, swaps paths and restores the menu after Lister', t => {
  const app = createApp(t);
  const right = { ...app.state().panes[1], scrollTop: 0 };
  for (const column of ['size', 'date', 'type', 'name']) {
    choose(app, `sort:${column}`, 'Enter');
    assert.equal(app.state().panes[0].sort, column);
    assert.deepEqual(app.state().panes[1], right);
  }
  const before = app.state().panes.map(pane => pane.tabs[pane.tab]);
  choose(app, 'swap-paths');
  assert.deepEqual(app.state().panes.map(pane => pane.tabs[pane.tab]), before.toReversed());
  choose(app, 'swap-paths');
  app.click(app.row('README.md')); app.action('view'); app.key('Escape');
  choose(app, 'select-all');
  assert.ok(app.state().panes[0].selected.length);
});


test('sorting from the menu works when its column is hidden', t => {
  const app = createApp(t);
  app.document.querySelector('.pane.active [data-sort="size"]').closest('th').remove();
  choose(app, 'sort:size');
  assert.equal(app.state().panes[0].sort, 'size');
});

test('sort actions identify their criterion and report the active direction in both languages', t => {
  const labels = {
    de: ['Nach Namen sortieren', 'Nach Erweiterung sortieren', 'Nach Datum/Zeit sortieren', 'Nach Größe sortieren'],
    en: ['Sort by name', 'Sort by extension', 'Sort by date and time', 'Sort by size']
  };
  const sortNames = { de: ['Name', 'Erweiterung', 'Datum und Zeit', 'Größe'], en: ['name', 'extension', 'date and time', 'size'] };
  const direction = { de: ['aufsteigend', 'absteigend'], en: ['ascending', 'descending'] };
  const sorts = ['name', 'type', 'date', 'size'];
  for (const language of ['de', 'en']) {
    const app = createApp(t, undefined, { language });
    const right = app.state().panes[1];
    const menu = app.document.querySelector('[role="menu"]');
    const entries = sorts.map(sort => app.document.querySelector(`[data-menu-action="sort:${sort}"]`));
    assert.deepEqual(entries.map(entry => entry.textContent.trim()), labels[language]);
    for (const [index, sort] of sorts.entries()) {
      choose(app, `sort:${sort}`, index % 2 ? undefined : 'Enter');
      assert.equal(app.state().panes[0].sort, sort);
      const firstDirection = sort === 'name' ? 1 : 0;
      assert.equal(app.state().panes[0].descending, Boolean(firstDirection));
      assert.match(app.document.querySelector('#status-message').textContent, new RegExp(`${language === 'de' ? 'Sortiert nach' : 'Sorted by'}.*${sortNames[language][index]}.*${direction[language][firstDirection]}`, 'i'));
      choose(app, `sort:${sort}`, index % 2 ? 'Enter' : undefined);
      assert.equal(app.state().panes[0].descending, !firstDirection);
      assert.match(app.document.querySelector('#status-message').textContent, new RegExp(`${language === 'de' ? 'Sortiert nach' : 'Sorted by'}.*${sortNames[language][index]}.*${direction[language][1 - firstDirection]}`, 'i'));
      assert.equal(app.state().panes[1].sort, right.sort);
      assert.equal(app.state().panes[1].descending, right.descending);
      assert.deepEqual(app.state().panes[1].selected, right.selected);
      assert.equal(app.state().panes[1].tabs[app.state().panes[1].tab], right.tabs[right.tab]);
    }
    assert.equal(menu.hidden, true);
  }
});


test('menu arrows wrap between entries and supported groups, and outside clicks dismiss', t => {
  const app = createApp(t);
  const menu = app.document.querySelector('[data-main-menu]');
  const triggers = [...menu.querySelectorAll(':scope > button')];
  app.click(triggers[0]);
  const first = app.document.activeElement;
  app.key('ArrowDown');
  assert.equal(app.document.activeElement.dataset.menuAction, 'unpack');
  app.key('ArrowUp'); assert.equal(app.document.activeElement, first);
  app.key('ArrowLeft');
  assert.equal(app.document.activeElement.dataset.menuAction, 'licenses');
  app.key('ArrowRight'); assert.equal(app.document.activeElement, first);
  app.click(app.document.querySelector('.pane.active .list'));
  assert.equal(menu.querySelector('[role="menu"]').hidden, true);
  assert.ok(triggers.every(trigger => trigger.getAttribute('aria-expanded') === 'false'));
});


test('real archive menu entries retain confirmation and dispatch the existing host protocol', t => {
  for (const command of ['pack', 'unpack', 'test-archives']) {
    const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
    const state = { version: 1, realFilesystem: true, snapshotId: 'menu', active: 0,
      panes: [pane('C:/left'), pane('C:/right')],
      folders: { 'C:/left': [{ id: 'zip', name: 'sample.zip', type: 'archive', fsSource: 'C:/left/sample.zip', size: 10 }], 'C:/right': [] } };
    const app = createApp(t, state);
    app.click(app.row('sample.zip')); choose(app, command, 'Enter');
    const requests = () => app.messages.filter(message => ['zip-write', 'zip-unpack', 'zip-test'].includes(message.type));
    if (command === 'test-archives') {
      assert.equal(requests().length, 1);
      assert.equal(requests()[0].type, 'zip-test');
      assert.deepEqual(Array.from(requests()[0].ids), ['zip']);
    } else {
      assert.equal(requests().length, 0);
      assert.equal(app.document.querySelector('dialog').open, true);
      app.click(app.document.querySelector('#modal-cancel'));
      assert.equal(requests().length, 0);
    }
  }
});


test('menu shortcuts show localized compact alternatives and expose every registered platform default', t => {
  const bindings = require('../package.json').contributes.keybindings;
  const expected = {
    pack: ['Alt+F5'], unpack: ['Alt+F9', 'Alt+F6'], 'test-archives': ['Alt+Shift+F9'],
    rename: ['Control+M'], 'select-all': ['Control+A'], search: ['Alt+F7'],
    'select-group': ['NUMPAD_ADD', 'Shift+NUMPAD_ADD'], 'unselect-group': ['NUMPAD_SUBTRACT', 'Shift+NUMPAD_SUBTRACT'],
    clear: ['Control+NUMPAD_SUBTRACT', 'Control+Shift+NUMPAD_SUBTRACT'], invert: ['NUMPAD_MULTIPLY', 'Shift+NUMPAD_MULTIPLY'],
    'select-extension': ['Control+NUMPAD_ADD', 'Alt+NUMPAD_ADD'], 'restore-selection': ['NUMPAD_DIVIDE'],
    'copy-full-names': ['Control+Y'],
    'search-separate': ['Alt+Shift+F7'], back: ['Alt+ArrowLeft'],
    'swap-paths': ['Control+U'], swap: ['Control+Shift+U'], 'new-tab': ['Control+T'], refresh: ['Control+R']
  };
  for (const language of ['de', 'en']) for (const platform of ['win32', 'linux', 'darwin']) {
    const app = createApp(t, undefined, { language, platform });
    for (const item of app.document.querySelectorAll('[data-menu-action]')) {
      const command = item.dataset.menuAction;
      const shortcuts = (expected[command] || []).map(value => platform === 'darwin' ? value.replace('Control', 'Meta') : value);
      assert.equal(item.getAttribute('aria-keyshortcuts'), shortcuts.length ? shortcuts.join(' ') : null, command);
      const hint = item.querySelector('.menu-shortcuts');
      if (!shortcuts.length) { assert.equal(hint, null, command); continue; }
      assert.equal(hint.getAttribute('aria-hidden'), 'true');
      assert.equal(hint.querySelectorAll('.menu-shortcut').length, shortcuts.length > 1 ? shortcuts.length : 0, command);
      assert.equal(hint.querySelectorAll('kbd').length, shortcuts.length === 1 ? shortcuts[0].split('+').length : 0, command);
      const registered = bindings.filter(binding => binding.command === `bitfroest.${command}` && binding.when?.includes('bitfroest.listFocus'))
        .map(binding => platform === 'darwin' ? binding.mac || binding.key : binding[platform === 'linux' ? 'linux' : 'win'] || binding.key);
      const normalized = shortcuts.map(value => value.toLowerCase().replace('control', 'ctrl').replace('meta', 'cmd').replace('arrowleft', 'left'));
      assert.deepEqual(normalized, registered, command);
    }
    const rename = app.document.querySelector('[data-menu-action="rename"]');
    assert.equal([...rename.querySelectorAll('.menu-shortcuts kbd')].map(key => key.textContent).join('+'), `${platform === 'darwin' ? '⌘' : language === 'de' ? 'Strg' : 'Ctrl'}+M`);
    const search = app.document.querySelector('[data-menu-action="search-separate"]');
    assert.equal([...search.querySelectorAll('.menu-shortcuts kbd')].map(key => key.textContent).join('+'), `${platform === 'darwin' ? '⌥' : 'Alt'}+${platform === 'darwin' ? '⇧' : language === 'de' ? 'Umschalt' : 'Shift'}+F7`);
    choose(app, 'select-all', 'Enter');
    assert.ok(app.state().panes[0].selected.length);
  }
});


test('shortcut hints align separately from labels and remain part of the menu action', t => {
  const app = createApp(t);
  const fs = require('node:fs'), path = require('node:path');
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  const entry = app.document.querySelector('[data-menu-action="select-all"]');
  app.click(app.document.querySelector('[data-menu-group="Markierung"]'));
  const hint = entry.querySelector('.menu-shortcuts');
  const hintStyle = app.window.getComputedStyle(hint);
  assert.equal(hintStyle.display, 'inline-flex');
  assert.equal(hintStyle.marginLeft, 'auto');
  assert.equal(hintStyle.flexShrink, '0');
  assert.equal(hintStyle.whiteSpace, 'nowrap');
  app.click(hint);
  assert.ok(app.state().panes[0].selected.length);
  assert.equal(app.document.querySelector('[role="menu"]').hidden, true);
});

test('menu bar typography matches the compact statusbar without clipping larger inherited text', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  const vendor = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/workbench-vendor.css'), 'utf8');
  const menu = css.match(/\.main-menu\s*\{([^}]*)\}/)?.[1] || '';
  const menuButtons = css.match(/\.main-menu\s*>\s*button\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(vendor, /body \.statusbar\s*\{[^}]*height:\s*22px;[^}]*font-size:\s*12px/);
  assert.match(menu, /font-size:\s*12px/);
  assert.match(menu, /min-height:\s*22px/);
  assert.match(menu, /flex:\s*0 0 auto/);
  assert.match(menu, /padding:\s*0 5px/);
  assert.match(menuButtons, /min-height:\s*22px/);
  assert.match(menuButtons, /padding:\s*0 9px/);
  assert.match(menuButtons, /line-height:\s*normal/);
});

test('menu shortcuts show multiple compact textual hints and retain every accessible binding', t => {
  const bindings = require('../package.json').contributes.keybindings;
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: 'one', filter: '', sort: 'name' });
  const state = { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'one', name: 'one.txt', type: 'text' }, { id: 'two', name: 'two.txt', type: 'text' }], '/right': [] } };
  const app = createApp(t, state);
  const style = app.document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require('node:path').join(__dirname, '../media/app.css'), 'utf8');
  app.document.head.append(style);
  const item = app.document.querySelector('[data-menu-action="select-all"]');
  assert.deepEqual([...item.querySelectorAll('.menu-shortcuts kbd')].map(key => key.textContent), ['Strg', 'A']);
  assert.equal([...item.querySelectorAll('.menu-shortcuts kbd')].map(key => key.textContent).join('+'), 'Strg+A');
  assert.equal(item.getAttribute('aria-keyshortcuts'), 'Control+A');
  const extension = app.document.querySelector('[data-menu-action="select-extension"]');
  assert.equal(extension.querySelector('.menu-shortcuts').textContent.trim(), 'Strg+Num + / Alt+Num +');
  assert.equal(extension.querySelectorAll('.menu-shortcut').length, 2);
  assert.equal(extension.querySelectorAll('kbd').length, 0);
  assert.ok([...extension.querySelectorAll('.menu-shortcut')].every(shortcut => shortcut.tagName === 'SPAN' && !shortcut.hasAttribute('tabindex')));
  assert.match(extension.title, /Strg\+Num \+.*Alt\+Num \+/);
  assert.equal(extension.getAttribute('aria-keyshortcuts'), 'Control+NUMPAD_ADD Alt+NUMPAD_ADD');
  app.click(app.document.querySelector('[data-menu-group="Markierung"]'));
  extension.querySelectorAll('.menu-shortcut')[1].click();
  assert.deepEqual(app.state().panes[0].selected, ['one', 'two'], 'clicking an alternate hint invokes the command through its menu item');
  assert.equal(app.document.querySelector('[role="menu"]').hidden, true);
  app.click(app.document.querySelector('[data-menu-group="Markierung"]'));
  item.querySelectorAll('kbd')[0].click();
  assert.ok(app.state().panes[0].selected.length, 'clicking a single-combination keycap invokes its command');
  const hintStyle = app.window.getComputedStyle(item.querySelector('.menu-shortcuts'));
  assert.equal(hintStyle.marginLeft, 'auto');
  assert.equal(hintStyle.fontSize, '12px');
  assert.equal(hintStyle.color, 'var(--vscode-descriptionForeground, var(--muted))');
  const mac = createApp(t, undefined, { platform: 'darwin' });
  assert.equal([...mac.document.querySelectorAll('[data-menu-action="rename"] .menu-shortcuts kbd')].map(key => key.textContent).join('+'), '⌘+M');
  assert.deepEqual([...mac.document.querySelectorAll('[data-menu-action="select-all"] kbd')].map(key => key.textContent), ['⌘', 'A']);
  assert.equal(mac.document.querySelector('[data-menu-action="select-extension"] .menu-shortcuts').textContent.trim(), '⌘+Num + / ⌥+Num +');
  assert.ok(bindings.some(binding => binding.command === 'bitfroest.select-all'));
});

test('selection menu separators are semantic, category scoped, inert, and skipped by arrows', t => {
  const app = createApp(t);
  const popup = app.document.querySelector('[role="menu"]');
  const separators = [...popup.querySelectorAll('[data-group="Markierung"][role="separator"]')];
  assert.equal(separators.length, 2);
  assert.deepEqual(separators.map(separator => separator.previousElementSibling.dataset.menuAction), ['select-extension', 'load-selection-file']);
  assert.deepEqual(separators.map(separator => separator.nextElementSibling.dataset.menuAction), ['save-selection', 'copy-names']);
  assert.ok(separators.every(separator => separator.dataset.group === 'Markierung' && separator.tabIndex === -1));
  app.click(app.document.querySelector('[data-menu-group="Markierung"]'));
  assert.ok(separators.every(separator => !separator.hidden));
  app.key('ArrowDown');
  app.key('ArrowDown'); app.key('ArrowDown'); app.key('ArrowDown'); app.key('ArrowDown');
  assert.equal(app.document.activeElement.dataset.menuAction, 'select-extension');
  app.key('ArrowDown');
  assert.equal(app.document.activeElement.dataset.menuAction, 'save-selection');
  app.click(separators[0]);
  assert.equal(popup.hidden, false);
  app.click(app.document.querySelector('[data-menu-group="Dateien"]'));
  assert.ok(separators.every(separator => separator.hidden));
});
