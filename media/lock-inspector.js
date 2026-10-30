(() => {
  const host = window.acquireVsCodeApi();
  let english = false, busy = true, finished = false, rows = [], statusText = '';
  const text = (de, en) => english ? en : de;
  const labels = { title: ['Ordnersperren untersuchen', 'Inspect folder locks'], processes: ['Sperrende Prozesse', 'Locking processes'], details: ['Details anzeigen', 'Show details'], refresh: ['Aktualisieren (F5)', 'Refresh (F5)'], unlock: ['Freigeben', 'Unlock'], delete: ['Löschen…', 'Delete…'], other: ['Weitere Aktionen…', 'Other actions…'], close: ['Schließen', 'Close'] };
  const region = document.querySelector('#processes'), status = document.querySelector('#status');
  const ids = () => [...region.querySelectorAll('[data-process]:checked')].flatMap(input => rows.filter(row => `${row.pid}:${row.started}` === input.dataset.process).map(row => row.id));
  function send(action) {
    if (action === 'close') { host.postMessage({ type: 'locks-close' }); return; }
    if (busy || finished) return;
    if (action === 'refresh') { setBusy(true); host.postMessage({ type: 'locks-refresh' }); }
    else host.postMessage({ type: 'locks-action', action, ids: ['unlock', 'delete', 'other'].includes(action) ? [] : ids() });
  }
  function setBusy(value) {
    busy = value;
    for (const button of document.querySelectorAll('button[data-action]')) if (button.dataset.action !== 'close') button.disabled = busy || finished;
    region.setAttribute('aria-busy', String(busy));
    if (busy) status.textContent = text('Ordnersperren werden untersucht…', 'Inspecting folder locks…');
    else status.textContent = statusText;
  }
  function render() {
    const restoreFocus = region.contains(document.activeElement) || document.activeElement === document.body;
    const selected = new Set([...region.querySelectorAll('[data-process]:checked')].map(input => input.dataset.process));
    region.replaceChildren();
    const groups = new Map();
    for (const row of rows) { const key = `${row.pid}:${row.started}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    for (const [key, entries] of groups) {
      const row = entries[0], block = document.createElement('section'); block.className = 'process';
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.dataset.process = key; input.checked = selected.has(key); label.append(input, document.createTextNode(row.name));
      const detail = document.createElement('p'); detail.className = 'detail';
      let started = row.started;
      try { started = new Date(Number((BigInt(row.started) - 621355968000000000n) / 10000n)).toLocaleString(english ? 'en' : 'de'); } catch { /* The original identity remains visible for unknown formats. */ }
      detail.textContent = `PID ${row.pid} · ${text('Gestartet', 'Started')}: ${started}\n${row.executable}\n${text('Kommandozeile', 'Command line')}: ${row.commandLine || text('Nicht verfügbar', 'Unavailable')}`;
      const list = document.createElement('ul'); list.className = 'files';
      for (const entry of entries) { const item = document.createElement('li'), kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = entry.kind === 'handle' ? text('Offene Datei', 'Open file') : entry.kind === 'image' ? text('Programmdatei', 'Executable image') : text('Geladenes Modul', 'Loaded module'); item.append(kind, document.createTextNode(` · ${entry.file}`)); list.append(item); }
      block.append(label, detail, list);
      block.addEventListener('contextmenu', event => { event.preventDefault(); if (busy) return; if (!input.checked) { for (const other of region.querySelectorAll('input')) other.checked = false; input.checked = true; } input.focus(); send('context'); });
      region.append(block);
    }
    if (restoreFocus) region.focus();
  }
  document.addEventListener('click', event => { const button = event.target.closest('button[data-action]'); if (button) send(button.dataset.action); });
  document.querySelector('#details').addEventListener('change', event => document.body.classList.toggle('details', event.target.checked));
  document.addEventListener('keydown', event => {
    if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && !event.ctrlKey && !event.altKey && !event.metaKey && region.contains(document.activeElement)) {
      event.preventDefault(); event.stopPropagation();
      const block = document.activeElement.closest('.process') || region.querySelector('.process');
      block?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return;
    }
    if (event.key === 'F5' && !event.ctrlKey && !event.altKey && !event.shiftKey || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); send(event.key === 'F5' ? 'refresh' : 'close'); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && region.contains(document.activeElement) && !window.getSelection()?.toString()) { event.preventDefault(); event.stopPropagation(); send('copy-info'); }
  });
  window.addEventListener('message', event => {
    const data = event.data; if (!data || typeof data.type !== 'string') return;
    if (data.type === 'locks-init' || data.type === 'locks-state') {
      english = Boolean(data.english); document.documentElement.lang = english ? 'en' : 'de';
      for (const node of document.querySelectorAll('[data-label]')) node.textContent = labels[node.dataset.label][english ? 1 : 0];
      region.setAttribute('aria-label', labels.processes[english ? 1 : 0]); document.querySelector('#target').textContent = data.path;
    }
    if (data.type === 'locks-state') {
      rows = data.rows; finished = Boolean(data.finished); render();
      const count = new Set(rows.map(row => row.pid)).size;
      status.textContent = finished ? text('Ordneraktion abgeschlossen.', 'Folder operation completed.') : text(`${count} Prozesse gefunden.`, `${count} processes found.`);
      if (data.inaccessible) status.textContent += text(` ${data.inaccessible} Prozesse konnten nicht vollständig untersucht werden. Das Ergebnis ist unvollständig.`, ` ${data.inaccessible} processes could not be fully inspected. Results are incomplete.`);
      else if (!rows.length && !finished) status.textContent = text('Keine offenen Dateien oder geladenen Module in den untersuchten Prozessen gefunden.', 'No open files or loaded modules found in the inspected processes.');
      statusText = status.textContent;
      setBusy(false);
    }
    if (data.type === 'locks-busy') { setBusy(Boolean(data.busy)); if (busy) { document.querySelector('#error').hidden = true; } }
    if (data.type === 'locks-error' || data.type === 'locks-notice') { const node = document.querySelector(data.type === 'locks-error' ? '#error' : '#notice'); node.textContent = data.error || data.message; node.hidden = false; if (!rows.length) statusText = text('Untersuchung nicht abgeschlossen.', 'Inspection did not complete.'); setBusy(false); }
  });
  setBusy(true); host.postMessage({ type: 'locks-ready' });
})();
