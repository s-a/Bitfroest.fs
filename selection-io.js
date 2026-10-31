'use strict';
const limit = 16 * 1024 * 1024;
function decode(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('windows-1252').decode(buffer); }
}
function createSelectionIO(vscode, t = value => value, active = () => true, resolvePaths = async paths => paths) {
  let busy = false;
  return async (action, text, pathRanges = []) => {
    if (!['copy', 'save', 'load'].includes(action) || action !== 'load' && (typeof text !== 'string' || Buffer.byteLength(text, 'utf16le') > limit)) throw new Error(t('Ungültige Auswahlübertragung.'));
    let end = 0;
    if (!Array.isArray(pathRanges) || pathRanges.some(range => {
      if (action !== 'copy' || !Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.length) || range.length < 1 || range.start < end || range.start + range.length > text.length) return true;
      end = range.start + range.length; return false;
    })) throw new Error(t('Ungültige Auswahlübertragung.'));
    if (busy) throw new Error(t('Eine Auswahlübertragung läuft bereits.'));
    busy = true;
    try {
      if (action === 'copy') {
        if (!active()) return { ok: true, cancelled: true };
        if (pathRanges.length) {
          const originals = pathRanges.map(range => text.slice(range.start, range.start + range.length));
          let resolved;
          try { resolved = await resolvePaths(originals); } catch { resolved = originals; }
          let copied = '', offset = 0;
          for (const [index, range] of pathRanges.entries()) {
            const replacement = Array.isArray(resolved) && typeof resolved[index] === 'string' && !/[\r\n\t\0]/.test(resolved[index]) ? resolved[index] : originals[index];
            copied += text.slice(offset, range.start) + replacement; offset = range.start + range.length;
          }
          text = copied + text.slice(offset);
        }
        if (!active()) return { ok: true, cancelled: true };
        await vscode.env.clipboard.writeText(text); return { ok: true };
      }
      if (action === 'save') {
        const uri = await vscode.window.showSaveDialog({ title: t('Auswahl in Datei speichern'), filters: { [t('Textdateien')]: ['txt'] } });
        if (!uri || !active()) return { ok: true, cancelled: true };
        await vscode.workspace.fs.writeFile(uri, Buffer.from('\ufeff' + text, 'utf16le'));
        return { ok: true };
      }
      const uris = await vscode.window.showOpenDialog({ title: t('Auswahl aus Datei laden'), canSelectMany: false, canSelectFiles: true, canSelectFolders: false });
      if (!uris?.length || !active()) return { ok: true, cancelled: true };
      if ((await vscode.workspace.fs.stat(uris[0])).size > limit) throw new Error(t('Die Auswahldatei überschreitet 16 MiB.'));
      const bytes = await vscode.workspace.fs.readFile(uris[0]);
      if (bytes.length > limit) throw new Error(t('Die Auswahldatei überschreitet 16 MiB.'));
      return active() ? { ok: true, text: decode(bytes) } : { ok: true, cancelled: true };
    } finally { busy = false; }
  };
}
module.exports = { createSelectionIO };
