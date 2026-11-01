(function (root) {
  'use strict';
  root.installCommanderShortcuts = function ({ host, focus, enabled, decorate }) {
    const model = root.CommanderShortcuts, platform = document.body.dataset.platform || 'win32';
    let catalog = [], bindings = {};
    const synthetic = new WeakSet();
    const originals = [...document.querySelectorAll('[data-menu-action]')].map(item => ({ item, aria: item.getAttribute('aria-keyshortcuts'), title: item.getAttribute('title'), hints: item.querySelector('.menu-shortcuts')?.cloneNode(true) }));
    function hints() {
      for (const original of originals) {
        const { item } = original, entries = catalog.filter(entry => entry.command === `bitfroest.${item.dataset.menuAction}` && (entry.when.includes('listFocus') || entry.when.includes('tabFocus')) && !entry.when.includes('searchResults'));
        item.querySelector('.menu-shortcuts')?.remove();
        for (const [attribute, value] of [['aria-keyshortcuts', original.aria], ['title', original.title]]) { if (value === null) item.removeAttribute(attribute); else item.setAttribute(attribute, value); }
        if (!entries.some(entry => Object.hasOwn(bindings, entry.id))) { if (original.hints) item.append(original.hints.cloneNode(true)); continue; }
        const keys = [...new Set(entries.flatMap(entry => model.keys(entry, bindings, platform)))];
        if (!keys.length) { item.removeAttribute('aria-keyshortcuts'); item.title = item.firstChild.textContent.trim(); continue; }
        if (decorate) { decorate(item, keys); continue; }
        const names = { ctrl: 'Control', cmd: 'Meta', shift: 'Shift', alt: 'Alt', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
        item.setAttribute('aria-keyshortcuts', keys.map(key => key.split('+').map(part => names[part] || part.toUpperCase()).join('+')).join(' '));
        const label = keys.map(key => key.split('+').map(part => part === 'cmd' ? '⌘' : part === 'ctrl' && /^de/.test(document.documentElement.lang) ? 'Strg' : part.toUpperCase()).join('+')).join(' / ');
        const span = document.createElement('span'); span.className = 'menu-shortcuts'; span.setAttribute('aria-hidden', 'true'); span.textContent = label; item.append(span); item.title = `${item.firstChild.textContent.trim()} (${label})`;
      }
    }
    function update(message) {
      try { const next = message.catalog || catalog; const values = model.validate(next, message.bindings || {}, platform); catalog = next; bindings = values; hints(); }
      catch { /* Invalid settings do not replace the active bindings. */ }
    }
    window.addEventListener('message', event => { if (event.data?.type === 'shortcut-settings') update(event.data); });
    window.addEventListener('keydown', event => {
      if (synthetic.has(event) || !enabled() || !Object.keys(bindings).length) return;
      const key = model.capture(event); if (!key) return;
      const result = model.resolve(catalog, bindings, key, focus(), platform); if (!result) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!result.entry) return;
      if (result.entry.source !== 'local') { host?.postMessage({ type: 'shortcut-execute', id: result.entry.id, key }); return; }
      const parts = result.entry.key.split('+'), name = parts.pop();
      const aliases = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', backspace: 'Backspace', tab: 'Tab', enter: 'Enter', space: ' ', escape: 'Escape', contextmenu: 'ContextMenu' };
      const replacement = new KeyboardEvent('keydown', { key: aliases[name] || name, ctrlKey: parts.includes('ctrl'), metaKey: parts.includes('cmd'), altKey: parts.includes('alt'), shiftKey: parts.includes('shift'), bubbles: true, cancelable: true });
      synthetic.add(replacement); event.target.dispatchEvent(replacement);
    }, true);
    const keysFor = (command, fallback) => {
      const entries = catalog.filter(entry => entry.command === `bitfroest.${command}` && (entry.when.includes('listFocus') || entry.when.includes('tabFocus')) && !entry.when.includes('searchResults'));
      return entries.length ? [...new Set(entries.flatMap(entry => model.keys(entry, bindings, platform)))] : fallback;
    };
    if (document.body.dataset.shortcutSettings) update(JSON.parse(decodeURIComponent(document.body.dataset.shortcutSettings)));
    return { keysFor };
  };
})(globalThis);
