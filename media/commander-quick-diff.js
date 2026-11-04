(function (root) {
  'use strict';
  root.CommanderQuickDiff = { create };
  function create({ host, t, state, currentPath, isArchive, notify, beforeStart, preview, task, icon }) {
    const container = document.querySelector('#panes');
    let source = null, mode = 'off', generation = 0, serial = 0, listId = null, entries = [], selected = -1, context = '', sourceView = null, view = null, editor = null, loading = false;
    const instance = [...crypto.getRandomValues(new Uint8Array(8))].map(v => v.toString(16).padStart(2, '0')).join('');
    const pending = new Map(), activity = new Set(), requestedIcons = new Set(), icons = new Map(); let readRequest = null;
    const labels = { off: 'Quick Diff aus', folder: 'Quick Diff: aktueller Ordner', repository: 'Quick Diff: gesamtes Repository' };
    function send(type, data = {}) {
      const requestId = `quick-diff-${instance}-${++serial}`;
      pending.set(requestId, { type, generation });
      activity.add(requestId);
      host?.postMessage({ type, requestId, generation, ...data }); return requestId;
    }
    function cancelReads() {
      if (readRequest) { host?.postMessage({ type: 'quick-diff-cancel', requestId: readRequest }); readRequest = null; }
      editor?.dispose(); editor = null;
    }
    function clear() {
      cancelReads();
      for (const [requestId] of pending) host?.postMessage({ type: 'quick-diff-cancel', requestId });
      pending.clear();
      if (listId) host?.postMessage({ type: 'quick-diff-release', listId });
      listId = null; entries = []; selected = -1; loading = false; requestedIcons.clear(); icons.clear();
    }
    function message(text) { editor?.dispose(); editor = null; if (!view) return; const p = document.createElement('p'); p.role = 'status'; p.textContent = text; view.replaceChildren(p); }
    function focus() { sourceView?.querySelector('[role="grid"]')?.focus({ preventScroll: true }); }
    function stop(restore = false) {
      if (source === null) return;
      const old = source; generation++; clear(); source = null; mode = 'off';
      sourceView?.remove(); sourceView = null; view?.remove(); view = null;
      container.querySelectorAll('.pane-metrics').forEach(node => { node.hidden = false; });
      container.querySelectorAll('.has-quick-diff,.quick-diff-source').forEach(node => node.classList.remove('has-quick-diff', 'quick-diff-source'));
      preview.release('quick-diff'); mount();
      if (restore) document.querySelector(`[data-pane="${old}"] .list`)?.focus({ preventScroll: true });
    }
    function mount() {
      container.querySelectorAll('[data-quick-diff-toggle]').forEach(button => {
        const active = Number(button.closest('[data-pane]').dataset.pane) === source ? mode : 'off';
        if (button.dataset.mode !== active) button.innerHTML = root.CommanderIcons.svg('xray', active === 'repository' ? 'file-diff-fill' : 'file-diff');
        button.dataset.mode = active; button.title = t(labels[active]); button.setAttribute('aria-label', t(labels[active])); button.setAttribute('aria-pressed', String(active !== 'off'));
      });
      if (source === null) return;
      const section = container.querySelector(`[data-pane="${source}"]`), opposite = container.querySelector(`[data-pane="${1 - source}"]`);
      section.classList.add('quick-diff-source'); opposite.classList.add('has-quick-diff');
      if (!sourceView) { sourceView = document.createElement('div'); sourceView.dataset.quickDiffList = ''; }
      if (!section.contains(sourceView)) section.insertBefore(sourceView, section.querySelector('.pane-status'));
      if (!view) { view = document.createElement('section'); view.dataset.quickDiff = ''; view.tabIndex = 0; view.setAttribute('aria-label', 'Quick Diff'); }
      if (!opposite.contains(view)) opposite.append(view);
      section.querySelector('.pane-metrics').hidden = true; preview.layout(source);
    }
    function rows() {
      const grid = sourceView.querySelector('[role="grid"]'); if (!grid) return;
      const body = grid.querySelector('.quick-diff-rows');
      const height = 28, start = Math.max(0, Math.floor(grid.scrollTop / height) - 5), count = Math.ceil((grid.clientHeight || 560) / height) + 10;
      body.style.height = `${entries.length * height}px`; body.replaceChildren();
      const needed = [];
      for (let i = start; i < Math.min(entries.length, start + count); i++) {
        const entry = entries[i], row = document.createElement('div'); row.role = 'row'; row.dataset.diffIndex = String(i); row.id = `${instance}-diff-${i}`;
        entry.icon = icons.get(entry.path);
        if (!requestedIcons.has(entry.path) && needed.length < 100) { requestedIcons.add(entry.path); needed.push(entry.path); }
        row.className = 'quick-diff-row'; row.style.top = `${i * height}px`; row.setAttribute('aria-selected', String(i === selected)); row.setAttribute('aria-rowindex', String(i + 2));
        const name = document.createElement('span'); name.role = 'gridcell'; name.className = 'quick-diff-name'; name.title = entry.name;
        const glyph = document.createElement('span'); glyph.className = 'file-icon'; glyph.innerHTML = icon(entry); name.append(glyph, document.createTextNode(entry.name));
        const status = document.createElement('span'); status.role = 'gridcell'; status.textContent = t(entry.status); row.append(name, status); body.append(row);
      }
      if (needed.length) host?.postMessage({ type: 'quick-diff-icons', listId, generation, paths: needed.slice(0, 100) });
      grid.setAttribute('aria-rowcount', String(entries.length + 1));
      if (selected >= 0) grid.setAttribute('aria-activedescendant', `${instance}-diff-${selected}`); else grid.removeAttribute('aria-activedescendant');
    }
    function renderList() {
      sourceView.replaceChildren();
      const header = document.createElement('div'); header.className = 'quick-diff-header'; header.role = 'row';
      for (const text of ['Datei', 'Status']) { const cell = document.createElement('span'); cell.role = 'columnheader'; cell.textContent = t(text); header.append(cell); }
      const grid = document.createElement('div'); grid.role = 'grid'; grid.tabIndex = 0; grid.setAttribute('aria-label', t(labels[mode])); grid.setAttribute('aria-colcount', '2');
      const body = document.createElement('div'); body.className = 'quick-diff-rows'; grid.append(body); sourceView.append(header, grid);
      grid.addEventListener('scroll', rows); grid.addEventListener('click', event => { const row = event.target.closest('[data-diff-index]'); if (row) choose(Number(row.dataset.diffIndex)); });
      grid.addEventListener('keydown', event => {
        let next = selected;
        if (event.key === 'ArrowDown') next++; else if (event.key === 'ArrowUp') next--; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = entries.length - 1; else if (event.key === 'PageDown') next += 10; else if (event.key === 'PageUp') next -= 10; else return;
        event.preventDefault(); event.stopImmediatePropagation(); choose(Math.max(0, Math.min(entries.length - 1, next))); grid.scrollTop = Math.max(0, selected * 28 - grid.clientHeight / 2); rows();
      }); rows();
    }
    function choose(index) {
      if (index < 0 || index >= entries.length) return;
      selected = index; cancelReads(); rows(); message(t('Datei wird geöffnet…'));
      readRequest = send('quick-diff-read', { listId, path: entries[index].path });
    }
    function load() {
      const keep = entries[selected]?.path; generation++; clear(); mount(); sourceView.replaceChildren();
      loading = true; message(t('Änderungen werden geladen…'));
      send('quick-diff-list', { directory: currentPath(state().panes[source]), mode, selectedPath: keep });
    }
    function toggle(side) {
      const path = currentPath(state().panes[side]);
      if (isArchive(path)) { notify(t('Quick Diff ist in Archiven nicht verfügbar.'), 'info'); return; }
      if (side === source && mode === 'repository') { stop(true); return; }
      if (side !== source) { stop(); beforeStart(); preview.activate('quick-diff', () => stop()); source = side; mode = 'folder'; }
      else mode = 'repository';
      context = JSON.stringify([state().panes[source].tab, path]); load();
    }
    function sync() {
      mount(); if (source === null) return;
      const next = JSON.stringify([state().panes[source].tab, currentPath(state().panes[source])]);
      if (context !== next) stop();
    }
    function receive(event) {
      const data = event.data;
      if (data?.type === 'quick-diff-icons-result') {
        if (data.listId === listId && data.generation === generation) {
          for (const [name, value] of Object.entries(data.icons || {})) if (value) icons.set(name, value);
          sourceView.querySelectorAll('[data-diff-index]').forEach(row => {
            const entry = entries[Number(row.dataset.diffIndex)]; entry.icon = icons.get(entry.path);
            const glyph = row.querySelector('.file-icon'); if (entry.icon && glyph.querySelector('img')?.src !== entry.icon) glyph.innerHTML = icon(entry);
          });
        }
        return;
      }
      if (data?.type === 'quick-diff-progress' && activity.has(data.requestId)) { task(data.requestId, 'Quick Diff', data.progress); return; }
      if (data?.type === 'quick-diff-finished' && activity.has(data.requestId)) { activity.delete(data.requestId); task(data.requestId, null, null); return; }
      if (data?.type === 'quick-diff-action-error') { notify(data.error, 'error'); return; }
      if (data?.type === 'quick-diff-refresh') { if (source !== null && !loading) load(); return; }
      const request = pending.get(data?.requestId);
      if (!request) return;
      if (data.type !== 'quick-diff-result') return;
      pending.delete(data.requestId);
      if (request.generation !== generation || source === null || data.generation !== generation) return;
      if (!data.ok) { loading = false; message(data.error); if (request.type === 'quick-diff-list') { notify(data.error, 'info'); stop(true); } return; }
      if (request.type === 'quick-diff-list') {
        loading = false; listId = data.result.id; entries = data.result.entries; renderList();
        if (entries.length) { const index = entries.findIndex(e => e.path === data.selectedPath); choose(index < 0 ? 0 : index); } else message(t('Keine Änderungen vorhanden.'));
        focus();
      } else if (request.type === 'quick-diff-read') {
        if (readRequest !== data.requestId) return;
        if (data.result.reason) { message(t('Keine Dateiversion in HEAD vorhanden.')); host?.postMessage({ type: 'quick-diff-rendered', requestId: data.requestId, ok: true }); return; }
        const title = document.createElement('div'); title.className = 'xray-title'; title.textContent = `${data.result.name} · HEAD ${data.result.commit.slice(0, 8)}`;
        const content = document.createElement('div'); content.className = 'xray-editor'; view.replaceChildren(title, content);
        try { editor = root.CommanderXrayEditor.createDiff(content, data.result.original, data.result.modified, data.result.name, {
          onStatistics: counts => {
            title.textContent = `${data.result.name} (+${counts.added} · ~${counts.changed} · −${counts.deleted}) · HEAD ${data.result.commit.slice(0, 8)}`;
            title.title = t('Zeilen: {added} hinzugefügt, {changed} geändert, {deleted} gelöscht.', counts);
            title.dataset.diffSummary = '';
          },
          copyLabel: t('Kopieren'), onCopy: text => host?.postMessage({ type: 'quick-diff-copy', requestId: data.requestId, text }),
          onOpen: () => host?.postMessage({ type: 'quick-diff-open', requestId: data.requestId })
        });
          Promise.resolve(editor.ready).then(() => host?.postMessage({ type: 'quick-diff-rendered', requestId: data.requestId, ok: true }), () => { message(t('Quick Diff konnte nicht geladen werden.')); host?.postMessage({ type: 'quick-diff-rendered', requestId: data.requestId, ok: false }); });
        } catch { message(t('Quick Diff konnte nicht geladen werden.')); host?.postMessage({ type: 'quick-diff-rendered', requestId: data.requestId, ok: false }); }
      }
    }
    container.addEventListener('click', event => { const button = event.target.closest('[data-quick-diff-toggle]'); if (!button) return; event.preventDefault(); event.stopImmediatePropagation(); toggle(Number(button.closest('[data-pane]').dataset.pane)); }, true);
    container.addEventListener('contextmenu', event => { if (!event.target.closest('[data-quick-diff-toggle]')) return; event.preventDefault(); event.stopImmediatePropagation(); stop(true); }, true);
    document.addEventListener('keydown', event => { if (source !== null && event.key === 'Escape' && event.target.closest('[data-quick-diff],[data-quick-diff-list]')) { event.preventDefault(); event.stopImmediatePropagation(); stop(true); } }, true);
    window.addEventListener('message', receive); window.addEventListener('pagehide', () => stop(), { once: true });
    return { mount, sync, stop, refresh() { if (source === null) return false; load(); return true; } };
  }
})(globalThis);
