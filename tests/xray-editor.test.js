const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Quick Diff is inline, read-only, copies either version and disposes both models', () => {
  const models = [], panes = [], opened = [], copied = []; let options, disposed = 0;
  const monaco = { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyC: 2 }, languages: { register() {}, setMonarchTokensProvider() {} }, editor: {
    createModel(text, language) { const model = { text, language, dispose() { disposed++; }, getValueInRange: () => text }; models.push(model); return model; },
    createDiffEditor(_element, value) { options = value; return { onDidUpdateDiff() {}, getDiffComputationResult: () => ({}), setModel() {}, getOriginalEditor: () => panes[0], getModifiedEditor: () => panes[1], dispose() { disposed++; } }; }, setTheme() {}
  } };
  for (let i = 0; i < 2; i++) panes.push({ updateOptions(value) { this.options = value; }, addAction(action) { this.action = action; }, onMouseDown(fn) { this.down = fn; }, getModel: () => models[i], getSelection: () => ({}) });
  const context = { setTimeout, clearTimeout, window: { BitfroestMonaco: monaco }, getComputedStyle: () => ({ getPropertyValue: () => '' }), document: { body: { classList: { contains: () => false } } }, MutationObserver: class { observe() {} disconnect() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/xray-editor-view.js'), 'utf8'), context);
  const stats = context.window.BitfroestXrayEditor.statistics([
    { originalStartLineNumber: 1, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 3 },
    { originalStartLineNumber: 5, originalEndLineNumber: 6, modifiedStartLineNumber: 5, modifiedEndLineNumber: 0 }
  ], 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\n');
  assert.equal(stats.changed, 2); assert.equal(stats.added, 1); assert.equal(stats.deleted, 1);
  const view = context.window.BitfroestXrayEditor.createDiff({}, 'select 1;', 'select 2;', 'a.sql', { onCopy: text => copied.push(text), onOpen: () => opened.push(true), copyLabel: 'Copy' });
  assert.equal(options.renderSideBySide, false); assert.equal(options.readOnly, true); assert.equal(options.originalEditable, false); assert.equal(options.minimap.enabled, false);
  assert.equal(options.hideUnchangedRegions.enabled, true); assert.equal(options.hideUnchangedRegions.contextLineCount, 3);
  panes[0].action.run(); panes[1].action.run(); assert.deepEqual(copied, ['select 1;', 'select 2;']);
  panes[1].down({ event: { detail: 2 } }); assert.equal(opened.length, 1);
  assert.equal(models[0].language, 'sql'); view.dispose(); assert.equal(disposed, 3);
});

test('X-Ray editor provides selection copy, double-click line opening and a hover decoration', () => {
  const events = {}, actions = [], opened = [], copied = [], decorations = [];
  const modelLanguages = [];
  const model = { getValueInRange: () => 'selected text', dispose() {} };
  const editor = { getSelection: () => ({}), addAction: action => actions.push(action), onMouseDown: fn => { events.down = fn; }, onMouseMove: fn => { events.move = fn; }, onMouseLeave: fn => { events.leave = fn; }, createDecorationsCollection: () => ({ set: value => decorations.push(value), clear: () => decorations.push([]) }), dispose() {} };
  const monaco = { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyC: 2 }, Range: class { constructor(...args) { this.args = args; } }, languages: { register() {}, setMonarchTokensProvider() {} }, editor: { createModel: (_text, language) => { modelLanguages.push(language); return model; }, create: () => editor, setTheme() {} } };
  const context = { monaco, window: { BitfroestMonaco: monaco }, getComputedStyle: () => ({ getPropertyValue: () => '' }), document: { body: { classList: { contains: () => false } } }, MutationObserver: class { observe() {} disconnect() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/xray-editor-view.js'), 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  context.window.BitfroestXrayEditor.create({}, 'text', 'file.ps1', { onCopy: text => copied.push(text), onOpenLine: line => opened.push(line), copyLabel: 'Copy' });
  assert.equal(actions.length, 1);
  actions[0].run(); assert.deepEqual(copied, ['selected text']);
  assert.equal(typeof events.down, 'function');
  events.down({ event: { detail: 2 }, target: { position: { lineNumber: 17 } } });
  assert.deepEqual(opened, [17]);
  events.move({ target: { position: { lineNumber: 8 } } });
  assert.equal(decorations.at(-1)[0].options.isWholeLine, true);
  events.leave(); assert.equal(decorations.at(-1).length, 0);
  context.window.BitfroestXrayEditor.create({}, 'SELECT 1;', 'query.SQL', { onCopy() {}, onOpenLine() {}, copyLabel: 'Copy' });
  assert.equal(modelLanguages.at(-1), 'sql');
});
