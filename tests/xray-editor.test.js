const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('X-Ray editor provides selection copy, double-click line opening and a hover decoration', () => {
  const events = {}, actions = [], opened = [], copied = [], decorations = [];
  const modelLanguages = [];
  const model = { getValueInRange: () => 'selected text', dispose() {} };
  const editor = { getSelection: () => ({}), addAction: action => actions.push(action), onMouseDown: fn => { events.down = fn; }, onMouseMove: fn => { events.move = fn; }, onMouseLeave: fn => { events.leave = fn; }, createDecorationsCollection: () => ({ set: value => decorations.push(value), clear: () => decorations.push([]) }), dispose() {} };
  const monaco = { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyC: 2 }, Range: class { constructor(...args) { this.args = args; } }, languages: { register() {}, setMonarchTokensProvider() {} }, editor: { createModel: (_text, language) => { modelLanguages.push(language); return model; }, create: () => editor, setTheme() {} } };
  const context = { monaco, window: { CommanderMonaco: monaco }, getComputedStyle: () => ({ getPropertyValue: () => '' }), document: { body: { classList: { contains: () => false } } }, MutationObserver: class { observe() {} disconnect() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/xray-editor-view.js'), 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  context.window.CommanderXrayEditor.create({}, 'text', 'file.ps1', { onCopy: text => copied.push(text), onOpenLine: line => opened.push(line), copyLabel: 'Copy' });
  assert.equal(actions.length, 1);
  actions[0].run(); assert.deepEqual(copied, ['selected text']);
  assert.equal(typeof events.down, 'function');
  events.down({ event: { detail: 2 }, target: { position: { lineNumber: 17 } } });
  assert.deepEqual(opened, [17]);
  events.move({ target: { position: { lineNumber: 8 } } });
  assert.equal(decorations.at(-1)[0].options.isWholeLine, true);
  events.leave(); assert.equal(decorations.at(-1).length, 0);
  context.window.CommanderXrayEditor.create({}, 'SELECT 1;', 'query.SQL', { onCopy() {}, onOpenLine() {}, copyLabel: 'Copy' });
  assert.equal(modelLanguages.at(-1), 'sql');
});
