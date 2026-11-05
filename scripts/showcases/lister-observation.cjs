/* global document */
const fs = require('node:fs/promises');
const path = require('node:path');

function viewerEvidence(root = document) {
  const lister = root.querySelector('.lister'), area = lister?.querySelector('textarea'), rect = area?.getBoundingClientRect();
  const style = area && root.defaultView?.getComputedStyle(area);
  return { path: lister?.querySelector('.lister-heading span')?.textContent,
    visible: Boolean(rect?.width && rect?.height && rect.bottom > 0 && rect.right > 0 && rect.left < root.defaultView.innerWidth && rect.top < root.defaultView.innerHeight && !area.closest('[hidden]') && style?.display !== 'none' && style?.visibility !== 'hidden'),
    focused: Boolean(area && root.activeElement === area), selection: area?.value.slice(area.selectionStart, area.selectionEnd) };
}

async function verifyViewerObservation({ fixture, bytes, before, after, events, isolated }) {
  if (isolated !== true) throw new Error('The viewer observation requires an isolated single-flight capture.');
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  if (!before?.visible || !before.focused || !same(before.path, fixture.file) || before.selection !== '') throw new Error('The viewer baseline is not clear.');
  if (!after?.visible || !after.focused || !same(after.path, fixture.file) || after.selection !== fixture.findText) throw new Error('The viewer result is not visibly selected.');
  await fixture.verify([fixture.file]);
  const actual = await fs.readFile(fixture.file);
  if (!Buffer.isBuffer(bytes) || !actual.equals(bytes)) throw new Error('The fixture file bytes changed.');
  const start = actual.indexOf(Buffer.from(fixture.findText, 'utf8'));
  if (start < 0 || actual.indexOf(Buffer.from(fixture.findText, 'utf8'), start + 1) !== -1) throw new Error('The fixture search text is not unique.');
  if (!Array.isArray(events) || events.some(event => event?.type === 'lister-result' && event.ok === false)) throw new Error('The viewer reported an error.');
  const matches = events.filter(event => event?.type === 'lister-result' && event.ok === true && event.match &&
    typeof event.requestId === 'string' && /^lister-(?:[a-f0-9]{16}-)?\d{1,15}$/.test(event.requestId) &&
    event.match.start === start && event.match.end === start + Buffer.byteLength(fixture.findText, 'utf8'));
  if (matches.length !== 1) throw new Error('The observed viewer matches are missing or ambiguous.');
  return { observedRequestId: matches[0].requestId, path: fixture.file, selection: fixture.findText };
}

module.exports = { viewerEvidence, verifyViewerObservation };
