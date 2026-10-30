const headings = {
  'recovery-incomplete': 'Wiederherstellung unvollständig.',
  'cleanup-failed': 'Dateioperation ausgeführt; Aufräumen der Sicherungen fehlgeschlagen.'
};
const nativeMessages = {
  'The source identity or metadata changed.': 'Die Quellidentität oder ihre Metadaten wurden verändert.',
  'Reparse points are not permitted.': 'Reparse-Verknüpfungen sind nicht erlaubt.',
  'The path is outside the allowed roots.': 'Der Pfad liegt außerhalb der erlaubten Root-Verzeichnisse.',
  'Only a case change in the same directory is supported.': 'Nur die Änderung der Groß-/Kleinschreibung im selben Ordner wird unterstützt.'
};
function createOperationError(code, { cause, paths }) {
  const error = new Error(`${headings[code]} ${cause.message} Sicherungen: ${paths.join(', ')}`, { cause });
  error.presentation = { code, paths: [...paths], cause };
  return error;
}
function renderOperationError(error, t) {
  const presentation = error.presentation;
  if (!presentation || !Object.hasOwn(headings, presentation.code)) return t(nativeMessages[error.message] || error.message);
  const cause = presentation.cause;
  const translated = renderOperationError(cause, t);
  const detail = cause.presentation || translated !== cause.message || Object.hasOwn(nativeMessages, cause.message) ? translated : `${t('Ursprüngliche Fehlermeldung:')}\n${cause.message}`;
  return `${t(headings[presentation.code])}\n${detail}\n${t('Sicherungen:')}\n${presentation.paths.join('\n')}`;
}
module.exports = { createOperationError, renderOperationError };
