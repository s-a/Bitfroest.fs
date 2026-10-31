(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderShortcuts = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const guard = / && !bitfroest\.shortcutOverride\.[a-z0-9]+/g;
  const aliases = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Escape: 'escape', ' ': 'space', Control: null, Shift: null, Alt: null, Meta: null, Dead: null, Process: null, Unidentified: null };
  const numpad = { NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract', NumpadMultiply: 'numpad_multiply', NumpadDivide: 'numpad_divide' };
  const samples = [
    { listFocus: true }, { listFocus: true, searchResults: true },
    { textInput: true }, { textInput: true, inlineRenameInput: true, fileDialog: true },
    { textInput: true, transferNameInput: true, fileDialog: true }, { textInput: true, fileDialog: true },
    { textInput: true, fileDialog: true, conflictDialog: true },
    { listerFocus: true }, { searchFocus: true, textInput: true, fileDialog: true },
    { searchFocus: true, searchResultsFocus: true, textInput: true, fileDialog: true }
  ];
  function idFor(value) {
    let hash = 2166136261;
    for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    return `k${(hash >>> 0).toString(36)}`;
  }
  function createCatalog(manifest) {
    const result = manifest.contributes.keybindings.map(binding => {
      const when = (binding.when || '').replace(guard, '');
      const id = idFor(JSON.stringify([binding.command, binding.key, binding.args ?? null, when]));
      const declaration = manifest.contributes.commands.find(c => c.command === binding.command);
      return { ...binding, when, id, source: 'manifest', title: declaration?.title || binding.command, editable: Boolean(when) && !binding.command.endsWith('ignore-dialog-function-key') };
    });
    for (const [name, key, label, extra] of [
      ['pane', 'tab', 'Panel wechseln'], ['open', 'enter', 'Eintrag öffnen'], ['parent', 'backspace', 'Übergeordnetes Verzeichnis'],
      ['mark', 'space', 'Markierung umschalten'], ['favorites', 'ctrl+d', 'Favoriten öffnen'], ['sizes', 'alt+shift+enter', 'Ordnergrößen berechnen'],
      ['context', 'contextmenu', 'Kontextmenü öffnen'],
      ['up', 'up', 'Cursor nach oben'], ['down', 'down', 'Cursor nach unten'], ['first', 'home', 'Erster Eintrag'], ['last', 'end', 'Letzter Eintrag'],
      ['pageup', 'pageup', 'Eine Seite nach oben'], ['pagedown', 'pagedown', 'Eine Seite nach unten'],
      ['cancel', 'escape', 'Abbrechen', true]
    ]) result.push({ id: `local${name}`, key, command: `local.${name}`, title: label, when: extra ? 'bitfroest.listFocus' : 'bitfroest.listFocus && !bitfroest.textInput', source: 'local', editable: !extra });
    for (const command of manifest.contributes.commands) {
      if (result.some(item => item.command === command.command)) continue;
      result.push({ id: idFor(command.command), command: command.command, key: '', title: command.title, when: 'bitfroest.listFocus && !bitfroest.textInput', source: 'command', editable: command.command !== 'bitfroest.select-all-text' });
    }
    return result;
  }
  function normalize(value) {
    if (typeof value !== 'string') throw new Error('Ungültige Tastenkombination.');
    const parts = value.toLowerCase().trim().split('+'), key = parts.pop();
    if (!key || !/^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|up|down|left|right|home|end|pageup|pagedown|backspace|delete|insert|enter|escape|tab|space|contextmenu|numpad_(?:add|subtract|multiply|divide)|\[(?:semicolon|quote)\])$/.test(key) || new Set(parts).size !== parts.length || parts.some(part => !['ctrl', 'cmd', 'alt', 'shift'].includes(part))) throw new Error('Eine einzelne unterstützte Tastenkombination ist erforderlich.');
    return [...['ctrl', 'cmd', 'alt', 'shift'].filter(part => parts.includes(part)), key].join('+');
  }
  function capture(event) {
    if (event.isComposing || event.getModifierState?.('AltGraph') || event.ctrlKey && event.altKey && !event.metaKey) return null;
    let key = numpad[event.code] || (event.altKey && ['Semicolon', 'Quote'].includes(event.code) ? `[${event.code.toLowerCase()}]` : Object.hasOwn(aliases, event.key) ? aliases[event.key] : event.key?.toLowerCase());
    if (!key) return null;
    try { key = normalize([event.ctrlKey && 'ctrl', event.metaKey && 'cmd', event.altKey && 'alt', event.shiftKey && 'shift', key].filter(Boolean).join('+')); } catch { return null; }
    return key;
  }
  function combinations(value) { return value === '' ? [] : value.split('|').map(part => normalize(part.trim())); }
  function keys(entry, overrides, platform) { return combinations(Object.hasOwn(overrides, entry.id) ? overrides[entry.id] : platform === 'darwin' ? entry.mac ?? entry.key : platform === 'linux' ? entry.linux ?? entry.key : entry.win ?? entry.key); }
  function active(entry, focus, platform) {
    const values = { 'activeWebviewPanelId': 'bitfroestPrototype', webviewFocus: true, isWindows: platform === 'win32', isLinux: platform === 'linux', isMac: platform === 'darwin', 'bitfroest.ready': true };
    for (const [key, value] of Object.entries(focus)) values[`bitfroest.${key}`] = value;
    return entry.when.split('&&').every(part => {
      part = part.trim();
      if (!part) return true;
      if (part.includes('==')) { const [key, value] = part.split('==').map(x => x.trim()); return values[key] === value; }
      return part.startsWith('!') ? !values[part.slice(1)] : Boolean(values[part]);
    });
  }
  function conflicts(catalog, overrides, platform) {
    const result = [];
    for (let i = 0; i < catalog.length; i++) for (let j = i + 1; j < catalog.length; j++) {
      const a = catalog[i], b = catalog[j];
      if (!Object.hasOwn(overrides, a.id) && !Object.hasOwn(overrides, b.id)) continue;
      if (a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)) continue;
      const common = keys(a, overrides, platform).filter(key => keys(b, overrides, platform).includes(key));
      if (common.length && samples.some(focus => active(a, focus, platform) && active(b, focus, platform))) result.push({ ids: [a.id, b.id], keys: common });
    }
    return result;
  }
  function validate(catalog, input = {}, platform) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ungültige Tastaturbelegungen.');
    const result = {};
    for (const [id, value] of Object.entries(input)) {
      const entry = catalog.find(item => item.id === id);
      if (!entry?.editable || typeof value !== 'string' || value.length > 512) throw new Error('Unbekannte oder geschützte Tastaturbelegung.');
      const list = combinations(value);
      if (list.length > 8 || list.some(key => !key.includes('+') && /^[a-z0-9]$/.test(key))) throw new Error('Zeichentasten bleiben für die Schnellsuche reserviert.');
      const editsText = samples.some(focus => focus.textInput && active(entry, focus, platform));
      if (editsText && list.some(key => !keys(entry, {}, platform).includes(key) && (!key.includes('+') && !/^f\d+$/.test(key) || /^(?:ctrl|cmd)\+(?:shift\+)?(?:a|c|x|v|z|y|left|right|up|down|home|end|backspace|delete)$/.test(key)))) throw new Error('Diese Tastenkombination bleibt für die Textbearbeitung reserviert.');
      result[id] = [...new Set(list)].join(' | ');
    }
    if (conflicts(catalog, result, platform).length) throw new Error('Überlappende Tastaturbelegungen müssen zuerst aufgelöst werden.');
    return result;
  }
  function resolve(catalog, overrides, key, focus, platform) {
    const changed = catalog.filter(item => Object.hasOwn(overrides, item.id) && active(item, focus, platform));
    if (!changed.length) return null;
    const matching = changed.filter(item => keys(item, overrides, platform).includes(key));
    if (matching.length) return { entry: matching.at(-1) };
    const blocked = changed.some(item => keys(item, {}, platform).includes(key));
    if (!blocked) return null;
    const replacement = catalog.filter(item => !Object.hasOwn(overrides, item.id) && active(item, focus, platform) && keys(item, {}, platform).includes(key)).at(-1);
    return replacement ? { entry: replacement } : { blocked: true };
  }
  return { createCatalog, normalize, capture, keys, active, conflicts, validate, resolve };
});
