(function () {
'use strict';
const monaco = window.CommanderMonaco;

monaco.languages.register({ id: 'json' });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'], [/"(?:[^"\\]|\\.)*"/, 'string.value.json'], [/\b(?:true|false|null)\b/, 'keyword.json'], [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number.json'], [/[{}[\]]/, '@brackets'], [/[,:]/, 'delimiter.json']] } });
const names = { json: 'json', jsonc: 'json', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', js: 'javascript', cjs: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', sh: 'shell', md: 'markdown' };
window.CommanderXrayEditor = {
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
