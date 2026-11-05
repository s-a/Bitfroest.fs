/* global document */
function archiveSnapshot(action, root = document) {
  const state = root.defaultView.CommanderHost.getState(), pane = state.panes[state.active], other = state.panes[1 - state.active];
  const activeDirectory = pane.tabs[pane.tab], otherDirectory = other.tabs[other.tab], rows = state.folders[activeDirectory] || [];
  const selected = pane.selected.map(id => rows.find(row => row.id === id)?.fsSource || '');
  if (action === 'leave-archive') {
    const location = state.archiveLocations?.[activeDirectory];
    return { realFilesystem: state.realFilesystem, activeDirectory, archive: location?.archive, parent: location?.parent,
      parentSelected: pane.selected.length === 1 && pane.selected[0] === '\u0000parent' && pane.cursor === '\u0000parent',
      controlReady: Boolean(root.activeElement?.closest('.pane.active .list')) && !root.querySelector('dialog[open]') };
  }
  if (action === 'show-unpacked-folder') {
    const field = root.querySelector('.pane.active .path-input');
    return { realFilesystem: state.realFilesystem, activeDirectory, input: field?.value,
      controlReady: Boolean(field && root.activeElement === field && !root.querySelector('dialog[open]')) };
  }
  if (action === 'open-archive') {
    const row = rows.find(item => item.id === pane.selected[0]);
    return { realFilesystem: state.realFilesystem, activeDirectory, otherDirectory, selected, entryType: row?.type,
      entryName: row?.name, dialog: root.querySelector('dialog[open]') ? 'dialog' : 'file-list',
      controlReady: Boolean(root.activeElement?.closest('.pane.active .list')) };
  }
  const modal = root.querySelector('dialog[open]#modal'), control = modal?.querySelector('#modal-confirm');
  return { activeDirectory, otherDirectory, selected, dialog: modal?.querySelector('#modal-title')?.textContent,
    input: modal?.querySelector('#value')?.value, controlReady: Boolean(control && !control.disabled && !control.hidden),
    paths: modal?.querySelector('#zip-paths')?.checked,
    ...(action === 'pack' ? { recursive: modal?.querySelector('#zip-recursive')?.checked, move: modal?.querySelector('#zip-move')?.checked,
      encryption: modal?.querySelector('#zip-encryption')?.value } : {}),
    ...(action === 'unpack' ? { overwrite: modal?.querySelector('#zip-overwrite')?.checked, separate: modal?.querySelector('#zip-separate')?.checked,
      filter: modal?.querySelector('#zip-filter')?.value } : {}) };
}

function installArchiveCompletion(root = document) {
  const host = root.defaultView;
  host.__showcaseArchiveCompletion?.dispose();
  const events = [];
  const listener = event => {
    const data = event.data;
    if (['filesystem-result', 'filesystem-progress'].includes(data?.type) && typeof data.operationId === 'string' && /^zip-write-\d+-\d+$/.test(data.operationId)) events.push(data);
  };
  host.addEventListener('message', listener);
  host.__showcaseArchiveCompletion = { events, dispose() { host.removeEventListener('message', listener); delete host.__showcaseArchiveCompletion; } };
}

function inspectArchiveProgress(action, fixture, root = document) {
  const events = root.defaultView.__showcaseArchiveCompletion?.events;
  if (!events) return { error: 'Archive completion observer is unavailable.' };
  if (!['pack', 'unpack'].includes(action)) return { error: 'Invalid archive action.' };
  const ids = [...new Set(events.map(event => event.operationId))];
  if (ids.length > 1) return { error: 'Ambiguous archive operation identities.' };
  const failure = events.find(event => event.type === 'filesystem-result' && (event.ok === false || event.cancelled || event.archiveCommitted || event.operationOutcome?.cancelled || event.operationOutcome?.errors?.length));
  if (failure) return { error: String(failure.error || failure.notice || 'Archive operation failed or was cancelled.') };
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  const match = events.find(event => event.type === 'filesystem-progress' && (action === 'pack'
    ? event.progress?.phase === 'preparing' && same(event.progress.currentPath, fixture.source)
    : event.progress?.phase === 'copying' && event.progress.currentPath === 'Project-Plan.md'));
  return match ? { operationId: match.operationId } : {};
}

function inspectArchiveCompletion(action, fixture, root = document) {
  const events = root.defaultView.__showcaseArchiveCompletion?.events;
  if (!events) return { error: 'Archive completion observer is unavailable.' };
  if (!['pack', 'unpack'].includes(action)) return { error: 'Invalid archive action.' };
  if (typeof fixture.operationId !== 'string' || !/^zip-write-\d+-\d+$/.test(fixture.operationId)) return { error: 'Archive operation identity is unavailable.' };
  const relevant = events.filter(event => event.operationId === fixture.operationId);
  for (const event of relevant) if (event.ok === false || event.cancelled || event.archiveCommitted || event.operationOutcome?.cancelled || event.operationOutcome?.errors?.length) return { operationId: fixture.operationId, error: String(event.error || event.notice || 'Archive operation failed or was cancelled.') };
  const success = relevant.some(event => {
    if (event.ok !== true || event.state?.realFilesystem !== true) return false;
    if (action === 'unpack') return true;
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const rows = Object.entries(event.state.folders || {}).find(([name]) => same(name, fixture.right))?.[1];
    return Array.isArray(rows) && rows.some(row => row.name === 'Project-Plan.zip' && same(row.fsSource, fixture.archive));
  });
  const idle = root.querySelector('#status-progress-area')?.classList.contains('is-idle') && root.querySelector('#status-activity')?.hidden &&
    !root.querySelector('#panes')?.inert && !root.querySelector('#functionbar')?.inert;
  const message = root.querySelector('#status-message');
  return { operationId: fixture.operationId, complete: Boolean(success && idle && message?.dataset.outcome === 'success' && message.textContent.trim() === 'File operation completed') };
}

function inspectArchiveOpened(fixture, root = document) {
  const state = root.defaultView.CommanderHost.getState(), pane = state.panes[state.active], directory = pane.tabs[pane.tab];
  const location = state.archiveLocations?.[directory], rows = state.folders?.[directory];
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return { complete: Boolean(state.realFilesystem && same(location?.archive, fixture.archive) && same(location?.parent, fixture.right) &&
    Array.isArray(rows) && rows.some(row => row.name === 'Project-Plan.md' && row.archiveEntry === 'Project-Plan.md' && same(row.archive, fixture.archive))) };
}

function inspectArchiveLeft(fixture, root = document) {
  const state = root.defaultView.CommanderHost.getState(), pane = state.panes[state.active], directory = pane.tabs[pane.tab];
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const rows = state.folders?.[directory];
  return { complete: Boolean(state.realFilesystem && same(directory, fixture.right) && Array.isArray(rows) && rows.some(row => row.name === 'Project-Plan.zip' && same(row.fsSource, fixture.archive))) };
}

function inspectArchiveExtracted(fixture, root = document) {
  const state = root.defaultView.CommanderHost.getState(), pane = state.panes[state.active], directory = pane.tabs[pane.tab];
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const rows = state.folders?.[directory];
  return { complete: Boolean(state.realFilesystem && same(directory, fixture.unpacked) && Array.isArray(rows) && rows.some(row => row.name === 'Project-Plan.md' && same(row.fsSource, fixture.extracted))) };
}

module.exports = { archiveSnapshot, installArchiveCompletion, inspectArchiveCompletion, inspectArchiveOpened, inspectArchiveProgress, inspectArchiveLeft, inspectArchiveExtracted };
