const path = require('node:path');

const equalPath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

async function validateLockDeleteSnapshot(fixture, snapshot) {
  if (!snapshot || snapshot.controlReady !== true || !equalPath(snapshot.activeDirectory, fixture.folder) ||
      snapshot.dialog !== 'Delete permanently?' || !Array.isArray(snapshot.selected) || snapshot.selected.length !== 1 ||
      !equalPath(snapshot.selected[0], fixture.file) || !Array.isArray(snapshot.dialogFiles) ||
      snapshot.dialogFiles.length !== 1 || snapshot.dialogFiles[0] !== path.basename(fixture.file)) {
    throw new Error('The delete confirmation does not match the locked fixture file.');
  }
  await fixture.assertTarget(snapshot.selected[0]);
}

function failureIndicatesFileUse(failure) {
  for (let item = failure, depth = 0; item && depth < 8; item = item.cause, depth++) {
    if (['EPERM', 'EBUSY', 'EACCES', 'ERROR_SHARING_VIOLATION'].includes(item.code) ||
        /\bEBUSY:\s*resource busy or locked\b|sharing violation|being used by another process|used by another process|zugriff.*andere[nm] prozess/i.test(String(item.message || ''))) return true;
  }
  return false;
}

async function validateLockDeleteFailure(fixture, event, view) {
  const request = event?.diagnostic?.request;
  if (event?.type !== 'filesystem-result' || event.ok !== false || event.cancelled || typeof event.operationId !== 'string' || !event.operationId.startsWith('delete-')) throw new Error('The deletion failure response is invalid.');
  if (request?.type !== 'filesystem-delete' || request.operationId !== event.operationId || !Array.isArray(request.paths) || request.paths.length !== 1 || !equalPath(request.paths[0], fixture.file)) throw new Error('The deletion failure request does not match the fixture.');
  if (!failureIndicatesFileUse(event.diagnostic?.failure)) throw new Error('The deletion failure diagnostic does not identify a file lock.');
  if (typeof event.error !== 'string' || !event.error || view?.dialogTitle !== 'File operation failed' || view.errorVisible !== true || typeof view.errorText !== 'string' || !view.errorText.includes(event.error)) throw new Error('The deletion failure is not visible in the product.');
  await fixture.assertIntact();
}

async function validateLockScan(fixture, state, view) {
  if (state?.type !== 'locks-state' || state.finished || !equalPath(state.path, fixture.folder) ||
      !Array.isArray(state.rows) || !state.rows.length || state.rows.some(row => row.pid !== fixture.pid ||
        !/^\d+$/.test(String(row.started || '')) || !equalPath(row.file, fixture.file) || row.kind !== 'handle') ||
      view?.ready !== true || view.detailsVisible !== true || typeof view.text !== 'string' ||
      !view.text.includes(`PID ${fixture.pid}`) || !view.text.includes(path.basename(fixture.file))) {
    throw new Error('The lock inspector did not show the fixture process and file.');
  }
  await fixture.assertIntact();
}

module.exports = { validateLockDeleteSnapshot, validateLockDeleteFailure, validateLockScan };
