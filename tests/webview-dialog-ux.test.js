const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, resolveThemeCss } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const dialogCss = ['app.css', 'dialog-heading.css'].map(name => fs.readFileSync(path.join(__dirname, '../media', name), 'utf8')).join('\n');
function fixture(real = false) {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name' });
  return { version: 1, active: 0, realFilesystem: real, panes: [pane('/left'), pane('/right')], folders: {
    '/left': [{ id: 'a', name: 'same.txt', type: 'text', size: 3, date: '29.10.2026 14:32', content: 'new' }],
    '/right': [{ id: 'b', name: 'same.txt', type: 'text', size: 3, date: '28.10.2026 12:00', content: 'old' }]
  } };
}
function copy(app) { app.click(app.row('same.txt').querySelector('[data-filename]')); app.action('copy'); }
function submit(app) { app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); }

test('folder paths use the full value until the middle needs to be shortened', t => {
  const app = createApp(t, fixture());
  const shorten = app.window.BitfroestPathField.middleEllipsis;
  const measure = text => Array.from(text).length;
  assert.equal(shorten('/one/two/three', 20, measure), '/one/two/three');
  assert.equal(shorten('/one/two/three', 9, measure), '/one…hree');
  assert.equal(shorten('a👩‍💻xyzcd', 5, text => [...new Intl.Segmenter().segment(text)].length), 'a👩‍💻…cd');
});

test('copy target enters editing by activation and Escape restores the original path', t => {
  const app = createApp(t, fixture(), { language: 'en' }); copy(app);
  const target = app.document.querySelector('bitfroest-path input#value');
  assert.ok(target);
  const button = target.parentElement.querySelector('button');
  const style = app.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../media/path-field.css'), 'utf8');
  app.document.head.append(style);
  assert.equal(app.window.getComputedStyle(button).paddingLeft, '0px');
  assert.equal(app.window.getComputedStyle(button).borderLeftWidth, '0px');
  assert.equal(app.window.getComputedStyle(button).cursor, 'pointer');
  const pathRule = selector => [...style.sheet.cssRules].find(rule => rule.selectorText?.endsWith(selector)).style;
  assert.equal(pathRule('button.path-field-display:hover').textDecoration, 'none');
  assert.equal(pathRule('button.path-field-display:focus-visible').outline, 'none');
  assert.equal(pathRule('input.path-field-input:focus-visible').outline, 'none');
  assert.equal(target.hidden, true);
  assert.equal(button.textContent, '/right');
  assert.equal(app.document.activeElement, button);
  app.click(button);
  assert.equal(app.document.activeElement, target);
  assert.equal(app.window.getComputedStyle(target).paddingLeft, '0px');
  assert.equal(app.window.getComputedStyle(target).borderLeftWidth, '0px');
  assert.equal(target.value, '/right');
  target.value = '/temporary';
  app.key('Escape', {}, target);
  assert.equal(target.value, '/right');
  assert.equal(target.hidden, true);
  assert.equal(app.document.querySelector('#modal').open, true);
  app.click(button);
  target.value = '/edited';
  assert.equal(app.key('Enter', {}, target), false);
  assert.equal(button.textContent, '/edited');
  assert.equal(app.document.activeElement, app.document.querySelector('#modal-confirm'));
  assert.equal(app.document.querySelector('#modal').open, true);
});

test('the path component restores the complete display as space returns and keeps the edit value intact', t => {
  const observers = new Map();
  class ResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { observers.set(target, this.callback); }
    unobserve(target) { observers.delete(target); }
    disconnect() {}
  }
  const app = createApp(t, fixture(), { ResizeObserver }); copy(app);
  app.window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: value => ({ width: value.length }) });
  const field = app.document.querySelector('bitfroest-path:has(#value)'), button = field.querySelector('button');
  let width = 4;
  Object.defineProperty(button, 'clientWidth', { get: () => width });
  const resize = () => observers.get(field)([{ target: field }]);
  resize();
  assert.equal(button.textContent, '/r…t');
  assert.equal(field.title, '/right');
  app.click(button);
  assert.equal(field.querySelector('input').value, '/right');
  app.key('Escape', {}, field.querySelector('input'));
  width = 6; resize();
  assert.equal(button.textContent, '/right');
});

test('a folder dialog uses the shared heading with only the localized title', t => {
  const app = createApp(t, fixture(), { language: 'en' });
  app.action('mkdir');
  const heading = app.document.querySelector('#modal[open] .dialog-heading');
  assert.ok(heading);
  assert.equal(heading.textContent.trim(), 'New folder');
  assert.equal(heading.querySelector('#modal-title').textContent, 'New folder');
});

test('folder and text file creation show their destination with a full path tooltip', t => {
  const archive = 'zip:/project.zip!/nested';
  const data = fixture();
  data.panes[0].tabs = [archive];
  data.folders[archive] = [];
  data.archiveLocations = { [archive]: { archive: '/project.zip' } };
  for (const [state, expected] of [[fixture(), '/left'], [data, '/project.zip!/nested']]) {
    for (const action of ['mkdir', 'new-file']) {
      const app = createApp(t, state, { language: 'en' });
      app.action(action);
      const destination = app.document.querySelector('#modal[open] .path-field-row bitfroest-path');
      assert.ok(destination, action);
      assert.equal(destination.title, expected);
      assert.equal(destination.textContent, expected);
      assert.equal(destination.querySelector('input'), null);
      assert.equal(app.document.activeElement.id, 'value');
    }
  }
});

test('copy and move show only the localized title in compact regular type', t => {
  for (const [language, actions] of [
    ['de', ['Kopieren', 'Verschieben']],
    ['en', ['Copy', 'Move']]
  ]) {
    const app = createApp(t, fixture(), { language });
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(dialogCss);
    app.document.head.append(style);
    app.click(app.row('same.txt').querySelector('[data-filename]'));
    for (const [index, action] of ['copy', 'move'].entries()) {
      app.action(action);
      const title = app.document.querySelector('#modal-title');
      assert.equal(title.textContent, actions[index]);
      const selection = title.parentElement.querySelector('#modal-selection-count');
      assert.equal(selection.textContent, language === 'de' ? '(1 ausgewählter Eintrag)' : '(1 selected entry)');
      assert.equal(app.window.getComputedStyle(title.parentElement).display, 'flex');
      const titleStyle = app.window.getComputedStyle(title);
      assert.equal(titleStyle.fontWeight, '400');
      assert.equal(titleStyle.textTransform, 'uppercase');
      assert.ok(parseFloat(titleStyle.fontSize) < parseFloat(app.window.getComputedStyle(title.parentElement).fontSize));
      app.click(app.document.querySelector('#modal-cancel'));
    }
  }
});

test('transfer confirmation separates the heading from the body using theme colors', t => {
  const app = createApp(t, fixture());
  const style = app.document.createElement('style');
  app.document.head.append(style);
  copy(app);
  const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
  for (const [theme, background, foreground] of [
    ['vscode-dark', 'rgb(41, 122, 160)', 'rgb(255, 255, 255)'],
    ['vscode-high-contrast-light', 'rgb(255, 241, 176)', 'rgb(32, 32, 32)']
  ]) {
    app.document.body.className = theme;
    style.textContent = resolveThemeCss(dialogCss, {
      'banner-background': '#303132',
      'button-background': background,
      'button-foreground': foreground,
      contrastBorder: '#89a5bf'
    });
    assert.equal(computed('.modal-heading').backgroundColor, background);
    assert.equal(computed('.modal-heading').paddingBlock, '4px');
    assert.equal(computed('#modal-close').height, '28px');
    assert.equal(computed('.modal-heading').borderBottomWidth, '1px');
    assert.equal(computed('.modal-heading').borderBottomColor, 'rgb(137, 165, 191)');
    for (const selector of ['#modal-title', '#modal-close']) {
      assert.equal(computed(selector).color, foreground);
    }
  }
});

test('transfer dialog exposes its accessible name, source, description and selected destination', t => {
  const app = createApp(t, fixture()); copy(app);
  const dialog = app.document.querySelector('dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'modal-title');
  assert.equal(dialog.getAttribute('aria-describedby'), 'modal-selection-count');
  assert.equal(app.document.querySelector('[data-transfer-source]').textContent, '/left');
  assert.ok(app.document.querySelector('.path-field-row > [data-transfer-source] > bitfroest-path'));
  assert.ok(app.document.querySelector('#modal-confirm.vscode-button'));
  assert.ok(app.document.querySelector('#modal-cancel.vscode-button.secondary'));
  assert.ok(app.document.querySelector('#modal-close.vscode-action-button'));
  assert.match(app.document.querySelector('.dialog-heading #modal-selection-count').textContent, /^\(1 .+\)$/);
  assert.equal(app.document.querySelector('#modal-body #modal-description'), null);
  const input = app.document.querySelector('#value');
  app.click(input.parentElement.querySelector('button'));
  assert.equal(app.document.activeElement, input);
  assert.equal(input.selectionEnd - input.selectionStart, input.value.length);
  assert.ok(app.document.querySelector('details.dialog-options #transfer-policy'));
  app.click(app.document.querySelector('#modal-cancel'));
  app.action('mkdir');
  assert.equal(app.document.querySelector('#modal-selection-count'), null);
});

test('operations with a known selection use the same count beside the heading', t => {
  const state = fixture(true);
  state.folders['/left'].push({ id: 'c', name: 'other.txt', type: 'text', size: 1, content: 'a' });
  const app = createApp(t, state, { language: 'en' });
  app.click(app.row('same.txt').querySelector('[data-filename]'));
  app.click(app.row('other.txt').querySelector('[data-filename]'), { ctrlKey: true });
  for (const action of ['copy', 'move', 'rename', 'pack', 'delete']) {
    app.action(action);
    const count = app.document.querySelector('.dialog-heading #modal-selection-count');
    assert.equal(count?.textContent, '(2 selected entries)', action);
    assert.match(app.document.querySelector('#modal').getAttribute('aria-describedby'), /\bmodal-selection-count\b/);
    app.click(app.document.querySelector('#modal-cancel'));
  }
});

test('transfer options use separate aligned checkbox rows and localized tooltips in every theme', t => {
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) for (const language of ['de', 'en']) {
    const app = createApp(t, fixture(), { language });
    const style = app.document.createElement('style');
    const media = path.join(__dirname, '../media');
    const imports = fs.readFileSync(path.join(media, 'transfer-controls.css'), 'utf8').matchAll(/@import url\("([^"\n]+)"\)/g);
    const css = [...imports].map(([, href]) => fs.readFileSync(path.resolve(media, href), 'utf8'));
    css.push(fs.readFileSync(path.join(media, 'app.css'), 'utf8'));
    style.textContent = resolveThemeCss(css.join('\n'));
    app.document.head.append(style); app.document.body.className = theme;
    copy(app);
    const body = app.document.querySelector('#modal-body');
    assert.equal(app.window.getComputedStyle(body.querySelector('.transfer-source')).display, 'grid');
    const group = body.querySelector('.vscode-checkbox-group.vertical'); assert.ok(group);
    assert.equal(app.window.getComputedStyle(group).flexDirection, 'column');
    for (const id of ['transfer-verify', 'transfer-individual']) {
      const checkbox = body.querySelector(`#${id}`), label = checkbox.labels[0];
      assert.equal(label.parentElement.parentElement, group);
      assert.ok(label.parentElement.classList.contains('vscode-checkbox'));
      assert.equal(app.window.getComputedStyle(label.querySelector('.text')).overflowWrap, 'anywhere');
      assert.ok(checkbox.title.length > 25);
      assert.equal(label.title, checkbox.title);
      assert.equal(checkbox.getAttribute('aria-description'), checkbox.title);
      assert.equal(checkbox.checked, false);
      const mark = label.querySelector('.icon-checked');
      assert.equal(app.window.getComputedStyle(mark).display, 'none');
      app.click(label.querySelector('.text')); assert.equal(checkbox.checked, true);
      assert.equal(app.window.getComputedStyle(mark).display, 'block');
      checkbox.focus(); assert.equal(app.document.activeElement, checkbox);
    }
    assert.equal(body.querySelectorAll('.dialog-hint').length, 0);
    assert.match(body.querySelector('#transfer-filter').title, /\*/);
    assert.match(body.querySelector('#transfer-individual').title, language === 'de' ? /Zielordner/ : /target folder/);
    assert.ok(group.closest('fieldset').querySelector('legend').textContent);
  }
});

test('conflict compares source and target and separates single decisions from bulk policies', async t => {
  const app = createApp(t, fixture(), { language: 'en' }); copy(app); submit(app); await tick();
  assert.equal(app.document.querySelector('.conflict-file-heading .comparison-name').textContent, 'same.txt');
  assert.equal(app.document.querySelectorAll('.comparison-name').length, 1);
  assert.match(app.document.querySelector('[data-property="date"] [data-role="target"]').textContent, /28.10.2026/);
  assert.ok(app.document.querySelector('fieldset.conflict-single [data-conflict-action="overwrite"]'));
  assert.ok(app.document.querySelector('details.dialog-options [data-conflict-action="overwrite-all"]'));
  assert.equal(app.document.querySelector('[data-conflict-action="overwrite"]').getAttribute('data-destructive'), 'true');
  assert.equal(app.document.activeElement.id, 'conflict-name');
  submit(app); await tick();
  assert.equal(app.state().folders['/right'][0].content, 'old');
  assert.equal(app.document.querySelector('dialog').open, true);
});

test('disabled conflict actions explain why they cannot be used', async t => {
  const app = createApp(t, fixture(true), { language: 'en' }); copy(app); submit(app); await tick();
  const append = app.document.querySelector('[data-conflict-action="append"]');
  assert.equal(append.disabled, true);
  assert.ok(append.title.length > 10);
  assert.equal(append.getAttribute('aria-describedby'), 'conflict-limitations');
  assert.match(append.title, /Append/i);
});

test('a delayed close event from the transfer form cannot cancel its newly opened conflict dialog', async t => {
  const app = createApp(t, fixture());
  app.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    queueMicrotask(() => this.dispatchEvent(new app.window.Event('close')));
  };
  copy(app); submit(app); await tick();
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(app.document.querySelector('#modal-title').textContent, 'Datei bereits vorhanden');
  assert.equal(app.state().folders['/right'][0].content, 'old');
  assert.equal(app.document.querySelector('#modal-cancel').hidden, true);
  assert.equal(app.document.querySelector('#modal-close').hidden, false);
  app.click(app.document.querySelector('#modal-close')); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
});

test('destination filename dialog wraps long names and retains a shared action row in all themes', async t => {
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
    const state = fixture(); state.folders['/left'][0].name = `${'long-name-'.repeat(30)}.txt`;
    const app = createApp(t, state);
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
    app.document.head.append(style); app.document.body.className = theme;
    app.click(app.row(state.folders['/left'][0].name).querySelector('[data-filename]')); app.action('copy');
    app.document.querySelector('#transfer-individual').checked = true; submit(app); await tick();
    const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
    assert.equal(computed('.individual-rename').minWidth, '0px');
    assert.equal(computed('[data-rename-source]').overflowWrap, 'anywhere');
    assert.equal(computed('[data-rename-preview]').overflowWrap, 'anywhere');
    assert.equal(computed('.modal-actions').display, 'flex');
    assert.ok(app.document.querySelector('.modal-actions #transfer-skip'));
    assert.equal(app.document.activeElement.id, 'value');
    app.click(app.document.querySelector('#modal-cancel')); await tick();
    assert.equal(app.state().folders['/right'].length, 1);
  }
});

test('dark and contrast dialogs avoid permanent comparison and individual action frames', async t => {
  for (const theme of ['vscode-dark', 'vscode-high-contrast']) {
    const app = createApp(t, fixture());
    const style = app.document.createElement('style');
    style.textContent = resolveThemeCss(fs.readFileSync(path.join(__dirname, '../media/app.css'), 'utf8'));
    app.document.head.append(style);
    app.document.body.className = theme;
    copy(app); submit(app); await tick();
    const computed = selector => app.window.getComputedStyle(app.document.querySelector(selector));
    assert.equal(computed('.file-comparison-grid').borderTopWidth, '0px', `${theme} comparison frame`);
    assert.equal(computed('.conflict-comparison').display, 'grid', `${theme} compact metadata`);
    assert.equal(computed('[data-conflict-action="overwrite"]').borderTopWidth, theme === 'vscode-dark' ? '1px' : '0px', `${theme} action frame`);
    assert.equal(computed('[data-conflict-action="overwrite"]').borderLeftWidth, theme === 'vscode-dark' ? '1px' : '0px', `${theme} destructive stripe`);
    assert.equal(app.document.activeElement.id, 'conflict-name');
  }
});
