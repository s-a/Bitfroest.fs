const { maskIssueMessage } = require('./operation-report-masking');

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

const reportOperations = new Set(['filesystem-apply', 'filesystem-delete', 'filesystem-navigate', 'filesystem-prepare', 'filesystem-refresh', 'shell-context-menu', 'clipboard-read', 'clipboard-write', 'clipboard-ack', 'clipboard-reset', 'clipboard-status']);

function operationIssueUrl(destination, report, environment) {
  const error = typeof report.error === 'string' && report.error.length <= 16000
    ? maskIssueMessage(report.error).trim().slice(0, 500)
    : '';
  const operation = reportOperations.has(report.operation) ? report.operation : '';
  const codes = new Set();
  for (let failure = report.failure, depth = 0; failure && depth < 4; failure = failure.cause, depth++) {
    if (typeof failure.code === 'string' && /^(?:[A-Z][A-Z0-9_]{1,39}|FileNotFound|FileExists|FileIsADirectory|FileNotADirectory|NoPermissions|Unavailable)$/.test(failure.code)) codes.add(failure.code);
    if (typeof failure.nativeCode === 'string' && /^-?\d{1,10}$/.test(failure.nativeCode)) codes.add(failure.nativeCode);
  }
  const body = [
    '## What happened?', '', '<!-- Describe the steps, expected result and actual result. Review the report before submitting. -->', '',
    '## Diagnostics', '',
    `- Bitfroest.fs: ${environment.extensionVersion}`,
    ...(environment.vscodeVersion ? [`- VS Code: ${environment.vscodeVersion}`] : []),
    `- Platform: ${environment.platform} ${environment.osRelease} (${environment.architecture})`,
    `- Runtime: ${environment.runtimeVersion}`,
    ...(operation ? [`- Operation: ${operation}`] : []),
    ...(codes.size ? [`- Error codes: ${[...codes].join(', ')}`] : []),
    ...(error ? ['', ...error.split(/\r?\n/).map(line => `    ${line}`)] : [])
  ].join('\n');
  const url = new URL(destination);
  url.searchParams.set('title', '[Bug] File operation failed');
  url.searchParams.set('body', body);
  return url.toString();
}

function deletionBlockedByUse(error) {
  for (let failure = error, depth = 0; failure && depth < 8; failure = failure.cause, depth++) {
    if (['EBUSY', 'ERROR_SHARING_VIOLATION', 'ERROR_LOCK_VIOLATION'].includes(failure.code) ||
        /^(?:Error:\s*)*(?:EBUSY:\s*resource busy or locked|(?:sharing|lock) violation|the process cannot access the file because it is being used by another process)\b/i.test(failure.message)) return true;
  }
  return false;
}

module.exports = { createOperationError, renderOperationError, operationIssueUrl, deletionBlockedByUse };
