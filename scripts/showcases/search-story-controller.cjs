const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyViewerObservation } = require('./lister-observation.cjs');

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const validSearchId = value => typeof value === 'string' && /^search-[a-f0-9]{16}-\d{1,15}$/.test(value);
const validListerId = value => typeof value === 'string' && /^lister-(?:[a-f0-9]{16}-)?\d{1,15}$/.test(value);

function createSearchStoryController({ fixture, readSnapshot, ensureIsolation, observe, activate }) {
  if (!fixture || typeof readSnapshot !== 'function' || typeof ensureIsolation !== 'function' || typeof observe !== 'function' || typeof activate !== 'function') throw new TypeError('A search fixture and recorder callbacks are required.');
  let phase = 'start', baseline;
  async function stable(action, before) {
    if (JSON.stringify(await readSnapshot(action)) !== JSON.stringify(before)) throw new Error('Search story state changed.');
  }
  async function execute(action, effect) {
    if (action !== phase) throw new Error('Unexpected search story action.');
    if (await ensureIsolation(action) !== true) throw new Error('The search story requires an isolated single-flight capture.');
    const state = await readSnapshot(action);
    if (!state?.ready) throw new Error('Search story control is unavailable.');
    if (action === 'start') {
      if (state.name !== fixture.query || !same(state.searchIn, fixture.left) || state.archives !== false || state.nameRegex !== false || state.selectedOnly !== false) throw new Error('Search does not match the authorized fixture.');
      await fixture.verify([fixture.file]);
      const observer = await observe('search');
      try {
        await stable(action, state); await activate(action, state, effect);
        const progress = await observer.waitProgress();
        if (progress?.type !== 'search-progress' || !validSearchId(progress.searchId) || !same(progress.path, fixture.left)) throw new Error('Search progress does not identify the fixture root.');
        const result = await observer.waitComplete(progress.searchId);
        if (result?.type !== 'search-complete' || result.searchId !== progress.searchId || result.ok === false || result.cancelled || result.error || result.errors?.length) throw new Error('Search completion does not match the observed progress.');
        await fixture.verify((result.results || []).map(item => item.fsSource));
      } finally { await observer.dispose(); }
      phase = 'view'; return;
    }
    if (action === 'view') {
      await fixture.verify(state.paths);
      if (!same(state.selectedPath, fixture.file)) throw new Error('The selected search result is not the fixture file.');
      const observer = await observe('viewer-open');
      try {
        await stable(action, state); await activate(action, state, effect);
        const observed = await observer.waitOpen();
        const bytes = await fs.readFile(fixture.file);
        const events = observed?.events;
        const opened = Array.isArray(events) ? events.filter(event => event?.type === 'lister-result' && event.ok === true && validListerId(event.requestId) && typeof event.id === 'string' && event.id && event.view?.text === bytes.toString('utf8')) : [];
        if (events?.some(event => event?.type === 'lister-result' && event.ok === false) || opened.length !== 1 || !observed.viewer?.visible || !observed.viewer.focused || !same(observed.viewer.path, fixture.file) || observed.viewer.selection !== '') throw new Error('The fixture file was not visibly opened in the viewer.');
        baseline = observed.viewer;
        await fixture.verify([fixture.file]);
      } finally { await observer.dispose(); }
      phase = 'find'; return;
    }
    if (action === 'find') {
      if (!same(state.viewerPath, fixture.file) || state.query !== fixture.findText || state.optionsChecked !== false) throw new Error('Viewer search does not match the authorized fixture.');
      const observer = await observe('viewer-find');
      try {
        await stable(action, state); await activate(action, state, effect);
        const observed = await observer.waitMatch();
        await verifyViewerObservation({ fixture, bytes: await fs.readFile(fixture.file), before: baseline, after: observed.viewer, events: observed.events, isolated: true });
      } finally { await observer.dispose(); }
      phase = 'done'; return;
    }
    throw new Error('Invalid search story action.');
  }
  return { execute };
}
module.exports = { createSearchStoryController };
