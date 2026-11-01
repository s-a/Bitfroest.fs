(function (root) {
  'use strict';
  root.CommanderListerView = { create };
  function create({ host, state, t, escape, modal, restore, edit, notify, remember, report = () => {}, task = () => {} }) {
    const core = root.CommanderLister, sessions = [null, null], requests = new Map();
    const menu = document.querySelector('[data-main-menu]'), originalMenu = [...menu.childNodes];
    const labels = { text: '1 Nur Text', binary: '2 Binär', hex: '3 Hexadezimal', html: '5 HTML-Text', unicode: '6 Unicode', utf8: '7 UTF-8' };
    const cpNames = ['ANSI (lokale Codeseite)', 'ASCII/DOS (lokale Codeseite)', 'MacOS', 'Osteuropa', 'Kyrillisch Windows', 'Westeuropa', 'Griechisch', 'Türkisch', 'Hebräisch', 'Arabisch', 'Baltisch', 'Vietnamesisch', 'Chinesisch Festland', 'Chinesisch Taiwan', 'Japanisch', 'Koreanisch', 'Thai', 'DOS-USA', 'DOS-Latin1', 'Kyrillisch KOI8-R'];
    const instance = [...crypto.getRandomValues(new Uint8Array(8))].map(value => value.toString(16).padStart(2, '0')).join('');
    let sequence = 0, menuKind = false, painting = false;
    const active = () => sessions[state().active];
    function request(session, type, message, callback) {
      const requestId = `lister-${instance}-${++sequence}`;
      const statusVersion = report(t(type === 'lister-copy' ? 'Auswahl wird kopiert…' : 'Dateiansicht wird aktualisiert…'), 'info');
      requests.set(requestId, { session, type, callback, statusVersion });
      task(requestId, t('Dateiansicht wird aktualisiert…') + ` · ${t('Hostbestätigung')}`);
      host.postMessage({ type, requestId, ...message });
      return requestId;
    }
    function setStatus(session, message) { session.root.querySelector('[data-lister-status]').textContent = message; }
    function updateSelection(session) {
      if (painting || !session.view) return;
      const area = session.area, map = session.view.map;
      const start = area.selectionStart, end = area.selectionEnd;
      if (start === end) session.selection = { start: map[start], end: map[start] };
      else {
        let first = session.size, last = 0;
        for (let i = start; i < end; i++) { first = Math.min(first, map[i]); last = Math.max(last, session.view.ends?.[i] ?? map[i + 1]); }
        session.selection = { start: first, end: last };
      }
      if (session.dragging) {
        if (session.dragAnchor === null) session.dragAnchor = area.selectionDirection === 'backward' ? session.selection.end : session.selection.start;
        session.selection.start = Math.min(session.selection.start, session.dragAnchor); session.selection.end = Math.max(session.selection.end, session.dragAnchor);
      }
    }
    function paint(session, view) {
      if (session.closed) return;
      session.view = view; session.size = view.size; session.mode = view.mode; session.encoding = view.encoding;
      const area = session.area;
      if (session.pendingCaret) {
        const caret = session.pendingCaret, target = caret.backwards ? view.map[Math.max(0, view.text.length - 1)] : view.ends?.find(value => value > view.offset) ?? view.map[1] ?? view.offset;
        session.selection = caret.anchor === null ? { start: target, end: target } : { start: Math.min(caret.anchor, target), end: Math.max(caret.anchor, target) };
        session.pendingCaret = null; session.revealEnd = caret.backwards;
      }
      painting = true; area.value = view.text; area.scrollTop = 0;
      area.dataset.cursor = String(session.cursor);
      area.classList.toggle('lister-variable', session.variable);
      const selection = session.selection;
      if (selection) {
        const first = view.map.findIndex(position => position >= selection.start);
        const last = view.map.findIndex(position => position >= selection.end);
        if (first >= 0) area.setSelectionRange(first, last < 0 ? view.text.length : last);
        if (session.hit) area.scrollTop = Math.max(0, (view.text.slice(0, Math.max(0, first)).split('\n').length - 3) * 20);
      }
      painting = false;
      if (session.revealEnd) { area.scrollTop = area.scrollHeight; session.revealEnd = false; }
      const links = session.root.querySelector('[data-lister-links]');
      links.replaceChildren(); links.hidden = !view.links?.length;
      for (const link of view.links || []) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = link.label; button.title = link.href;
        button.onclick = () => {
          if (host && session.id) {
            const version = ++session.version, navigation = ++session.navigation; session.searchVersion++; session.searching = false;
            host.postMessage({ type: 'lister-cancel', id: session.id });
            request(session, 'lister-link', { id: session.id, href: link.href }, result => {
            if (navigation !== session.navigation) return;
            if (!result.ok) { setStatus(session, t(result.error)); return; }
            if (result.id) { session.id = result.id; session.file = { ...session.file, fsSource: result.path, name: root.CommanderPaths.baseName(result.path) }; session.root.querySelector('.lister-heading span').textContent = root.CommanderPaths.displayPath(result.path); session.selection = null; session.hit = null; if (version !== session.version) { session.view = result.view; load(session, 0); } else paint(session, result.view); }
          });
          }
          else if (/^https?:\/\//i.test(link.href)) window.open(link.href, '_blank', 'noopener');
        };
        links.append(button);
      }
      const range = session.root.querySelector('[data-lister-position]');
      range.value = session.size ? String(view.offset / session.size * 100000) : '0';
      setStatus(session, `${t(labels[session.mode])} · ${t('Codierung')} ${session.encoding} · ${view.offset.toLocaleString()} / ${session.size.toLocaleString()} ${t('Bytes')} · ${session.size ? (Math.min(1, view.next / session.size) * 100).toFixed(1) : '100.0'} %`);
      updateMenu();
    }
    function load(session, position = session.view?.offset || 0) {
      if (session.closed) return;
      const settings = { position, mode: session.mode, encoding: session.encoding, wrap: session.wrap, width: session.width };
      const version = ++session.version;
      if (!host || !state().realFilesystem) {
        const start = Math.max(0, Math.min(session.bytes.length, Math.floor(position))), bytes = session.bytes.subarray(start, start + 32768);
        const encoding = session.mode === 'unicode' ? 'utf-16le' : session.mode === 'utf8' ? 'utf-8' : session.encoding;
        try {
          const decoded = session.mode === 'hex' ? { text: '', map: [] } : core.decode(bytes, encoding, start);
          paint(session, { ...core.format(bytes, decoded, { ...settings, offset: start }), offset: start, next: start + bytes.length, previous: Math.max(0, start - 32768), size: session.bytes.length, mode: session.mode, encoding });
        } catch (error) { setStatus(session, t(error.message)); }
        return;
      }
      if (!session.id) return;
      request(session, 'lister-read', { id: session.id, settings }, result => {
        if (version !== session.version) return;
        if (result.ok) paint(session, result.view);
        else { session.mode = session.view?.mode || session.mode; session.encoding = session.view?.encoding || session.encoding; setStatus(session, t(result.error)); }
      });
    }
    function close(session = active()) {
      if (!session) return;
      session.closed = true; sessions[session.side] = null;
      if (session.id) { host?.postMessage({ type: 'lister-cancel', id: session.id }); host?.postMessage({ type: 'lister-close', id: session.id }); }
      state().active = session.side; updateMenu(); restore(true);
    }
    function selection(session) {
      return session.selection || { start: session.view?.offset || 0, end: session.view?.offset || 0 };
    }
    function copy(session, hex = false) {
      const range = selection(session);
      if (range.start === range.end) return;
      if (host && session.id) {
        setStatus(session, t('Auswahl wird kopiert…'));
        request(session, 'lister-copy', { id: session.id, settings: { ...range, encoding: session.encoding, mode: session.mode, hex } }, result => setStatus(session, result.ok ? t('Auswahl kopiert.') : t(result.error)));
      } else {
        const bytes = session.bytes.subarray(range.start, range.end);
        const text = hex ? [...bytes].map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ') : core.decode(bytes, session.encoding).text.replace(/\0/g, ' ');
        if (host) host.postMessage({ type: 'lister-demo-copy', text });
        else navigator.clipboard?.writeText(text).catch(error => notify(error.message));
        setStatus(session, t('Auswahl kopiert.'));
      }
    }
    function search(session, direction) {
      if (!session.search?.text) { searchDialog(session); return; }
      if (session.searching) { host?.postMessage({ type: 'lister-cancel', id: session.id }); }
      const backward = direction === undefined ? Boolean(session.search.backward) : direction;
      const lineHeight = parseFloat(getComputedStyle(session.area).lineHeight) || 20;
      const visibleLine = Math.floor(session.area.scrollTop / lineHeight);
      const top = session.view?.lines?.[visibleLine] ?? session.view?.offset ?? 0;
      const settings = { ...session.search, encoding: session.encoding, mode: session.mode, backward, position: session.hit ? backward ? session.hit.start : session.hit.end : top };
      if (!host || !session.id) { setStatus(session, t('Suche ist für reale Dateien verfügbar.')); return; }
      session.searching = true; setStatus(session, t('Suche läuft… Escape: zurück zur Dateiliste.'));
      const version = ++session.searchVersion;
      request(session, 'lister-search', { id: session.id, settings }, result => {
        if (version !== session.searchVersion) return;
        session.searching = false;
        if (!result.ok) { setStatus(session, t(result.error)); return; }
        if (!result.match) { setStatus(session, t('Suchbegriff nicht gefunden.')); return; }
        session.hit = result.match; session.selection = { ...result.match };
        load(session, Math.max(0, result.match.start - 256));
      });
    }
    function searchDialog(session) {
      const saved = session.search || {}, selected = selection(session);
      const checkbox = (name, title) => `<label><input type="checkbox" data-search-option="${name}" ${saved[name] ? 'checked' : ''}> ${escape(t(title))}</label>`;
      const suggestion = session.view && selected.end > selected.start && selected.end - selected.start < 4096 ? session.area.value.slice(session.area.selectionStart, session.area.selectionEnd) : '';
      modal(t('Suchen'), `<div data-lister-search><label for="lister-query">${escape(t('Suchtext'))}</label><input id="lister-query" value="${escape(saved.text || suggestion)}" maxlength="4096">${checkbox('caseSensitive', 'Groß-/Kleinschreibung')}${checkbox('wholeWords', 'Nur ganze Wörter')}${checkbox('hex', 'Hexadezimale Suche')}${checkbox('regex', 'Regulärer Ausdruck (zeilenweise)')}${checkbox('backward', 'Rückwärts suchen')}</div>`, t('Suchen'), () => {
        const options = Object.fromEntries([...document.querySelectorAll('[data-search-option]')].map(input => [input.dataset.searchOption, input.checked]));
        const text = document.querySelector('#lister-query').value;
        if (!text) return false;
        session.search = { text, ...options }; session.hit = null;
        document.querySelector('#modal').close(); session.area.focus(); search(session); return false;
      }, 'LISTER');
      document.querySelector('#lister-query').focus();
      document.querySelector('#modal').addEventListener('close', () => { if (!session.closed) session.area.focus(); }, { once: true });
    }
    function chooseCodepage(session) {
      modal(t('Andere Codeseite'), `<label for="lister-codepage">${escape(t('Nummer oder Name (Nummer)'))}</label><input id="lister-codepage" value="" maxlength="100">`, t('Übernehmen'), () => {
        const input = document.querySelector('#lister-codepage').value.trim(), value = /^(?:(.+)\s+\((\d+)\)|(\d+))$/.exec(input);
        if (!value) return false;
        const encoding = value[2] || value[3];
        if (!Number.isSafeInteger(Number(encoding)) || Number(encoding) > 65535) return false;
        if (value[1]) {
          session.custom = session.custom.filter(item => item.encoding !== encoding).concat({ encoding, label: value[1] });
          host?.postMessage({ type: 'lister-codepage-save', values: session.custom });
        }
        session.encoding = encoding; session.selectedEncoding = encoding; if (['unicode', 'utf8'].includes(session.mode)) session.mode = 'text';
        load(session); return true;
      }, 'LISTER');
      document.querySelector('#lister-codepage').focus();
    }
    function command(session, value) {
      if (!session || session.closed) return;
      if (value.startsWith('mode:')) { session.mode = value.slice(5); load(session); }
      else if (value.startsWith('encoding:')) { session.selectedEncoding = value.slice(9); session.encoding = session.selectedEncoding === 'font' ? session.fontEncoding : session.selectedEncoding; if (['unicode', 'utf8'].includes(session.mode)) session.mode = 'text'; load(session); }
      else if (value.startsWith('charset:')) { session.fontEncoding = value.slice(8); session.selectedEncoding = 'font'; session.encoding = session.fontEncoding; load(session); }
      else if (value === 'copy' || value === 'copy-hex') copy(session, value === 'copy-hex');
      else if (value === 'select-all') { session.selection = { start: 0, end: session.size }; session.preserveSelection = true; painting = true; session.area.select(); painting = false; setStatus(session, `${session.size.toLocaleString()} ${t('Bytes markiert')}`); }
      else if (value === 'find') searchDialog(session);
      else if (value === 'next') search(session);
      else if (value === 'previous') search(session, true);
      else if (value === 'inverse') search(session, !session.search?.backward);
      else if (['first', 'last', 'extend-first', 'extend-last'].includes(value)) {
        const destination = value.endsWith('first') ? 0 : session.size;
        if (value.startsWith('extend-')) { const anchor = selection(session).start; session.selection = { start: Math.min(anchor, destination), end: Math.max(anchor, destination) }; session.preserveSelection = true; }
        session.revealEnd = destination === session.size;
        load(session, destination);
      }
      else if (value === 'cursor') { session.cursor = !session.cursor; session.area.dataset.cursor = String(session.cursor); }
      else if (value === 'wrap') { session.wrap = !session.wrap; load(session); }
      else if (value === 'variable') { session.variable = !session.variable; session.area.classList.toggle('lister-variable', session.variable); }
      else if (value === 'manual') chooseCodepage(session);
      else if (value === 'edit') {
        if (host && session.id) request(session, 'lister-edit', { id: session.id }, result => { if (!result.ok) setStatus(session, t(result.error)); });
        else edit(session.file);
      }
      else if (value === 'escape') close(session);
      else if (value === 'close') close(session);
      else if (value === 'reload') { const side = session.side, file = session.file; close(session); open(side, file); }
    }
    function updateMenu() {
      const session = active(), kind = Boolean(session);
      if (kind === menuKind) return;
      window.dispatchEvent(new Event('lister-menu-change'));
      menuKind = kind;
      if (!kind) { delete menu.dataset.lister; menu.replaceChildren(...originalMenu); }
      else {
        menu.dataset.lister = 'true'; menu.replaceChildren();
        const groups = [
          ['Bearbeiten', [['copy', 'Als Text kopieren'], ['copy-hex', 'Als Hex kopieren'], ['select-all', 'Alles markieren'], ['find', 'Suchen'], ['next', 'Weitersuchen']]],
          ['Optionen', [...core.modes.map(mode => [`mode:${mode}`, labels[mode]]), ['charset:0', 'ANSI-Zeichensatz'], ['charset:1', 'ASCII-Zeichensatz'], ['variable', 'Variable Buchstabenbreite'], ['wrap', 'Zeilenumbruch'], ['cursor', 'Zeige Textcursor']]],
          ['Codierung', [['encoding:font', 'Festgelegt durch aktuelle Schrift'], ...core.codepages.map((page, index) => [`encoding:${page}`, `${t(cpNames[index])} (${page})`]), ['manual', 'Andere Codeseite']]]
        ];
        const popup = document.createElement('div'); popup.id = 'lister-menu-popup'; popup.role = 'menu'; popup.hidden = true;
        const heads = [];
        let opened = -1, items = [];
        const shut = () => { popup.hidden = true; heads.forEach(head => head.setAttribute('aria-expanded', 'false')); };
        const show = index => {
          const current = active(); if (!current) return;
          window.dispatchEvent(new CustomEvent('commander-menu-open', { detail: 'lister' }));
          shut(); opened = index; heads[index].setAttribute('aria-expanded', 'true');
          popup.replaceChildren(); popup.setAttribute('aria-label', t(groups[index][0])); popup.style.left = `${heads[index].offsetLeft}px`;
          const entries = groups[index][1].concat(index === 2 ? current.custom.map(item => [`encoding:${item.encoding}`, `${item.label} (${item.encoding})`]) : []);
          items = entries.map(([action, title]) => {
            const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.textContent = t(title); button.dataset.listerCommand = action;
            const checked = action === `mode:${current.mode}` || action === `encoding:${current.selectedEncoding}` || action === `charset:${current.fontEncoding}` || action === 'cursor' && current.cursor || action === 'wrap' && current.wrap || action === 'variable' && current.variable;
            if (action.startsWith('mode:') || action.startsWith('encoding:') || action.startsWith('charset:') || ['cursor', 'wrap', 'variable'].includes(action)) { button.role = ['mode:', 'encoding:', 'charset:'].some(prefix => action.startsWith(prefix)) ? 'menuitemradio' : 'menuitemcheckbox'; button.setAttribute('aria-checked', String(Boolean(checked))); }
            button.onclick = () => { shut(); command(current, action); if (!document.querySelector('#modal').open) current.area.focus(); };
            window.CommanderMenus.decorate(button, action);
            if (checked) button.append(window.CommanderIcons.element('check', { class: 'menu-check' }));
            popup.append(button); return button;
          });
          popup.hidden = false; window.CommanderMenus.place(popup, { anchor: heads[index] }); items[0]?.focus();
        };
        groups.forEach(([title], index) => {
          const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.textContent = t(title);
          button.addEventListener('mouseenter', () => { if (opened >= 0 && !popup.hidden && opened !== index) show(index); });
          button.setAttribute('aria-haspopup', 'true'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', popup.id);
          button.onclick = () => { if (opened === index && !popup.hidden) shut(); else show(index); }; heads.push(button); menu.append(button);
        });
        menu.append(popup);
        menu.onkeydown = event => {
          event.stopImmediatePropagation(); if (event.key !== 'Tab') event.preventDefault();
          const index = items.indexOf(document.activeElement);
          if (event.key === 'Escape') { shut(); heads[Math.max(0, opened)].focus(); }
          else if (event.key === 'Tab') shut();
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') show((Math.max(0, opened) + (event.key === 'ArrowRight' ? 1 : 2)) % 3);
          else if (popup.hidden && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) show(Math.max(0, heads.indexOf(event.target)));
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') items[(Math.max(0, index) + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
          else if (['Enter', ' '].includes(event.key)) document.activeElement.click();
        };
        menu._listerClose = shut;
      }
      if (!kind) { menu.onkeydown = null; menu._listerClose = null; }
      const commands = { view: ['F3', 'Weitersuchen'], edit: ['F4', 'Bearbeiten'], copy: ['F5', 'Weitersuchen'], move: ['F6', 'Zeige Textcursor'], mkdir: ['F7', 'Suchen'] };
      document.querySelectorAll('#functionbar [data-action]').forEach(button => {
        if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
        button.hidden = kind && !commands[button.dataset.action];
        button.textContent = kind && commands[button.dataset.action] ? commands[button.dataset.action].map(t).join(' ') : button.dataset.originalLabel;
        button.title = button.textContent; button.setAttribute('aria-label', button.textContent);
      });
    }
    function mount() {
      sessions.forEach((session, side) => {
        if (!session) return;
        const section = document.querySelector(`[data-pane="${side}"]`);
        if (!section || section.contains(session.root)) return;
        const label = section.querySelector('.pane-label');
        section.replaceChildren(label, session.root); label.firstElementChild.textContent = 'LISTER'; section.classList.add('has-lister');
      });
      updateMenu();
    }
    function open(side, file) {
      if (sessions[side]) close(sessions[side]);
      remember();
      const element = document.createElement('div'); element.dataset.lister = ''; element.className = 'lister';
      element.innerHTML = `<div class="lister-heading"><span></span><button type="button" data-lister-close aria-label="${escape(t('Zur Dateiliste'))}" title="Escape">${window.CommanderIcons.font('close')}</button></div><div class="lister-content"><textarea readonly wrap="off" spellcheck="false" aria-label="${escape(t('Dateiinhalt'))}" data-cursor="false"></textarea></div><nav data-lister-links class="lister-links" hidden aria-label="${escape(t('Links'))}"></nav><label class="lister-position">${escape(t('Dateiposition'))}<input type="range" min="0" max="100000" value="0" data-lister-position aria-label="${escape(t('Dateiposition'))}"></label><div class="lister-status" data-lister-status role="status"></div>`;
      element.querySelector('.lister-heading span').textContent = root.CommanderPaths.displayPath(file.fsSource || file.name);
      const session = { side, file, root: element, area: element.querySelector('textarea'), mode: 'text', encoding: 'utf-8', selectedEncoding: 'font', fontEncoding: '0', wrap: true, width: 80, version: 0, navigation: 0, searchVersion: 0, cursor: false, variable: false, size: file.size || 0, custom: [] };
      sessions[side] = session;
      element.querySelector('[data-lister-close]').onclick = () => close(session);
      element.querySelector('[data-lister-position]').oninput = event => load(session, Math.floor(session.size * Number(event.target.value) / 100000));
      session.area.addEventListener('mousedown', event => { if (event.button === 0) { session.dragging = true; session.dragAnchor = null; } });
      session.area.addEventListener('mousemove', event => { if (event.buttons & 1) updateSelection(session); });
      session.area.addEventListener('mouseup', () => { updateSelection(session); session.dragging = false; });
      session.area.addEventListener('keyup', event => { if (session.preserveSelection) { session.preserveSelection = false; return; } if ((event.shiftKey || session.cursor) && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) updateSelection(session); });
      session.area.addEventListener('copy', event => { event.preventDefault(); copy(session); });
      session.area.addEventListener('scroll', () => {
        if (session.dragging && session.area.scrollTop + session.area.clientHeight >= session.area.scrollHeight - 2 && session.view?.next < session.size) load(session, session.view.next);
      });
      session.area.addEventListener('wheel', event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        const atEnd = session.area.scrollTop + session.area.clientHeight >= session.area.scrollHeight - 2;
        if (event.deltaY > 0 && atEnd && session.view?.next < session.size) { event.preventDefault(); load(session, session.view.next); }
        else if (event.deltaY < 0 && session.area.scrollTop <= 0 && session.view?.offset) { event.preventDefault(); load(session, session.view.previous); }
      }, { passive: false });
      state().active = side; mount(); session.area.focus();
      setStatus(session, t('Datei wird geöffnet…'));
      if (host && state().realFilesystem) {
        request(session, 'lister-open', { path: file.fsSource, side }, result => {
          if (!result.ok) { setStatus(session, t(result.error)); return; }
          session.id = result.id; session.custom = result.codepages || [];
          if (session.version) { session.size = result.size; session.view = result.view; load(session); }
          else paint(session, result.view);
        });
      } else { session.bytes = new TextEncoder().encode(file.content || ''); Object.assign(session, core.detect(session.bytes)); load(session); }
    }
    document.addEventListener('click', event => { if (!menu.contains(event.target)) menu._listerClose?.(); });
    window.addEventListener('commander-menu-open', event => { if (event.detail !== 'lister') menu._listerClose?.(); });
    window.addEventListener('resize', () => menu._listerClose?.());
    window.addEventListener('blur', () => menu._listerClose?.());
    document.addEventListener('keydown', event => {
      const session = active();
      if (!session || document.querySelector('#modal').open || !event.target.closest('[data-lister]')) return;
      const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      let action;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        command(session, 'escape'); return;
      }
      if (event.target !== session.area && !/^F\d+$/.test(event.key)) return;
      if (modifier && key === 'a') action = 'select-all';
      else if (modifier && key === 'c') action = event.shiftKey ? 'copy-hex' : 'copy';
      else if (modifier && key === 'f' || event.key === 'F7') action = 'find';
      else if (event.key === 'F3' || event.key === 'F5') { event.preventDefault(); event.stopImmediatePropagation(); search(session, event.shiftKey ? true : modifier ? !session.search?.backward : undefined); return; }
      else if (event.key === 'F4') action = 'edit';
      else if (event.key === 'F6') action = 'cursor';
      else if (event.key === 'F2') action = 'reload';
      else if (!modifier && !event.altKey && !event.shiftKey) action = ({ 1: 'mode:text', 2: 'mode:binary', 3: 'mode:hex', 5: 'mode:html', 6: 'mode:unicode', 7: 'mode:utf8', a: 'charset:0', s: 'charset:1', v: 'variable' })[key];
      if (action) { event.preventDefault(); event.stopImmediatePropagation(); command(session, action); return; }
      if (session.cursor && !modifier && !event.altKey && session.view && ['ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
        const backwards = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key);
        const boundary = backwards ? session.area.selectionStart === 0 && session.view.offset > 0 : session.area.selectionEnd === session.area.value.length && session.view.next < session.size;
        if (boundary) {
          event.preventDefault(); event.stopImmediatePropagation();
          const range = selection(session);
          session.pendingCaret = { backwards, anchor: event.shiftKey ? session.area.selectionDirection === 'backward' ? range.end : range.start : null };
          session.preserveSelection = true; load(session, backwards ? session.view.previous : session.view.next); return;
        }
      }
      if (modifier && ['Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const destination = event.key === 'Home' ? 0 : session.size;
        if (event.shiftKey) { const anchor = selection(session).start; session.selection = { start: Math.min(anchor, destination), end: Math.max(anchor, destination) }; session.preserveSelection = true; }
        session.revealEnd = destination === session.size;
        load(session, destination); return;
      }
      if (!session.cursor && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (['Home', 'End'].includes(event.key)) { command(session, event.key === 'Home' ? 'first' : 'last'); return; }
        const backwards = ['ArrowUp', 'PageUp', 'Home'].includes(event.key);
        const step = event.key.startsWith('Arrow') ? 20 : Math.max(100, session.area.clientHeight || 400);
        const top = session.area.scrollTop;
        session.area.scrollTop = Math.max(0, top + (backwards ? -step : step));
        if (backwards && top === 0 && session.view?.offset) load(session, session.view.previous);
        else if (!backwards && top + (session.area.clientHeight || 400) >= session.area.scrollHeight && session.view?.next < session.size) load(session, session.view.next);
      }
      if (/^F\d+$/.test(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    });
    window.addEventListener('message', event => {
      const result = event.data;
      if (result?.type !== 'lister-result') return;
      const item = requests.get(result.requestId); if (!item) return;
      requests.delete(result.requestId);
      task(result.requestId, null);
      if (item.session.closed) { if (['lister-open', 'lister-link'].includes(item.type) && result.id) host?.postMessage({ type: 'lister-close', id: result.id }); return; }
      item.callback(result);
      if (!result.ok) report(result.error || t('Dateiaktion fehlgeschlagen.'), result.cancelled ? 'cancelled' : 'error', item.statusVersion);
      else if (['lister-copy', 'lister-open', 'lister-link', 'lister-read', 'lister-edit', 'lister-search'].includes(item.type)) report(t(item.type === 'lister-copy' ? 'Auswahl kopiert.' : item.type === 'lister-edit' ? 'Datei zum Bearbeiten geöffnet.' : item.type === 'lister-search' ? 'Suchlauf beendet.' : 'Datei angezeigt.'), 'success', item.statusVersion);
    });
    return { open, mount, updateMenu, has: side => Boolean(sessions[side]), focus: () => active()?.area.focus(),
      run(value) { const session = active(); if (!session || document.querySelector('#modal').open) return false; command(session, value.startsWith('lister:') ? value.slice(7) : ({ view: 'next', edit: 'edit', copy: 'next', move: 'cursor', mkdir: 'find', 'select-all': 'select-all', 'clipboard-copy': 'copy', filter: 'find', refresh: 'reload' })[value] || ''); return true; },
      dispose() { for (const id of requests.keys()) task(id, null); sessions.forEach((session, index) => { if (session) { session.closed = true; host?.postMessage({ type: 'lister-close', id: session.id }); sessions[index] = null; } }); updateMenu(); }
    };
  }
})(typeof globalThis === 'object' ? globalThis : this);
