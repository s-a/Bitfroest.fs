(function (root) {
  'use strict';
  root.BitfroestQuickDiff = { create };
  function create({ host, t, state, currentPath, isArchive, notify, beforeStart, preview, task, decorate = () => {}, reveal = () => {}, copy = () => {} }) {
    const container = document.querySelector('#panes');
    let source = null, mode = 'off', generation = 0, serial = 0, listId = null, repositoryRoot = null, entries = [], selected = -1, context = '', sourceView = null, view = null, editor = null, loading = false;
    const instance = [...crypto.getRandomValues(new Uint8Array(8))].map(v => v.toString(16).padStart(2, '0')).join('');
    const pending = new Map(), activity = new Set(); let readRequest = null;
    let sortColumn = 'status', sortDirection = 'ascending';
    let restoration = null;
    const rowHeight = 32, relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
    function relativeTime(timestamp) {
      const seconds = (timestamp - Date.now()) / 1000, absolute = Math.abs(seconds);
      const [unit, size] = absolute < 60 ? ['second', 1] : absolute < 3600 ? ['minute', 60] : absolute < 86400 ? ['hour', 3600] : absolute < 604800 ? ['day', 86400] : absolute < 2592000 ? ['week', 604800] : absolute < 31536000 ? ['month', 2592000] : ['year', 31536000];
      return relativeFormat.format(Math.round(seconds / size), unit);
    }
    function updateTimes() { sourceView?.querySelectorAll('time').forEach(time => { const text = relativeTime(Date.parse(time.dateTime)); if (time.textContent !== text) time.textContent = text; }); }
    let clock = null;
    const fullPath = entry => root.BitfroestPaths.displayPath(root.BitfroestPaths.joinPath(repositoryRoot || currentPath(state().panes[source]), entry.path), { platform: document.body.dataset.platform });
    function copyPath(slash = false) {
      if (!sourceView?.contains(document.activeElement)) return false;
      const entry = entries[selected]; if (entry) copy(fullPath(entry), slash);
      return true;
    }
    const resize = new ResizeObserver(() => autoSize());
    function autoSize() {
      if (!sourceView?.isConnected || !sourceView.querySelector('[role="grid"]')) return;
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) return;
      const style = getComputedStyle(sourceView.querySelector('.quick-diff-info') || sourceView), header = getComputedStyle(sourceView.querySelector('.quick-diff-header'));
      const font = value => value.font || `${value.fontSize || '13px'} ${value.fontFamily || 'sans-serif'}`;
      const measure = (values, type = style) => { context.font = font(type); return Math.ceil(Math.max(...values.map(value => context.measureText(value).width))) + 12; };
      const status = Math.max(48, measure([t('Status')], header), measure([...sourceView.querySelectorAll('[data-diff-status-cell]')].map(value => value.textContent).concat('')));
      const date = Math.max(56, measure([t('Geändert')], header), measure([relativeFormat.format(-59, 'minute'), relativeFormat.format(-23, 'hour'), relativeFormat.format(-11, 'month'), ...[...sourceView.querySelectorAll('time')].map(time => time.textContent)]));
      sourceView.style.setProperty('--quick-diff-status-width', `${status}px`); sourceView.style.setProperty('--quick-diff-date-width', `${date}px`); sourceView.style.setProperty('--quick-diff-min-width', `${100 + status + date + 32}px`);
    }
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
      listId = null; entries = []; selected = -1; loading = false;
    }
    function message(text) { editor?.dispose(); editor = null; if (!view) return; const p = document.createElement('p'); p.role = 'status'; p.textContent = text; view.replaceChildren(p); }
    function focus() { sourceView?.querySelector('[role="grid"]')?.focus({ preventScroll: true }); }
    function stop(restore = false) {
      if (source === null) return;
      const old = source; generation++; clear(); source = null; mode = 'off'; restoration = null;
      clearInterval(clock); clock = null;
      if (sourceView) resize.unobserve(sourceView); sourceView?.remove(); sourceView = null; view?.remove(); view = null;
      container.querySelectorAll('.pane-metrics').forEach(node => { node.hidden = false; });
      container.querySelectorAll('.has-quick-diff,.quick-diff-source').forEach(node => node.classList.remove('has-quick-diff', 'quick-diff-source'));
      preview.release('quick-diff'); mount();
      if (restore) document.querySelector(`[data-pane="${old}"] .list`)?.focus({ preventScroll: true });
    }
    function mount() {
      container.querySelectorAll('[data-quick-diff-toggle]').forEach(button => {
        const active = Number(button.closest('[data-pane]').dataset.pane) === source ? mode : 'off';
        if (button.dataset.mode !== active) button.innerHTML = root.BitfroestIcons.svg('xray', active === 'repository' ? 'file-diff-fill' : 'file-diff');
        button.dataset.mode = active; button.title = t(labels[active]); button.setAttribute('aria-label', t(labels[active])); button.setAttribute('aria-pressed', String(active !== 'off'));
      });
      if (source === null) return;
      clock ??= setInterval(updateTimes, 30000);
      const section = container.querySelector(`[data-pane="${source}"]`), opposite = container.querySelector(`[data-pane="${1 - source}"]`);
      section.classList.add('quick-diff-source'); opposite.classList.add('has-quick-diff');
      if (!sourceView) { sourceView = document.createElement('div'); sourceView.dataset.quickDiffList = ''; sourceView.dataset.id = `quick-diff-list-${instance}`; resize.observe(sourceView); }
      if (!section.contains(sourceView)) section.insertBefore(sourceView, section.querySelector('.pane-status'));
      if (!view) { view = document.createElement('section'); view.dataset.quickDiff = ''; view.tabIndex = 0; view.setAttribute('aria-label', 'Quick Diff'); }
      if (!opposite.contains(view)) opposite.append(view);
      section.querySelector('.pane-metrics').hidden = true; preview.layout(source);
    }
    function rows() {
      const grid = sourceView.querySelector('[role="grid"]'); if (!grid) return;
      const body = grid.querySelector('.quick-diff-rows');
      const height = rowHeight, start = Math.max(0, Math.floor(grid.scrollTop / height) - 5), count = Math.ceil((grid.clientHeight || 560) / height) + 10;
      body.style.height = `${entries.length * height}px`; body.replaceChildren();
      for (let i = start; i < Math.min(entries.length, start + count); i++) {
        const entry = entries[i], row = document.createElement('div'); row.role = 'row'; row.dataset.diffIndex = String(i); row.id = `${instance}-diff-${i}`;
        row.dataset.diffPath = entry.path;
        row.dataset.diffStatus = entry.gitStatus || entry.status.toLowerCase();
        row.dataset.diffKind = entry.status.toLowerCase();
        row.className = 'quick-diff-row'; row.style.top = `${i * height}px`; row.setAttribute('aria-selected', String(i === selected)); row.setAttribute('aria-rowindex', String(i + 2));
        const name = document.createElement('span'); name.className = 'quick-diff-name'; name.title = fullPath(entry);
        const filename = document.createElement('span'); filename.dataset.diffFilename = ''; filename.textContent = entry.path.split('/').pop();
        const directory = document.createElement('span'); directory.dataset.diffDirectory = ''; directory.role = 'gridcell'; directory.setAttribute('aria-label', entry.name); directory.title = fullPath(entry);
        const separator = Math.max(entry.name.lastIndexOf('/'), entry.name.lastIndexOf('\\'));
        directory.textContent = separator >= 0 ? entry.name.slice(0, separator + 1) : document.body.dataset.platform === 'win32' ? '.\\' : './';
        name.append(filename);
        const status = document.createElement('span'); status.role = 'gridcell'; status.dataset.diffStatusCell = ''; status.textContent = t(entry.status);
        const modified = document.createElement('span'); modified.role = 'gridcell'; modified.dataset.modifiedAt = '';
        if (Number.isFinite(entry.modifiedAt)) {
          const time = document.createElement('time'), date = new Date(entry.modifiedAt); time.dateTime = date.toISOString(); time.textContent = relativeTime(entry.modifiedAt); time.title = date.toLocaleString(); modified.append(time);
        } else { modified.textContent = '—'; modified.title = t('Änderungszeit nicht verfügbar.'); }
        const divider = () => { const dot = document.createElement('span'); dot.className = 'quick-diff-separator'; dot.setAttribute('aria-hidden', 'true'); dot.textContent = '·'; return dot; };
        const info = document.createElement('div'); info.role = 'presentation'; info.className = 'quick-diff-info'; info.append(status, divider(), modified);
        if (!['.\\', './'].includes(directory.textContent)) info.append(divider(), directory);
        row.append(name, info); body.append(row);
      }
      grid.setAttribute('aria-rowcount', String(entries.length + 1));
      if (selected >= 0) grid.setAttribute('aria-activedescendant', `${instance}-diff-${selected}`); else grid.removeAttribute('aria-activedescendant');
      decorate();
    }
    function sortEntries() {
      const chosen = entries[selected]?.path, direction = sortDirection === 'descending' ? -1 : 1;
      const priority = { Modified: 0, Added: 1, Deleted: 2, Conflict: 3 };
      entries.sort((a, b) => {
        if (sortColumn === 'status') return direction * ((priority[a.status] ?? 4) - (priority[b.status] ?? 4)) || (b.modifiedAt ?? -Infinity) - (a.modifiedAt ?? -Infinity) || a.path.localeCompare(b.path);
        if (sortColumn === 'modifiedAt') {
          if (!Number.isFinite(a.modifiedAt)) return Number.isFinite(b.modifiedAt) ? 1 : a.path.localeCompare(b.path);
          if (!Number.isFinite(b.modifiedAt)) return -1;
          return direction * (a.modifiedAt - b.modifiedAt) || a.path.localeCompare(b.path);
        }
        return direction * a.path.split('/').pop().localeCompare(b.path.split('/').pop()) || a.path.localeCompare(b.path);
      });
      selected = chosen ? entries.findIndex(entry => entry.path === chosen) : -1;
      sourceView.querySelectorAll('[data-diff-sort]').forEach(button => {
        button.closest('[role="columnheader"]').setAttribute('aria-sort', button.dataset.diffSort === sortColumn ? sortDirection : 'none');
        button.dataset.secondarySort = String(sortColumn === 'status' && button.dataset.diffSort === 'modifiedAt');
        button.title = sortColumn === 'status' && button.dataset.diffSort === 'modifiedAt' ? t('Innerhalb des Status: neueste Änderungen zuerst.') : button.textContent;
      });
    }
    function renderList() {
      sourceView.replaceChildren();
      const header = document.createElement('div'); header.className = 'quick-diff-header'; header.role = 'row';
      for (const [column, text] of [['name', 'Dateiname'], ['status', 'Status'], ['modifiedAt', 'Geändert']]) {
        const cell = document.createElement('span'); cell.role = 'columnheader';
        const button = document.createElement('button'); button.type = 'button'; button.dataset.diffSort = column; button.textContent = t(text); cell.append(button); header.append(cell);
        button.addEventListener('click', () => { sortDirection = sortColumn === column ? sortDirection === 'descending' ? 'ascending' : 'descending' : column === 'modifiedAt' ? 'descending' : 'ascending'; sortColumn = column; sortEntries(); rows(); });
      }
      const grid = document.createElement('div'); grid.role = 'grid'; grid.tabIndex = 0; grid.setAttribute('aria-label', t(labels[mode])); grid.setAttribute('aria-colcount', '3');
      const body = document.createElement('div'); body.className = 'quick-diff-rows'; grid.append(header, body); sourceView.append(grid); sortEntries();
      grid.addEventListener('scroll', rows); grid.addEventListener('click', event => { const row = event.target.closest('[data-diff-index]'); if (row) choose(Number(row.dataset.diffIndex)); });
      grid.addEventListener('dblclick', event => {
        const row = event.target.closest('[data-diff-index]'), entry = row && entries[Number(row.dataset.diffIndex)];
        if (!entry) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const side = source, root = repositoryRoot, previewState = snapshot(); stop(); reveal({ entry, root, side, previewState });
      });
      grid.addEventListener('keydown', event => {
        if (!event.altKey && (event.ctrlKey || event.metaKey && document.body.dataset.platform === 'darwin') && event.key.toLowerCase() === 'y') {
          event.preventDefault(); event.stopImmediatePropagation(); copyPath(event.shiftKey); return;
        }
        let next = selected;
        if (event.key === 'ArrowDown') next++; else if (event.key === 'ArrowUp') next--; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = entries.length - 1; else if (event.key === 'PageDown') next += 10; else if (event.key === 'PageUp') next -= 10; else return;
        event.preventDefault(); event.stopImmediatePropagation(); choose(Math.max(0, Math.min(entries.length - 1, next))); grid.scrollTop = Math.max(0, selected * rowHeight - grid.clientHeight / 2); rows();
      }); rows(); autoSize();
    }
    function choose(index) {
      if (index < 0 || index >= entries.length) return;
      if (selected === index && readRequest) return;
      selected = index; cancelReads();
      sourceView.querySelectorAll('[data-diff-index]').forEach(row => row.setAttribute('aria-selected', String(Number(row.dataset.diffIndex) === selected)));
      sourceView.querySelector('[role="grid"]').setAttribute('aria-activedescendant', `${instance}-diff-${selected}`); decorate(); message(t('Datei wird geöffnet…'));
      readRequest = send('quick-diff-read', { listId, path: entries[index].path });
    }
    function load() {
      const keep = restoration?.selectedPath || entries[selected]?.path; generation++; clear(); mount(); sourceView.replaceChildren();
      loading = true; message(t('Änderungen werden geladen…'));
      send('quick-diff-list', { directory: currentPath(state().panes[source]), mode, selectedPath: keep });
    }
    function toggle(side) {
      const path = currentPath(state().panes[side]);
      if (isArchive(path)) { notify(t('Quick Diff ist in Archiven nicht verfügbar.'), 'info'); return; }
      if (side === source && mode === 'repository') { stop(true); return; }
      if (side !== source) { stop(); beforeStart(); preview.activate('quick-diff', () => stop()); source = side; mode = 'folder'; sortColumn = 'status'; sortDirection = 'ascending'; }
      else mode = 'repository';
      context = JSON.stringify([state().panes[source].tab, path]); load();
    }
    function sync() {
      mount(); if (source === null) return;
      const next = JSON.stringify([state().panes[source].tab, currentPath(state().panes[source])]);
      if (context !== next) stop();
    }
    function snapshot() {
      return source === null ? null : { source, mode, selectedPath: entries[selected]?.path, sortColumn, sortDirection, scrollTop: sourceView?.querySelector('[role="grid"]')?.scrollTop || 0 };
    }
    function restore(saved) {
      if (!saved || ![0, 1].includes(saved.source) || !['folder', 'repository'].includes(saved.mode)) return;
      stop(); beforeStart(); preview.activate('quick-diff', () => stop());
      source = saved.source; mode = saved.mode; restoration = saved;
      sortColumn = ['name', 'status', 'modifiedAt'].includes(saved.sortColumn) ? saved.sortColumn : 'status';
      sortDirection = saved.sortDirection === 'descending' ? 'descending' : 'ascending';
      context = JSON.stringify([state().panes[source].tab, currentPath(state().panes[source])]); load();
    }
    function receive(event) {
      const data = event.data;
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
        loading = false; listId = data.result.id; repositoryRoot = data.result.root || currentPath(state().panes[source]); entries = data.result.entries; renderList();
        if (entries.length) { const index = entries.findIndex(e => e.path === (restoration?.selectedPath || data.selectedPath)); choose(index < 0 ? 0 : index); } else message(t('Keine Änderungen vorhanden.'));
        if (restoration) { sourceView.querySelector('[role="grid"]').scrollTop = restoration.scrollTop || 0; rows(); restoration = null; }
        focus();
      } else if (request.type === 'quick-diff-read') {
        if (readRequest !== data.requestId) return;
        if (data.result.reason) { message(t('Keine Dateiversion in HEAD vorhanden.')); host?.postMessage({ type: 'quick-diff-rendered', requestId: data.requestId, ok: true }); return; }
        const reference = [data.result.ghost ? `${t('Ghost')} · ${t(data.result.ghost === 'added' ? 'Added' : 'Deleted')}` : '', data.result.commit ? `HEAD ${data.result.commit.slice(0, 8)}` : ''].filter(Boolean).join(' · ');
        view.dataset.ghost = data.result.ghost || '';
        const title = document.createElement('div'); title.className = 'xray-title'; title.textContent = `${data.result.name} · ${reference}`;
        const content = document.createElement('div'); content.className = 'xray-editor'; view.replaceChildren(title, content);
        try { editor = root.BitfroestXrayEditor.createDiff(content, data.result.original, data.result.modified, data.result.name, {
          onStatistics: counts => {
            title.textContent = `${data.result.name} (+${counts.added} · ~${counts.changed} · −${counts.deleted}) · ${reference}`;
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
    const theme = new MutationObserver(() => autoSize()); theme.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('message', receive); window.addEventListener('pagehide', () => { stop(); clearInterval(clock); resize.disconnect(); theme.disconnect(); }, { once: true });
    return { mount, sync, stop, snapshot, restore, copyPath, refresh() { if (source === null) return false; load(); return true; } };
  }
})(globalThis);
