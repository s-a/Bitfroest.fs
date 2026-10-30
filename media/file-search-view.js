(function (root) {
  'use strict';
  root.CommanderFileSearch = { create };
  function create({ host, context, apply, navigate, preview, restoreFocus, t, escape }) {
    const sessions = new Set(), filtering = new Map(), presetWaiters = []; let sequence = 0, generation = 0;
    const instance = [...crypto.getRandomValues(new Uint8Array(8))].map(value => value.toString(16).padStart(2, '0')).join('');
    const defaults = { name: '*', depth: -1, encodings: ['ansi', 'utf-8'], size: 1, sizeUnit: 1, sizeOperator: '=', younger: 1, older: 1, youngerUnit: 'days', olderUnit: 'days', sameName: true, sameSize: true, attributes: {} };
    let lastSettings = null, presets = {};
    const labels = ['Allgemeines', 'Erweitert', 'Laden/Speichern'];
    const send = message => host?.postMessage(message);
    function active() { return [...sessions].find(s => s.dialog.contains(document.activeElement)) || [...sessions].at(-1); }
    function label(text) {
      const i = text.indexOf('&'), translated = t(text.replace('&', ''));
      if (i < 0) return escape(translated);
      const key = text[i + 1], at = translated.toLowerCase().indexOf(key.toLowerCase());
      return at < 0 ? `${escape(translated)} (Alt+${escape(key.toUpperCase())})` : escape(translated.slice(0, at)) + '<u>' + escape(translated[at]) + '</u>' + escape(translated.slice(at + 1));
    }
    function open(separate = false) {
      const source = context(), s = { source, separate, page: 0, history: [], historyIndex: -1, results: [], running: false, cancelled: false, applying: false };
      const dialog = document.createElement('dialog'); s.dialog = dialog;
      dialog.dataset.fileSearch = ''; dialog.className = 'file-search'; dialog.setAttribute('aria-label', t(separate ? 'Dateien suchen (separat)' : 'Dateien suchen'));
      const prefix = `file-search-${++sequence}`;
      const attrs = (name, caption) => { const key = /&(.)/.exec(caption)?.[1]?.toLowerCase(); return `name="${name}" id="${prefix}-${name}" ${key ? `data-access-key="${key}"` : ''}`; };
      const input = (name, caption, type = 'text') => `<label class="search-field" for="${prefix}-${name}"><span>${label(caption)}</span><input ${attrs(name, caption)} type="${type}" autocomplete="off" ${['name', 'searchIn', 'text'].includes(name) ? `list="${prefix}-history-${name}"` : ''}></label>${['name', 'searchIn', 'text'].includes(name) ? `<datalist data-search-history="${name}" id="${prefix}-history-${name}"></datalist>` : ''}`;
      const check = (name, caption, extra = '') => `<label class="search-check"><input ${attrs(name, caption)} type="checkbox" ${extra}><span>${label(caption)}</span></label>`;
      const select = (name, caption, entries) => `<label class="search-field" for="${prefix}-${name}"><span>${label(caption)}</span><select ${attrs(name, caption)}>${entries.map(([value, caption]) => `<option value="${value}">${escape(t(caption))}</option>`).join('')}</select></label>`;
      const units = [['hours', 'Stunde(n)'], ['days', 'Tag(e)'], ['weeks', 'Woche(n)'], ['months', 'Monat(e)'], ['years', 'Jahr(e)']];
      dialog.innerHTML = `<form><header><h2>${escape(t(separate ? 'Dateien suchen (separat)' : 'Dateien suchen'))}</h2><button type="button" data-search-close aria-label="${escape(t('Dialog schließen'))}">×</button></header><div role="tablist">${labels.map((text, i) => `<button type="button" role="tab" data-page="${i}" id="${prefix}-tab-${i}" aria-controls="${prefix}-page-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${escape(t(text))}</button>`).join('')}</div>
        <fieldset data-search-settings><section role="tabpanel" id="${prefix}-page-0" aria-labelledby="${prefix}-tab-0" data-search-page="0">
        ${input('name', 'Such&en nach:')}${input('searchIn', 'Suchen &in:')}<div class="search-inline"><button type="button" data-browse>${t('Verzeichnis wählen')}…</button><button type="button" data-drives data-access-key="l">${label('&Laufwerke')}</button></div>
        <div class="search-grid">${check('nameRegex', 'RegE&x')}${check('selectedOnly', 'Nur in &markierten Verzeichnissen/Dateien suchen')}${check('archives', 'A&rchive durchsuchen')}${select('depth', 'Unter&verzeichnisse durchsuchen:', [[-1, 'Alle Unterverzeichnisse (unbegrenzt)'], [0, 'Nur aktuelles Verzeichnis'], [1, '1 Ebene'], [2, '2 Ebenen'], [3, '3 Ebenen'], [5, '5 Ebenen'], [10, '10 Ebenen'], ['custom', 'Eigene Tiefe festlegen']])}<div data-custom-depth hidden>${input('depthCustom', 'Anzahl der Ebenen', 'number')}</div></div>
        <hr>${check('textEnabled', '&Text suchen:')}${input('text', 'Suchtext')}<div class="search-grid">${check('wholeWords', 'n&ur ganze Wörter')}${check('caseSensitive', 'Groß-/&Kleinschreibung beachten')}${check('textRegex', 'Reg.Ausdruck (RegEx &2)')}${check('hex', '&Hex')}${check('notContaining', '&Finde Dateien, die den Text NICHT enthalten')}${check('encoding-ansi', 'Windows-&Zeichensatz (ANSI)')}${check('encoding-dos', '&DOS-Zeichensatz (ASCII)')}${check('encoding-utf-16le', 'Unicode UTF&16')}${check('encoding-utf-8', 'UTF&8')}${check('office', '&Office-xml (docx, xlsx, odt usw.)+EPUB')}</div>
        </section><section role="tabpanel" id="${prefix}-page-1" aria-labelledby="${prefix}-tab-1" data-search-page="1" hidden>
        ${check('dateEnabled', 'Datum &zwischen:')}<div class="search-grid">${input('dateFrom', 'Von', 'datetime-local')}${input('dateTo', '&und', 'datetime-local')}</div>
        <div class="search-grid">${check('youngerEnabled', 'Nicht &älter als:')}${input('younger', 'Alter höchstens', 'number')}${select('youngerUnit', 'Einheit höchstens', units)}${check('olderEnabled', 'Älter als:')}${input('older', 'Alter mindestens', 'number')}${select('olderUnit', 'Einheit mindestens', units)}</div>
        ${check('sizeEnabled', '&Dateigröße:')}<div class="search-grid">${select('sizeOperator', 'Vergleich', [['=', '='], ['<', '<'], ['>', '>']])}${input('size', 'Größe', 'number')}${select('sizeUnit', 'Einheit', [[1, 'Bytes'], [1024, 'kBytes'], [1048576, 'MBytes'], [1073741824, 'GBytes']])}</div>
        ${check('attributesEnabled', 'A&ttribute:')}<div class="search-grid">${[['archive', 'A&rchiv'], ['readonly', 'Nur &Lesen'], ['hidden', '&Versteckt'], ['system', 'S&ystem'], ['directory', 'V&erzeichnis'], ['compressed', 'Komprimiert'], ['encrypted', 'Verschlüsselt']].map(([key, caption]) => check('attr-' + key, caption, 'data-tristate="any"')).join('')}</div>
        <hr>${check('duplicates', 'Suche nach do&ppelten Dateien')}<div class="search-grid">${check('sameName', 'gleicher Name')}${check('sameSize', 'gleiche Gr&öße')}${check('sameContent', 'gleicher Inhalt')}</div></section>
        <section role="tabpanel" id="${prefix}-page-2" aria-labelledby="${prefix}-tab-2" data-search-page="2" hidden>${select('preset', 'G&espeicherte Suchparameter:', [])}${input('presetName', 'Name der Suchparameter')}<div class="search-inline"><button type="button" data-preset-load data-access-key="l">${label('&Laden')}</button><button type="button" data-preset-save data-access-key="p">${label('S&peichern')}</button><button type="button" data-preset-delete data-access-key="ö">${label('L&öschen')}</button></div></section></fieldset>
        <section data-search-output hidden><div class="search-inline"><strong>${t('Suchergebnisse:')}</strong><button type="button" data-history="-1" aria-label="${t('Vorheriges Suchergebnis')}">&lt;</button><button type="button" data-history="1" aria-label="${t('Nächstes Suchergebnis')}">&gt;</button>${check('inResults', 'F2 Suchen in gefundenen Dateien/Ordnern')}</div><select data-search-results size="8" aria-label="${t('Suchergebnisse:')}"></select><p data-search-detail></p><div class="search-inline">${[['view', '&Anzeigen'], ['edit', 'F4 Bearbeiten'], ['new', '&neue Suche'], ['goto', '&gehe zu'], ['apply', 'an&wenden']].map(([key, caption]) => `<button type="button" data-search-${key} ${/&(.)/.test(caption) ? `data-access-key="${/&(.)/.exec(caption)[1].toLowerCase()}"` : ''}>${label(caption)}</button>`).join('')}</div></section>
        <p data-search-status role="status" tabindex="0"></p><details data-search-errors hidden><summary>${t('Fehler während der Suche')}</summary><pre></pre></details><footer><button type="button" data-search-cancel>${t('Abbrechen')}</button><button type="submit" data-search-start data-access-key="s">${label('&Suche starten')}</button></footer></form>`;
      document.body.append(dialog); sessions.add(s);
      const $ = selector => dialog.querySelector(selector), controls = () => [...$('[data-search-settings]').querySelectorAll('input[name],select[name]')];
      s.$ = $;
      s.pageTo = index => {
        s.page = (index + labels.length) % labels.length;
        dialog.querySelectorAll('[data-search-page]').forEach(el => { el.hidden = Number(el.dataset.searchPage) !== s.page; });
        dialog.querySelectorAll('[data-page]').forEach(el => { const selected = Number(el.dataset.page) === s.page; el.setAttribute('aria-selected', String(selected)); el.tabIndex = selected ? 0 : -1; });
      };
      s.settings = () => {
        const result = {};
        for (const el of controls()) if (!el.name.startsWith('encoding-') && !el.name.startsWith('attr-') && !el.closest('[data-search-rules]') && !['preset', 'presetName', 'depthCustom'].includes(el.name)) result[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        result.encodings = ['ansi', 'dos', 'utf-16le', 'utf-8'].filter(key => $(`[name="encoding-${key}"]`).checked);
        result.attributes = Object.fromEntries([...dialog.querySelectorAll('[data-tristate]')].map(el => [el.name.slice(5), el.dataset.tristate]));
        result.pluginsEnabled = false; result.rules = []; result.sameFields = [];
        result.depth = $('[name=depth]').value === 'custom' ? Number($('[name=depthCustom]').value) : Number(result.depth); result.selected = source.selected;
        if ($('[name=inResults]').checked) result.inResults = s.results.map(row => row.archive ? { archive: row.archive, archiveEntry: row.archiveEntry || row.entry, revision: row.revision, fsSource: row.fsSource } : row.fsSource);
        return result;
      };
      s.fill = settings => {
        for (const el of controls()) {
          if (el.name.startsWith('encoding-')) el.checked = settings.encodings?.includes(el.name.slice(9)) || false;
          else if (el.dataset.tristate) { el.dataset.tristate = settings.attributes?.[el.name.slice(5)] || 'any'; el.indeterminate = el.dataset.tristate === 'any'; el.checked = el.dataset.tristate === 'yes'; }
          else if (!['preset', 'presetName', 'depthCustom'].includes(el.name) && settings[el.name] !== undefined) { if (el.type === 'checkbox') el.checked = Boolean(settings[el.name]); else el.value = Array.isArray(settings[el.name]) ? settings[el.name].join(', ') : settings[el.name]; }
        }
        const depth = Number(settings.depth ?? -1), choice = $('[name=depth]');
        choice.value = [...choice.options].some(option => option.value === String(depth)) ? String(depth) : 'custom';
        $('[name=depthCustom]').value = depth > 0 ? depth : 1;
        updateDepth(); updateContentEnabled();
      };
      s.renderResults = () => {
        $('[data-search-output]').hidden = false;
        const list = $('[data-search-results]'), selected = list.selectedIndex;
        list.replaceChildren(...s.results.map((row, index) => { const option = document.createElement('option'); option.dataset.searchResult = ''; option.value = index; option.textContent = `${row.group !== undefined ? `[${row.group + 1}] ` : ''}${row.fsSource}`; return option; }));
        list.selectedIndex = Math.max(0, Math.min(selected, s.results.length - 1));
        detail();
        for (const key of ['apply', 'view', 'edit', 'goto']) $(`[data-search-${key}]`).disabled = s.running || s.applying || !s.results.length;
      };
      function detail() { const row = s.results[Number($('[data-search-results]').value)]; $('[data-search-detail]').textContent = row ? `${row.name} · ${row.size || 0} B · ${row.date || ''}` : ''; }
      s.setBusy = value => { s.running = value; $('[data-search-start]').disabled = value; $('[data-search-settings]').disabled = value; $('[data-search-cancel]').textContent = t(value ? 'Abbrechen' : 'Schließen'); };
      s.close = () => { if (s.running) { if (!s.cancelled) { s.cancelled = true; send({ type: 'search-cancel', searchId: s.id }); $('[data-search-status]').textContent = t('Suche wird abgebrochen…'); } return; } if (s.applying) return; send({ type: 'search-release', ids: s.history.map(x => x.id) }); dialog.close(); dialog.remove(); sessions.delete(s); restoreFocus(); };
      s.start = () => {
        if (s.running || s.applying) return;
        if (!$('form').reportValidity()) return;
        if (!host) { $('[data-search-status]').textContent = t('Die Dateisuche benötigt den Erweiterungshost.'); return; }
        const settings = s.settings(); s.currentSettings = structuredClone(settings); lastSettings = structuredClone(settings);
        s.id = `search-${instance}-${++sequence}`; s.results = []; s.errors = []; s.cancelled = false; s.setBusy(true); s.renderResults();
        $('[data-search-status]').textContent = t('Suche läuft…'); $('[data-search-errors]').hidden = true;
        send({ type: 'search-start', searchId: s.id, settings });
      };
      dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); s.start(); });
      dialog.addEventListener('cancel', event => { event.preventDefault(); s.close(); });
      dialog.addEventListener('keydown', event => { event.stopPropagation(); s.key(event); });
      function updateContentEnabled() { const enabled = $('[name=textEnabled]').checked; for (const name of ['text', 'wholeWords', 'caseSensitive', 'textRegex', 'hex', 'notContaining', 'office', 'encoding-ansi', 'encoding-dos', 'encoding-utf-16le', 'encoding-utf-8']) $(`[name="${name}"]`).disabled = !enabled; }
      $('[name=depthCustom]').min = '1'; $('[name=depthCustom]').step = '1'; $('[name=depthCustom]').required = true;
      function updateDepth() { const custom = $('[name=depth]').value === 'custom'; $('[data-custom-depth]').hidden = !custom; $('[name=depthCustom]').disabled = !custom; }
      dialog.addEventListener('change', event => { updateDepth(); if (event.target.name === 'hex' && event.target.checked) $('[name=textRegex]').checked = false; if (event.target.name === 'textRegex' && event.target.checked) $('[name=hex]').checked = false; updateContentEnabled(); });
      dialog.addEventListener('focusin', () => send({ type: 'inputFocus', value: true, dialog: true, search: true }));
      dialog.addEventListener('click', event => {
        const el = event.target.closest('button,input'); if (!el) return;
        if (el.dataset.page !== undefined) { s.pageTo(Number(el.dataset.page)); return; }
        if (el.dataset.tristate) { const state = ({ any: 'yes', yes: 'no', no: 'any' })[el.dataset.tristate]; el.dataset.tristate = state; el.indeterminate = state === 'any'; el.checked = state === 'yes'; return; }
        if (el.matches('[data-search-close],[data-search-cancel]')) s.close();
        if (el.matches('[data-search-new]') && !s.running) { $('[data-search-output]').hidden = true; $('[name=name]').focus(); }
        if (el.matches('[data-search-apply]') && !el.disabled) { s.applying = true; s.renderResults(); send({ type: 'search-apply', searchId: s.id, state: context().state }); }
        if (el.matches('[data-search-view],[data-search-edit]')) show(el.hasAttribute('data-search-edit'));
        if (el.matches('[data-search-goto]')) go(event.shiftKey);
        if (el.dataset.history) history(Number(el.dataset.history));
        if (el.matches('[data-preset-save]')) { const name = $('[name=presetName]').value.trim(); if (name) send({ type: 'search-preset-save', name, settings: s.settings() }); }
        if (el.matches('[data-preset-delete]')) send({ type: 'search-preset-delete', name: $('[name=preset]').value });
        if (el.matches('[data-preset-load]')) { const value = structuredClone(presets[$('[name=preset]').value]); if (value) { const current = s.settings(); if (value.name === '>') value.name = current.name; if (value.searchIn === '>') value.searchIn = current.searchIn; s.fill(value); s.pageTo(0); $('[name=name]').focus(); } }
        if (el.matches('[data-browse],[data-drives]')) send({ type: el.matches('[data-drives]') ? 'search-drives' : 'search-browse', dialogId: prefix });
      });
      function show(edit) { const row = s.results[Number($('[data-search-results]').value)]; if (row && !s.running) { if (!edit && row.type !== 'folder') { s.suspended = true; dialog.close(); } preview(row, edit); } }
      function go(newTab) { const row = s.results[Number($('[data-search-results]').value)]; if (row && !s.running) send({ type: 'search-navigate', searchId: s.id, path: row.fsSource, newTab: Boolean(newTab), state: context().state }); }
      function history(delta) { const index = s.historyIndex + delta; if (s.running || index < 0 || index >= s.history.length) return; s.historyIndex = index; const item = s.history[index]; s.id = item.id; s.results = item.results; s.currentSettings = item.settings; s.renderResults(); }
      s.key = event => {
        const key = event.key.toLowerCase();
        const handled = () => { event.preventDefault?.(); event.stopPropagation?.(); };
        if (event.isComposing || event.getModifierState?.('AltGraph') || event.ctrlKey && event.altKey) return;
        if (key === 'escape') { handled(); s.close(); return; }
        if (key === 'delete' && event.shiftKey && !event.ctrlKey && !event.altKey && ['name', 'searchIn', 'text'].includes(event.target?.name) && !s.running) { handled(); send({ type: 'search-history-delete', field: event.target.name, value: event.target.value }); return; }
        if (event.ctrlKey && ['tab', 'pagedown', 'pageup'].includes(key)) { handled(); s.pageTo(s.page + (event.shiftKey || key === 'pageup' ? -1 : 1)); $('[data-page="' + s.page + '"]').focus(); return; }
        if (event.target?.matches('[role=tab]') && ['arrowleft', 'arrowright'].includes(key)) { handled(); s.pageTo(s.page + (key === 'arrowleft' ? -1 : 1)); $('[data-page="' + s.page + '"]').focus(); return; }
        if (event.altKey && !event.ctrlKey) {
          if (['arrowleft', 'arrowright'].includes(key)) { handled(); history(key === 'arrowleft' ? -1 : 1); return; }
          const target = [...dialog.querySelectorAll('[data-access-key]')].find(el => el.dataset.accessKey === key && !el.matches(':disabled') && !el.closest('[hidden]'));
          if (target?.name === 'textEnabled') { handled(); target.checked = true; updateContentEnabled(); $('[name=text]').focus(); $('[name=text]').select(); return; }
          if (target) { handled(); if (target.matches('button,input[type=checkbox]')) target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: event.shiftKey })); else { target.focus(); target.select?.(); } }
          return;
        }
        if (!event.ctrlKey && !event.altKey && key === 'f2' && !s.running && s.results.length) { handled(); const el = $('[name=inResults]'); el.checked = !el.checked; return; }
        if (!event.ctrlKey && !event.altKey && ['f3', 'f4'].includes(key)) { handled(); show(key === 'f4'); return; }
        if (event.ctrlKey && key === 'c' && event.target === $('[data-search-results]')) { handled(); send({ type: 'search-copy', searchId: s.id }); return; }
        if (key === 'enter' && !event.ctrlKey && !event.altKey && !event.target?.matches('button')) { handled(); if (event.target === $('[data-search-results]')) go(event.shiftKey); else s.start(); }
      };
      $('[data-search-results]').addEventListener('dblclick', event => go(event.shiftKey));
      $('[data-search-results]').addEventListener('change', detail);
      $('[data-search-status]').addEventListener('click', () => { if (s.running && s.currentPath) send({ type: 'search-skip', searchId: s.id, path: s.currentPath }); });
      s.prefix = prefix; s.fill({ ...defaults, ...lastSettings, searchIn: source.path, selectedOnly: false });
      if (separate && dialog.show) dialog.show(); else dialog.showModal();
      $('[name=name]').focus(); $('[name=name]').select(); send({ type: 'search-presets-load' });
      return s;
    }
    window.addEventListener('message', event => {
      const m = event.data; if (!m?.type?.startsWith('search-')) return;
      if (m.type === 'search-presets') { presets = m.values || {}; for (const waiter of presetWaiters.splice(0)) waiter.resolve(); for (const s of sessions) { const select = s.$('[name=preset]'); select.replaceChildren(...Object.keys(presets).sort().map(name => { const option = document.createElement('option'); option.textContent = name; option.value = name; return option; })); for (const field of ['name', 'searchIn', 'text']) s.$(`[data-search-history="${field}"]`).replaceChildren(...(m.histories?.[field] || []).map(value => { const option = document.createElement('option'); option.value = value; return option; })); } return; }
      if (m.type === 'search-complete' && filtering.has(m.searchId)) { const request = filtering.get(m.searchId); filtering.delete(m.searchId); send({ type: 'search-release', ids: [m.searchId] }); if (m.error) request.reject(new Error(m.error)); else request.resolve(m.results); return; }
      for (const s of sessions) {
        if (m.type === 'search-browsed' && m.dialogId === s.prefix) { if (m.paths?.length) s.$('[name=searchIn]').value = m.paths.join(';'); s.$('[name=searchIn]').focus(); continue; }
        if (m.searchId !== s.id) continue;
        if (m.type === 'search-error') s.$('[data-search-status]').textContent = m.error;
        if (m.type === 'search-progress' && s.running) { s.currentPath = m.path; s.$('[data-search-status]').textContent = `${m.path || ''} · ${m.count || 0}`; }
        if (m.type === 'search-complete' && s.running) {
          s.setBusy(false); s.results = m.results || []; const removed = s.history.splice(s.historyIndex + 1); if (removed.length) send({ type: 'search-release', ids: removed.map(item => item.id) }); s.history.push({ id: s.id, results: s.results, settings: s.currentSettings }); s.historyIndex = s.history.length - 1; s.renderResults();
          s.$('[data-search-status]').textContent = m.error || `${t(m.cancelled ? 'Suche abgebrochen' : 'Suche abgeschlossen')} · ${s.results.length}`;
          s.$('[data-search-errors]').hidden = !m.errors?.length; s.$('[data-search-errors] pre').textContent = (m.errors || []).map(item => `${item.path}: ${item.error}`).join('\n');
        }
        if (m.type === 'search-applied' || m.type === 'search-navigated') {
          s.applying = false; if (!m.ok) { s.$('[data-search-status]').textContent = m.error; s.renderResults(); continue; }
          if (m.type === 'search-applied') apply(m.state, m.results, s.source, s.id, s.currentSettings?.name || '*'); else navigate(m, s.source);
          s.close();
        }
      }
    });
    window.addEventListener('lister-menu-change', () => queueMicrotask(() => {
      if (document.querySelector('[data-main-menu]')?.dataset.lister) return;
      for (const s of sessions) if (s.suspended) { s.suspended = false; if (s.separate && s.dialog.show) s.dialog.show(); else s.dialog.showModal(); s.$('[data-search-results]').focus(); }
    }));
    return { open, get isOpen() { return sessions.size > 0; }, contains: element => [...sessions].some(s => s.dialog.contains(element)), key: key => { const parts = key.split('+'), last = parts.pop(); const names = { escape: 'Escape', tab: 'Tab', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', pageup: 'PageUp', pagedown: 'PageDown' }; active()?.key({ key: names[last] || last, altKey: parts.includes('alt'), ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), target: document.activeElement }); },
      async evaluatePreset(name, rows) {
        if (!host) throw new Error(t('Die Dateisuche benötigt den Erweiterungshost.'));
        const version = generation;
        await new Promise((resolve, reject) => { presetWaiters.push({ resolve, reject }); send({ type: 'search-presets-load' }); });
        if (version !== generation) throw new Error(t('Suche abgebrochen'));
        const preset = presets[name]; if (!preset) throw new Error(t('Gespeicherte Suche nicht gefunden.'));
        const searchId = `search-${instance}-${++sequence}`;
        const results = await new Promise((resolve, reject) => { filtering.set(searchId, { resolve, reject }); send({ type: 'search-start', searchId, settings: { ...preset, pluginsEnabled: false, rules: [], sameFields: [], sameFieldsEnabled: false, name: preset.name === '>' ? '*' : preset.name, searchIn: context().path, inResults: rows.map(row => row.archive ? { archive: row.archive, archiveEntry: row.archiveEntry || row.entry, revision: row.revision, fsSource: row.fsSource } : row.fsSource), selectedOnly: false } }); });
        if (version !== generation) throw new Error(t('Suche abgebrochen'));
        return rows.filter(row => results.some(found => found.fsSource === row.fsSource)).map(row => row.id);
      },
      dispose() { generation++; for (const waiter of presetWaiters.splice(0)) waiter.reject(new Error(t('Suche abgebrochen'))); for (const [id, request] of filtering) { send({ type: 'search-cancel', searchId: id }); request.reject(new Error(t('Suche abgebrochen'))); } filtering.clear(); for (const s of sessions) { send({ type: 'search-cancel', searchId: s.id }); s.running = false; s.applying = false; s.close(); } }
    };
  }
})(typeof globalThis === 'object' ? globalThis : this);
