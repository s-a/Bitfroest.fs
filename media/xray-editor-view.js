(function () {
'use strict';
const monaco = window.BitfroestMonaco;

monaco.languages.register({ id: 'json' });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'], [/"(?:[^"\\]|\\.)*"/, 'string.value.json'], [/\b(?:true|false|null)\b/, 'keyword.json'], [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number.json'], [/[{}[\]]/, '@brackets'], [/[,:]/, 'delimiter.json']] } });
const names = { sql: 'sql', json: 'json', jsonc: 'json', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', js: 'javascript', cjs: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', sh: 'shell', md: 'markdown' };
function statistics(changes, original, modified) {
  const lines = text => text ? text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0) : 0;
  const originalLines = lines(original), modifiedLines = lines(modified);
  const count = (start, end, total) => end === 0 ? 0 : Math.max(0, Math.min(end, total) - start + 1);
  const result = { added: 0, changed: 0, deleted: 0 };
  for (const change of changes || []) {
    const before = count(change.originalStartLineNumber, change.originalEndLineNumber, originalLines), after = count(change.modifiedStartLineNumber, change.modifiedEndLineNumber, modifiedLines);
    const replaced = Math.min(before, after); result.changed += replaced; result.added += after - replaced; result.deleted += before - replaced;
  }
  return result;
}
window.BitfroestXrayEditor = {
  statistics,
  createDiff(element, originalText, modifiedText, name, { onCopy, onOpen, copyLabel, onStatistics = () => {} }) {
    const language = names[name.split('.').pop().toLowerCase()] || 'plaintext';
    const original = monaco.editor.createModel(originalText, language), modified = monaco.editor.createModel(modifiedText, language);
    const style = getComputedStyle(document.body);
    const editor = monaco.editor.createDiffEditor(element, { readOnly: true, originalEditable: false, domReadOnly: true, renderSideBySide: false,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, contextmenu: true, enableSplitViewResizing: false,
      renderOverviewRuler: true, ignoreTrimWhitespace: false, hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 10 },
      fontFamily: style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace', fontSize: parseFloat(style.getPropertyValue('--vscode-editor-font-size')) || 14 });
    let finish, fail;
    const ready = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const timeout = setTimeout(() => fail(new Error('Diff computation timed out.')), 15000);
    editor.onDidUpdateDiff(() => {
      const result = editor.getDiffComputationResult();
      if (!result) return;
      clearTimeout(timeout);
      if (result.quitEarly) fail(new Error('Diff computation limit exceeded.'));
      else { onStatistics(statistics(result.changes, originalText, modifiedText)); finish(); }
    });
    editor.setModel({ original, modified });
    for (const pane of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
      pane.addAction({ id: 'quick-diff.copy', label: copyLabel, precondition: 'editorHasSelection', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC], contextMenuGroupId: 'clipboard', run: () => onCopy(pane.getModel().getValueInRange(pane.getSelection())) });
      pane.onMouseDown(event => { if (event.event.detail === 2) onOpen(); });
    }
    const theme = () => monaco.editor.setTheme(document.body.classList.contains('vscode-high-contrast-light') ? 'hc-light' : document.body.classList.contains('vscode-high-contrast') ? 'hc-black' : document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark');
    theme(); const observer = new MutationObserver(theme); observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return { ready, dispose() { clearTimeout(timeout); finish(); observer.disconnect(); editor.dispose(); original.dispose(); modified.dispose(); } };
  },
  create(element, text, name, { onCopy, onOpenLine, copyLabel }) {
    const model = monaco.editor.createModel(text, names[name.split('.').pop().toLowerCase()] || 'plaintext');
    const style = getComputedStyle(document.body);
    const editor = monaco.editor.create(element, { model, readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: true }, scrollBeyondLastLine: false, contextmenu: true, wordWrap: 'off', fontFamily: style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace', fontSize: parseFloat(style.getPropertyValue('--vscode-editor-font-size')) || 14 });
    editor.addAction({ id: 'xray.copy', label: copyLabel, precondition: 'editorHasSelection', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC], contextMenuGroupId: 'clipboard', run: () => onCopy(model.getValueInRange(editor.getSelection())) });
    editor.onMouseDown(event => { if (event.event.detail === 2 && event.target.position) onOpenLine(event.target.position.lineNumber); });
    const hover = editor.createDecorationsCollection(); let hoverLine = null;
    editor.onMouseMove(event => {
      const line = event.target.position?.lineNumber;
      if (line === hoverLine) return;
      hoverLine = line;
      hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'xray-hover-line' } }] : []);
    });
    editor.onMouseLeave(() => { hoverLine = null; hover.clear(); });
    const theme = () => monaco.editor.setTheme(document.body.classList.contains('vscode-high-contrast-light') ? 'hc-light' : document.body.classList.contains('vscode-high-contrast') ? 'hc-black' : document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark');
    theme();
    const observer = new MutationObserver(theme); observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return { dispose() { observer.disconnect(); editor.dispose(); model.dispose(); } };
  }
};

})();
