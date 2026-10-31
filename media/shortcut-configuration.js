(function (root) {
  'use strict';
  root.createShortcutConfiguration = function ({ t, changed, blocked }) {
    const model = root.CommanderShortcuts, $ = selector => document.querySelector(selector);
    let catalog = [], data = {}, base = {}, platform = 'win32', editing, candidate = '', returnFocus;
    const effective = () => ({ ...base, ...data });
    const format = key => key.split('+').map(part => ({ ctrl: t('Strg'), cmd: '⌘', alt: 'Alt', shift: t('Umschalt'), up: '↑', down: '↓', left: '←', right: '→', numpad_add: 'Num +', numpad_subtract: 'Num −', numpad_multiply: 'Num *', numpad_divide: 'Num /' })[part] || part.toUpperCase()).join('+');
    const safeKeys = item => { try { return model.keys(item, effective(), platform); } catch { return [t('Ungültige Tastaturbelegungen.')]; } };
    const name = item => `${t(item.title)}${item.args === undefined ? '' : ` · ${item.detail || (typeof item.args === 'string' ? item.args : JSON.stringify(item.args))}`}`;
    const area = item => t(!item.when ? 'Global' : item.when.includes('conflictDialog') ? 'Dateikonfliktdialog' : item.when.includes('transferNameInput') ? 'Dateiname im Transferdialog' : item.when.includes('inlineRenameInput') ? 'Umbenennen' : item.when.includes('searchResultsFocus') ? 'Suchtreffer' : item.when.includes('searchFocus') ? 'Dateisuche' : item.when.includes('listerFocus') ? 'Lister' : item.when.includes('fileDialog') ? 'Dateidialog' : 'Dateiliste');
    function close() {
      editing = null;
      if ($('#shortcut-dialog').open) $('#shortcut-dialog').close();
      document.querySelector(`[data-shortcut-row="${returnFocus}"] [data-shortcut-edit]`)?.focus();
    }
    function render() {
      let invalid = '', conflicts = [];
      try { conflicts = model.conflicts(catalog, effective(), platform); model.validate(catalog, effective(), platform); }
      catch (failure) { if (!conflicts.length) invalid = t(failure.message); }
      const ids = new Set(conflicts.flatMap(pair => pair.ids));
      const query = $('#shortcut-search').value.toLocaleLowerCase(), filter = $('#shortcut-filter').value;
      const body = $('#shortcut-rows'); body.replaceChildren();
      $('#shortcut-conflicts').textContent = invalid || conflicts.map(pair => `${pair.keys.map(format).join(', ')}: ${pair.ids.map(id => name(catalog.find(item => item.id === id))).join(' ↔ ')}`).join('\n');
      blocked(Boolean(invalid) || conflicts.length > 0);
      for (const item of catalog) {
        const values = safeKeys(item), custom = Object.hasOwn(data, item.id);
        if (filter === 'changed' && !custom || filter === 'conflicts' && !ids.has(item.id) || !`${name(item)} ${item.command} ${area(item)} ${values.join(' ')}`.toLocaleLowerCase().includes(query)) continue;
        const row = document.createElement('tr'); row.dataset.shortcutRow = item.id; row.dataset.command = item.command; row.dataset.defaultKey = item.key;
        const cell = value => { const td = document.createElement('td'); td.textContent = value; row.append(td); return td; };
        cell(name(item)); cell(values.map(format).join(' / ') || t('Nicht belegt')); cell(area(item));
        cell(t(custom ? 'Eigene Belegung' : Object.hasOwn(base, item.id) ? 'Vom Benutzer geerbt' : 'Standard'));
        cell(t(ids.has(item.id) ? 'Konflikt' : 'Externe Belegungen ungeprüft'));
        const actions = cell('');
        for (const [kind, label, disabled, action] of [
          ['edit', 'Ändern…', !item.editable, () => { editing = item; candidate = values.join(' | '); returnFocus = item.id; $('#shortcut-capture').value = values.map(format).join(' / '); $('#shortcut-dialog-title').textContent = name(item); $('#shortcut-capture-error').textContent = ''; $('#shortcut-dialog').showModal(); $('#shortcut-capture').focus(); }],
          ['remove', 'Entfernen', !item.editable || !values.length, () => { data[item.id] = ''; changed(); render(); }],
          ['reset', 'Standard wiederherstellen', !custom, () => { delete data[item.id]; changed(); render(); }]
        ]) { const button = document.createElement('button'); button.type = 'button'; button.dataset[`shortcut${kind[0].toUpperCase()}${kind.slice(1)}`] = ''; button.textContent = t(label); button.setAttribute('aria-label', `${t(label)}: ${name(item)}`); button.disabled = disabled; button.onclick = action; actions.append(button); }
        body.append(row);
      }
      $('#shortcut-empty').hidden = body.children.length > 0;
    }
    $('#shortcut-search').oninput = render; $('#shortcut-filter').onchange = render;
    $('[data-shortcut-reset-all]').onclick = () => { for (const id of Object.keys(data)) delete data[id]; changed(); render(); };
    $('#shortcut-capture').addEventListener('keydown', event => {
      if (!editing) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const value = model.capture(event);
      if (value) { candidate = value; $('#shortcut-capture').value = format(value); $('#shortcut-capture-error').textContent = ''; }
      else if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) { candidate = ''; $('#shortcut-capture').value = ''; $('#shortcut-capture-error').textContent = t('Diese Taste kann nicht erfasst werden.'); }
    });
    const accept = append => {
      if (!editing || !candidate) return;
      const value = append ? [...new Set([...model.keys(editing, effective(), platform), candidate])].join(' | ') : candidate;
      try { model.validate(catalog, { [editing.id]: value }, platform); }
      catch (failure) { if (!/Überlappende/.test(failure.message)) { $('#shortcut-capture-error').textContent = t(failure.message); return; } }
      data[editing.id] = value; changed(); render(); close();
    };
    $('[data-shortcut-accept]').onclick = () => accept(false);
    $('[data-shortcut-add]').onclick = () => accept(true);
    $('[data-shortcut-cancel]').onclick = close;
    $('#shortcut-dialog').addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('blur', close);
    return {
      setState(message, values) { close(); catalog = message.shortcutCatalog || catalog; platform = message.platform || platform; base = message.shortcutBase || base; data = values.shortcuts ||= {}; render(); },
      validate() { model.validate(catalog, effective(), platform); }, render, close
    };
  };
})(globalThis);
