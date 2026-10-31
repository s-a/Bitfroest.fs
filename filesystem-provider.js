const nativeFs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createOperationError } = require('./operation-errors');
const { getFileVersion } = require('./pe-file-version');
const { renameCase } = require('./native-rename');
const { createCopySession, abortError, throwIfAborted } = require('./native-copy');
const { normalizePath } = require('./media/commander-paths');

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const slash = value => normalizePath(value, { platform: process.platform });
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;

function canonical(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('Ein gültiger absoluter Pfad ohne Traversal ist erforderlich.');
  return slash(path.resolve(value));
}

function below(value, directory) {
  const candidate = identity(value), root = identity(directory);
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}
function contentSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs].map(String).join(':');
}

function displayDate(value) {
  const date = new Date(Number(value));
  const two = number => String(number).padStart(2, '0');
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function fileType(name) {
  const extension = path.extname(name).toLowerCase();
  if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(extension)) return 'archive';
  if (['.md', '.markdown'].includes(extension)) return 'markdown';
  if (['.js', '.ts', '.json', '.ps1', '.html', '.css', '.xml', '.svg', '.yml', '.yaml', '.sh', '.py', '.c', '.cpp'].includes(extension)) return 'code';
  return 'text';
}

function components(absolute) {
  const native = path.resolve(absolute), root = path.parse(native).root;
  let current = root;
  const result = [root];
  for (const segment of native.slice(root.length).split(path.sep).filter(Boolean)) { current = path.join(current, segment); result.push(current); }
  return result;
}

function filesystemDigest(state) {
  return hash(JSON.stringify(Object.entries(state.folders || {}).sort(([a], [b]) => a.localeCompare(b)).map(([directory, files]) => [directory, files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size, date: file.date, attributes: file.attributes, fsSource: file.fsSource, fsAppend: file.fsAppend, content: file.content })).sort((a, b) => String(a.name).localeCompare(String(b.name)))])));
}

function createProvider(options = {}) {
  const fs = options.fs || fsPromises;
  const suppliedRoots = options.roots || (process.platform === 'win32' ? ['C:/tmp', 'C:/temp'] : [path.join(os.homedir(), 'tmp'), path.join(os.homedir(), 'temp')]);
  const roots = [...new Set(suppliedRoots.map(canonical))];
  if (!roots.length || roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && below(root, other)))) throw new Error('Mindestens ein eindeutiges, nicht überlappendes Root-Verzeichnis ist erforderlich.');
  const limits = { entries: options.maxEntries ?? Infinity, depth: options.maxDepth ?? Infinity, fileBytes: options.maxFileBytes ?? 262144, totalBytes: options.maxTotalBytes ?? options.maxBytes ?? 4194304 };
  let snapshot = null, busy = false;
  const visitedRoots = new Set();

  function permittedRoots() {
    const extra = typeof options.additionalRoots === 'function' ? options.additionalRoots() : [];
    const values = [...roots, ...visitedRoots];
    for (const value of Array.isArray(extra) ? extra : []) {
      try { values.push(canonical(value)); } catch { /* Invalid configured paths remain unavailable. */ }
    }
    const unique = values.filter((root, index) => values.findIndex(other => identity(other) === identity(root)) === index);
    return unique.sort((left, right) => right.length - left.length);
  }

  function allowed(value) {
    const absolute = canonical(value);
    if (!options.allowNavigationOutsideRoots && !permittedRoots().some(root => below(absolute, root))) throw new Error('Der Pfad liegt außerhalb der erlaubten Root-Verzeichnisse.');
    return absolute;
  }

  function contains(value) {
    try {
      const absolute = allowed(value);
      for (const component of components(absolute)) {
        let stat;
        try { stat = nativeFs.lstatSync(component); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (stat.isSymbolicLink()) return false;
      }
      return true;
    } catch { return false; }
  }

  async function assertComponents(value, missing = false) {
    const absolute = allowed(value);
    for (const component of components(absolute)) {
      let stat;
      try { stat = await fs.lstat(component); } catch (error) { if (missing && error.code === 'ENOENT') return absolute; throw error; }
      if (stat.isSymbolicLink()) throw new Error('Symbolische Verknüpfung oder Reparse-Link ist nicht erlaubt.');
    }
    return absolute;
  }

  async function readSnapshot(settings = {}) {
    const folders = {}, entries = new Map();
    const loadedDirectories = new Set();
    let count = 0;
    async function scan(directory, depth, root = false, recursive = false) {
      throwIfAborted(settings.signal);
      if (depth > limits.depth) throw new Error('Die Tiefengrenze des Dateisystem-Scans wurde erreicht.');
      if (loadedDirectories.has(directory)) {
        if (recursive) for (const row of folders[directory]) {
          const entry = entries.get(identity(row.fsSource));
          if (entry?.metadataError) throw entry.metadataError;
          if (row.type === 'folder') await scan(`${directory}/${row.name}`, depth + 1, false, true);
        }
        return;
      }
      await assertComponents(directory);
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory()) throw new Error('Ein Root- oder Ordnerpfad ist kein Verzeichnis.');
      const existing = entries.get(identity(directory));
      entries.set(identity(directory), { path: directory, type: 'folder', signature: statSignature(stat), root, row: existing?.row });
      const names = (await fs.readdir(directory)).sort();
      loadedDirectories.add(directory);
      folders[directory] = [];
      let directoryEntries;
      for (const name of names) {
        throwIfAborted(settings.signal);
        const absolute = canonical(path.join(directory, name));
        if (!entries.has(identity(absolute)) && ++count > limits.entries) throw new Error('Die Eintragsgrenze des Dateisystem-Scans wurde erreicht.');
        let child, fileVersion;
        try {
          child = await fs.lstat(absolute, { bigint: true });
          if (!child.isSymbolicLink()) await assertComponents(absolute);
          if (child.isFile() && /\.(exe|dll)$/i.test(name)) {
            fileVersion = await getFileVersion(absolute, { fs });
            if (statSignature(await fs.lstat(absolute, { bigint: true })) !== statSignature(child)) throw new Error('Datei während der Bestandsaufnahme geändert.');
          }
        }
        catch (error) {
          if (recursive || !['EPERM', 'EACCES'].includes(error.code)) throw error;
          if (error.path && identity(canonical(error.path)) !== identity(absolute)) throw error;
          directoryEntries ||= await fs.readdir(directory, { withFileTypes: true });
          const listed = directoryEntries.find(entry => entry.name === name);
          if (!listed || !listed.isFile() && !listed.isDirectory() && !listed.isSymbolicLink()) throw error;
          const row = { id: `fs:${identity(absolute)}`, name, type: listed.isSymbolicLink() ? 'link' : listed.isDirectory() ? 'folder' : fileType(name), fsSource: absolute };
          entries.set(identity(absolute), { path: absolute, type: listed.isDirectory() ? 'folder' : 'file', signature: '', metadataError: error, row });
          folders[directory].push(row);
          if (listed.isDirectory()) folders[absolute] ||= [];
          continue;
        }
        if (!child.isFile() && !child.isDirectory() && !child.isSymbolicLink()) throw new Error('Nicht reguläre Dateisystemeinträge sind nicht erlaubt.');
        const row = { id: `fs:${identity(absolute)}`, name, type: child.isSymbolicLink() ? 'link' : child.isDirectory() ? 'folder' : fileType(name), size: child.isDirectory() ? 0 : Number(child.size), date: displayDate(child.mtimeMs), mtimeMs: Number(child.mtimeMs), attributes: `${child.isSymbolicLink() ? 'l' : child.isDirectory() ? 'd' : '-'}${child.isFile() ? 'a' : '-'}${(child.mode & 0o200n) === 0n ? 'r' : '-'}-`, fsSource: absolute };
        for (const [field, timestamp] of [['writedate', child.mtimeMs], ['creationdate', child.birthtimeMs], ['accessdate', child.atimeMs]]) {
          if (timestamp !== undefined && Number.isFinite(Number(timestamp))) row[field] = new Date(Number(timestamp)).toISOString();
        }
        if (fileVersion) row.fileVersion = fileVersion;
        entries.set(identity(absolute), { path: absolute, type: child.isDirectory() ? 'folder' : 'file', signature: statSignature(child), contentSignature: contentSignature(child), row });
        folders[directory].push(row);
        settings.onProgress?.({ phase: settings.phase || 'preparing', filesScanned: count, path: absolute });
        throwIfAborted(settings.signal);
        if (child.isDirectory()) {
          folders[absolute] ||= [];
          if (recursive) await scan(absolute, depth + 1, false, true);
        }
      }
      if (statSignature(await fs.lstat(directory, { bigint: true })) !== statSignature(stat)) throw new Error('Ordner während der Bestandsaufnahme geändert.');
    }
    for (const root of roots) await scan(root, 0, true, settings.recursive === true);
    async function scanAncestors(value, recursive) {
      const directory = allowed(value), root = roots.find(root => below(directory, root));
      if (!root) { await scan(directory, 0, true, recursive); return; }
      let current = root;
      for (const segment of directory.slice(root.length).split('/').filter(Boolean)) {
        current = `${current}/${segment}`;
        await scan(current, 0, false, recursive && current === directory);
      }
      if (directory === root && recursive) await scan(root, 0, true, true);
    }
    for (const directory of settings.directories || []) await scanAncestors(directory, false);
    for (const directory of settings.recursiveDirectories || []) await scanAncestors(directory, true);
    const unloadedFolders = [...entries.values()].filter(entry => entry.type === 'folder' && !loadedDirectories.has(entry.path)).map(entry => entry.path);
    settings.onProgress?.({ phase: settings.phase || 'preparing', filesScanned: count, done: true });
    throwIfAborted(settings.signal);
    return { folders, entries, loadedDirectories: [...loadedDirectories], unloadedFolders };
  }

  function pane(directory) { return { tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false }; }

  async function availableViewDirectories(directories) {
    const available = await Promise.all(directories.map(async directory => {
      try { return (await fs.lstat(directory)).isDirectory() ? directory : null; }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
    }));
    return available.filter(Boolean);
  }

  async function load(settings = {}) {
    const left = allowed(settings.left || roots[0]), right = allowed(settings.right || roots[1] || roots[0]);
    const result = await readSnapshot({ ...settings, directories: [...(settings.directories || []), left, right] });
    if (!Object.hasOwn(result.folders, left) || !Object.hasOwn(result.folders, right)) throw new Error('Der gewählte Ordner wurde nicht vollständig eingelesen.');
    for (const entry of result.entries.values()) if (entry.root) visitedRoots.add(entry.path);
    const state = { version: 1, active: 0, realFilesystem: true, snapshotId: crypto.randomUUID(), panes: [pane(left), pane(right)], folders: result.folders, unloadedFolders: result.unloadedFolders };
    snapshot = { ...result, state: clone(state), digest: filesystemDigest(state) };
    return state;
  }

  function flatten(state) {
    if (!state || state.version !== 1 || state.realFilesystem !== true || !state.folders || typeof state.folders !== 'object') throw new Error('Ungültiger Dateisystemzustand.');
    const entries = new Map(), ids = new Set();
    for (const [directory, rows] of Object.entries(state.folders)) {
      allowed(directory);
      const root = permittedRoots().find(root => below(directory, root));
      if (!snapshot?.entries.has(identity(directory)) && directory.slice(root.length).split('/').filter(Boolean).length > limits.depth) throw new Error('Die Tiefengrenze des Zielzustands wurde erreicht.');
      if (!Array.isArray(rows)) throw new Error('Ungültige Ordnerliste.');
      for (const row of rows) {
        if (!row || typeof row.name !== 'string' || !row.name || row.name === '.' || row.name === '..' || /[\\/\0]/.test(row.name)) throw new Error('Ungültiger Datei- oder Ordnername.');
        if (process.platform === 'win32' && (/[<>:"|?*]/.test(row.name) || [...row.name].some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(row.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(row.name))) throw new Error('Ungültiger Datei- oder Ordnername unter Windows.');
        const absolute = allowed(path.join(directory, row.name)), key = identity(absolute);
        if (entries.has(key) || !row.id || ids.has(row.id)) throw new Error('Doppelte Datei-ID oder mehrfacher Zielpfad.');
        if (entries.size >= limits.entries) throw new Error('Die Eintragsgrenze des Zielzustands wurde erreicht.');
        ids.add(row.id); entries.set(key, { path: absolute, type: row.type === 'folder' ? 'folder' : 'file', row });
      }
    }
    for (const directory of Object.keys(state.folders)) {
      if (!roots.some(root => identity(root) === identity(directory)) && !snapshot?.entries.get(identity(directory))?.root && entries.get(identity(directory))?.type !== 'folder') throw new Error('Ein virtueller Archiv- oder fremder Ordnerpfad ist nicht erlaubt.');
    }
    for (const root of roots) if (!Object.hasOwn(state.folders, root)) throw new Error('Root-Ordner dürfen nicht entfernt werden.');
    for (const item of entries.values()) if (item.type === 'folder' && !Object.hasOwn(state.folders, item.path)) throw new Error('Ein Ordner ist nicht vollständig im Zielzustand enthalten.');
    return entries;
  }

  async function validateEntries(expected, selected, signal) {
    const checked = new Set();
    async function verify(entry) {
      if (checked.has(identity(entry.path))) return;
      checked.add(identity(entry.path));
      throwIfAborted(signal);
      if (entry.metadataError) throw entry.metadataError;
      await assertComponents(entry.path);
      if (statSignature(await fs.lstat(entry.path, { bigint: true })) !== entry.signature) throw new Error('Eintrag vor dem Schreiben extern geändert.');
      if (entry.type === 'file' && entry.hash && hash(await fs.readFile(entry.path)) !== entry.hash) throw new Error('Datei vor dem Schreiben extern geändert.');
      if (entry.type !== 'folder') return;
      const children = [...expected.entries.values()].filter(child => !child.root && identity(slash(path.dirname(child.path))) === identity(entry.path));
      const names = (await fs.readdir(entry.path)).sort();
      if (JSON.stringify(names) !== JSON.stringify(children.map(child => path.basename(child.path)).sort())) throw new Error('Ordner vor dem Schreiben extern geändert.');
      for (const child of children) await verify(child);
    }
    for (const entry of selected) await verify(entry);
  }

  function inheritedPanes(state, desired) {
    state.active = desired.active === 1 ? 1 : 0;
    if (!Array.isArray(desired.panes) || desired.panes.length !== 2) return state;
    state.panes = clone(desired.panes);
    for (const p of state.panes) {
      const activePath = p.tabs[p.tab];
      p.tabs = p.tabs.filter(directory => Object.hasOwn(state.folders, directory));
      if (!p.tabs.length) p.tabs = [roots[0]];
      const retainedIndex = p.tabs.indexOf(activePath);
      p.tab = retainedIndex >= 0 ? retainedIndex : Math.max(0, Math.min(p.tabs.length - 1, p.tab || 0));
      p.selected = []; p.cursor = null;
      if (Array.isArray(p.tabStates)) p.tabStates = undefined;
    }
    return state;
  }

  async function apply(before, after, operation = {}) {
    if (busy) throw new Error('Eine Dateisystemoperation läuft bereits.');
    busy = true;
    let session;
    const request = { ...operation, copySession: () => session ||= (options.createCopySession || createCopySession)() };
    try { return await applyChanges(before, after, request); }
    finally { try { await session?.dispose(); } finally { busy = false; } }
  }

  async function applyChanges(before, after, operation) {
    const baseline = snapshot;
    if (!baseline || before?.snapshotId !== baseline.state.snapshotId || filesystemDigest(before) !== baseline.digest || after?.snapshotId !== before.snapshotId) throw new Error('Der Dateisystem-Snapshot ist veraltet oder wurde verändert.');
    const desired = flatten(after);
    let transfer;
    if (operation.transfer) {
      const request = operation.transfer;
      if (!['copy', 'move'].includes(request.mode) || !Array.isArray(request.ids) || !request.ids.length || ![0, 1].includes(request.sourceSide)) throw new Error('Ungültiger Übertragungsauftrag.');
      const sourcePath = allowed(request.sourcePath);
      const selected = (baseline.folders[sourcePath] || []).filter(file => request.ids.includes(file.id));
      if (selected.length !== request.ids.length) throw new Error('Die Übertragungsauswahl ist nicht mehr gültig.');
      transfer = { ...request, sourcePath, selected: selected.map(row => baseline.entries.get(identity(`${sourcePath}/${row.name}`))) };
    }
    const abortedState = async (completed = [], refresh = true) => {
      const directories = [...new Set([transfer.sourcePath, ...before.panes.flatMap(pane => pane.tabs)])];
      const fresh = inheritedPanes(refresh ? await load({ directories: directories.filter(directory => contains(directory) && nativeFs.existsSync(directory)) }) : clone(baseline.state), before);
      const completedSources = completed.filter(entry => transfer.mode === 'copy' || !nativeFs.existsSync(entry.path));
      fresh.operationOutcome = { cancelled: true, completedIds: completedSources.map(entry => entry.row.id), completedSourcePaths: completedSources.map(entry => entry.path) };
      snapshot.state = clone(fresh); return fresh;
    };
    if (operation.signal?.aborted) {
      if (transfer) return abortedState([], false);
      throw abortError();
    }
    for (const directory of baseline.unloadedFolders) {
      const untouched = desired.get(identity(directory));
      if (!untouched || untouched.row.fsSource !== directory || after.folders[directory]?.length || [...desired.values()].some(item => item.type === 'folder' && item.row.fsSource === directory && identity(item.path) !== identity(directory))) throw new Error('Der Ordner muss vor der Dateioperation vollständig eingelesen und vorbereitet werden.');
    }
    if (filesystemDigest(after) === baseline.digest) {
      const state = { ...clone(after), snapshotId: baseline.state.snapshotId };
      baseline.state = clone(state); return state;
    }
    const caseChanges = process.platform === 'win32' ? [...desired].filter(([key, item]) => {
      const original = baseline.entries.get(key);
      return original && original.path !== item.path && path.basename(original.path) !== path.basename(item.path);
    }).map(([key, item]) => ({ original: baseline.entries.get(key), target: item.path })) : [];
    const staged = new Map();
    for (const [key, item] of desired) {
      const provenance = item.row.fsSource && allowed(item.row.fsSource);
      const source = provenance && baseline.entries.get(identity(provenance));
      if (provenance && (!source?.row || source.type !== item.type)) throw new Error('Die Datei-Quelle gehört nicht zum ursprünglichen Snapshot.');
      if (item.row.fsAppend) {
        const request = item.row.fsAppend;
        const sourceList = request.sources || [request.source];
        if (!Array.isArray(sourceList) || !sourceList.length || sourceList.length > limits.entries || sourceList[0] !== request.source) throw new Error('Die Datei-Quelle gehört nicht zum ursprünglichen Snapshot.');
        const incoming = sourceList.map(value => typeof value === 'string' && baseline.entries.get(identity(allowed(value))));
        const target = typeof request.target === 'string' && baseline.entries.get(identity(allowed(request.target)));
        if (!target?.row || target.type !== 'file' || source !== target || identity(item.path) !== identity(target.path) || incoming.some(entry => !entry?.row || entry.type !== 'file' || entry.signature.split(':').slice(0, 2).join(':') === target.signature.split(':').slice(0, 2).join(':')) || item.row.content !== undefined || item.row.size !== incoming.reduce((sum, entry) => sum + entry.row.size, target.row.size)) throw new Error('Die Datei-Quelle gehört nicht zum ursprünglichen Snapshot.');
        staged.set(key, { ...item, data: null, source: target, appendSource: incoming[0], appendSources: incoming, expectedSize: item.row.size, hash: null });
        continue;
      }
      if (item.type === 'folder') continue;
      if (!source && (item.row.type === 'archive' || fileType(item.row.name) === 'archive')) throw new Error('Neue Archivoperationen sind im Dateisystemmodus nicht verfügbar.');
      if (!source && typeof item.row.content !== 'string') throw new Error('Neue binäre Dateien oder Archivoperationen benötigen eine belegte Datei-Quelle.');
      let data = null;
      if (typeof item.row.content === 'string') {
        if (source) {
          const original = await fs.readFile(source.path);
          if (statSignature(await fs.lstat(source.path, { bigint: true })) !== source.signature || original.includes(0)) throw new Error('Binärdateien dürfen nicht durch Textinhalt ersetzt werden.');
          let originalText;
          try { originalText = new TextDecoder('utf-8', { fatal: true }).decode(original); }
          catch { throw new Error('Binärdateien dürfen nicht durch Textinhalt ersetzt werden.'); }
          if (item.row.content !== originalText) data = Buffer.from(item.row.content, 'utf8');
        } else data = Buffer.from(item.row.content, 'utf8');
      }
      const old = baseline.entries.get(key);
      if (data || !old || old.type !== 'file' || source !== old) staged.set(key, { ...item, data, source, hash: data ? hash(data) : source.hash });
    }
    const removed = [...baseline.entries.values()].filter(item => !item.root && (!desired.has(identity(item.path)) || desired.get(identity(item.path)).type !== item.type || staged.has(identity(item.path))));
    const quarantine = removed.filter(item => !removed.some(other => other !== item && other.type === 'folder' && below(item.path, other.path)));
    try {
      const sources = [...staged.values()].flatMap(item => [item.source, ...(item.appendSources || [])]).filter(Boolean);
      await validateEntries(baseline, [...quarantine, ...sources, ...caseChanges.map(change => change.original), ...(transfer?.selected || [])], operation.signal);
      for (const item of desired.values()) {
        if (!staged.has(identity(item.path)) && !(item.type === 'folder' && !baseline.entries.has(identity(item.path)))) continue;
        await assertComponents(item.path, true);
        if (baseline.entries.has(identity(item.path))) continue;
        try { await fs.lstat(item.path); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('Der Zielpfad ist bereits vorhanden.');
      }
    } catch (error) { if (transfer && error.name === 'AbortError') return abortedState([], false); throw error; }
    const sourcePaths = [...desired.values()].flatMap(item => [item.row.fsSource, ...(item.row.fsAppend ? item.row.fsAppend.sources || [item.row.fsAppend.source] : [])]).filter(Boolean);
    const deferredSources = new Set(quarantine.filter(item => !desired.has(identity(item.path)) && sourcePaths.some(source => below(source, item.path))));
    const newDirectories = [...desired.values()].filter(item => item.type === 'folder' && baseline.entries.get(identity(item.path))?.type !== 'folder').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    const backups = new Map(), moved = [], createdFiles = [], createdDirectories = [], stages = [], renamedCases = [];
    const totalBytes = [...staged.values()].reduce((sum, file) => sum + (file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0), 0);
    let publishedBytes = 0;
    const report = (file, event) => { const bytes = file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0; operation.onProgress?.({ ...event, path: file.path, sourcePath: file.appendSources?.[0]?.path || file.source?.path || file.path, totalBytes, completedBytes: publishedBytes + (event.phase === 'published' ? bytes : Math.min(bytes, event.transferred || 0)), filesCompleted: createdFiles.filter(item => item.completed).length, filesTotal: staged.size }); };
    async function verifyCopiedBytes(file, sourcePath, destination) {
      const original = Buffer.alloc(65536), copied = Buffer.alloc(65536);
      let destinationOffset = 0;
      async function readExact(handle, buffer, length, position) {
        let offset = 0;
        while (offset < length) {
          throwIfAborted(operation.signal);
          const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
          if (!bytesRead) throw new Error('Die Kopierprüfung der Zieldatei ist fehlgeschlagen.');
          offset += bytesRead;
        }
      }
      for (const source of [{ ...file.source, path: sourcePath }, ...(file.appendSources || [])]) {
        await assertComponents(source.path);
        const input = await fs.open(source.path, 'r');
        try {
          if (contentSignature(await input.stat({ bigint: true })) !== source.contentSignature) throw new Error('Datei während der Kopierprüfung extern geändert.');
          for (let offset = 0; offset < source.row.size;) {
            const length = Math.min(original.length, source.row.size - offset);
            await readExact(input, original, length, offset);
            await readExact(destination, copied, length, destinationOffset + offset);
            if (!original.subarray(0, length).equals(copied.subarray(0, length))) throw new Error('Die Kopierprüfung der Zieldatei ist fehlgeschlagen.');
            offset += length;
          }
          if (contentSignature(await input.stat({ bigint: true })) !== source.contentSignature) throw new Error('Datei während der Kopierprüfung extern geändert.');
        } finally { await input.close(); }
        destinationOffset += source.row.size;
      }
      throwIfAborted(operation.signal);
    }
    async function appendToStage(source, stage, file) {
      throwIfAborted(operation.signal);
      await assertComponents(source.path);
      await assertComponents(stage.path);
      if (contentSignature(await fs.lstat(source.path, { bigint: true })) !== source.contentSignature) throw new Error('Datei vor dem Kopieren extern geändert.');
      const input = await fs.open(source.path, 'r');
      const output = await fs.open(stage.path, 'a');
      try {
        const original = await input.stat({ bigint: true }), temporary = await output.stat({ bigint: true });
        if (statSignature(temporary) !== stage.signature || contentSignature(original) !== source.contentSignature || original.dev === temporary.dev && original.ino === temporary.ino) throw new Error('Datei vor dem Kopieren extern geändert.');
        const buffer = Buffer.alloc(65536);
        let position = 0;
        while (position < source.row.size) {
          throwIfAborted(operation.signal);
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, source.row.size - position), position);
          if (!bytesRead) throw new Error('Datei während des Kopierens extern geändert.');
          let written = 0;
          while (written < bytesRead) {
            const count = (await output.write(buffer, written, bytesRead - written)).bytesWritten;
            if (!count) throw new Error('Die Kopierprüfung der Zieldatei ist fehlgeschlagen.');
            written += count;
          }
          position += bytesRead;
          report(file, { phase: 'appending', transferred: Number((await output.stat()).size), total: file.expectedSize, granular: true });
        }
        if (contentSignature(await input.stat({ bigint: true })) !== source.contentSignature || contentSignature(await fs.lstat(source.path, { bigint: true })) !== source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.');
      } finally {
        stage.signature = statSignature(await output.stat({ bigint: true }));
        await Promise.all([input.close(), output.close()]);
      }
    }
    async function changeCase(from, to, original, rollback = false) {
      const stat = await fs.lstat(from, { bigint: true });
      if (`${stat.dev}:${stat.ino}` !== original.signature.split(':').slice(0, 2).join(':') || !rollback && statSignature(stat) !== original.signature) throw new Error('Die Quelle wurde vor der Umbenennung geändert.');
      await (options.renameCase || renameCase)({ roots: permittedRoots(), source: from, target: to, expected: { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } });
    }
    async function removeStage(stage) {
      if (stage.cleaned) return;
      await assertComponents(stage.directory);
      const names = await fs.readdir(stage.directory);
      if (!names.length) { await fs.rmdir(stage.directory); stage.cleaned = true; return; }
      if (!stage.signature || names.length !== 1 || names[0] !== 'content') throw new Error('Sicherungsdatei extern verändert.');
      await assertComponents(stage.path);
      if (statSignature(await fs.lstat(stage.path, { bigint: true })) !== stage.signature || stage.hash && hash(await fs.readFile(stage.path)) !== stage.hash) throw new Error('Sicherungsdatei extern verändert.');
      await fs.unlink(stage.path); await fs.rmdir(stage.directory); stage.cleaned = true;
    }
    async function verifyEntry(item, signal) {
      await validateEntries(baseline, [item], signal);
    }
    async function backupDirectory(target) {
      const root = permittedRoots().find(root => below(target, root));
      if (!backups.has(root)) {
        await assertComponents(root);
        const directory = `${root}/.bitfroest-rollback-${crypto.randomUUID()}`;
        await fs.mkdir(directory); backups.set(root, directory);
      }
      return backups.get(root);
    }
    try {
      for (const item of quarantine.filter(item => !deferredSources.has(item))) {
        throwIfAborted(operation.signal);
        await verifyEntry(item, operation.signal);
        const backup = `${await backupDirectory(item.path)}/${crypto.randomUUID()}`;
        await fs.rename(item.path, backup); moved.push({ path: item.path, backup });
      }
      for (const directory of newDirectories) {
        throwIfAborted(operation.signal);
        await assertComponents(directory.path, true);
        await fs.mkdir(directory.path); createdDirectories.push(directory.path);
      }
      for (const file of staged.values()) {
        throwIfAborted(operation.signal);
        report(file, { phase: 'copying', transferred: 0, total: file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0, granular: process.platform === 'win32' });
        await assertComponents(file.path, true);
        if (file.data) {
          const output = await fs.open(file.path, 'wx');
          createdFiles.push(file);
          try {
            const owned = await output.stat({ bigint: true });
            file.createdIdentity = `${owned.dev}:${owned.ino}`;
            await output.writeFile(file.data);
          } finally {
            try { file.createdSignature = statSignature(await output.stat({ bigint: true })); } finally { await output.close(); }
          }
        } else {
          const movedSource = moved.find(item => below(file.source.path, item.path));
          const sourcePath = movedSource ? movedSource.backup + file.source.path.slice(movedSource.path.length) : file.source.path;
          const root = permittedRoots().find(root => below(file.path, root));
          const directory = `${root}/.bitfroest-copy-${crypto.randomUUID()}`;
          await fs.mkdir(directory);
          const stage = { directory, path: `${directory}/content` }; stages.push(stage);
          await assertComponents(sourcePath);
          const sourceStat = await fs.lstat(sourcePath, { bigint: true });
          const sourceIsQuarantined = Boolean(movedSource);
          if (sourceIsQuarantined
            ? contentSignature(sourceStat) !== file.source.contentSignature
            : statSignature(sourceStat) !== file.source.signature) throw new Error('Datei vor dem Kopieren extern geändert.');
          const copyOptions = { signal: operation.signal, onProgress: event => report(file, { ...event, phase: 'copying' }), expectedSource: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])])) };
          if (options.copyFile) await options.copyFile(sourcePath, stage.path, copyOptions);
          else if (operation.signal && !options.fs) await operation.copySession().copy({ roots: permittedRoots(), source: sourcePath, target: stage.path, expected: copyOptions.expectedSource }, copyOptions);
          else await fs.copyFile(sourcePath, stage.path, nativeFs.constants.COPYFILE_EXCL);
          stage.signature = statSignature(await fs.lstat(stage.path, { bigint: true }));
          for (const source of file.appendSources || []) await appendToStage(source, stage, file);
          const input = await fs.open(stage.path, 'r');
          try {
            const stat = await input.stat({ bigint: true });
            stage.signature = statSignature(stat);
            if (file.hash) stage.hash = hash(await input.readFile());
            throwIfAborted(operation.signal);
            if (Number(stat.size) !== (file.expectedSize ?? file.source.row.size) || file.hash && stage.hash !== file.hash) throw new Error('Die Kopierprüfung der Zieldatei ist fehlgeschlagen.');
            await verifyCopiedBytes(file, sourcePath, input);
            if (contentSignature(await fs.lstat(sourcePath, { bigint: true })) !== file.source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.');
            for (const source of file.appendSources || []) { await assertComponents(source.path); if (contentSignature(await fs.lstat(source.path, { bigint: true })) !== source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.'); }
            await assertComponents(file.path, true);
            if (statSignature(await fs.lstat(stage.path, { bigint: true })) !== stage.signature) throw new Error('Sicherungsdatei extern verändert.');
            await fs.link(stage.path, file.path);
            file.createdIdentity = `${stat.dev}:${stat.ino}`;
            file.createdContentSignature = contentSignature(stat);
            file.createdHash = stage.hash;
            createdFiles.push(file);
            stage.signature = statSignature(await input.stat({ bigint: true }));
            await removeStage(stage);
            file.createdSignature = statSignature(await input.stat({ bigint: true }));
          } finally { await input.close(); }
        }
        const createdStat = await fs.lstat(file.path, { bigint: true });
        if (`${createdStat.dev}:${createdStat.ino}` !== file.createdIdentity || (file.data ? statSignature(createdStat) !== file.createdSignature : contentSignature(createdStat) !== file.createdContentSignature)) throw new Error('Neue Datei extern verändert.');
        file.createdSignature = statSignature(createdStat);
        if (file.hash) file.createdHash = hash(await fs.readFile(file.path));
        if (Number(createdStat.size) !== (file.data ? file.data.length : file.expectedSize ?? file.source.row.size) || file.hash && file.createdHash !== file.hash) throw new Error('Die Kopierprüfung der Zieldatei ist fehlgeschlagen.');
        if (!file.data) {
          const movedSource = moved.find(item => below(file.source.path, item.path));
          const sourcePath = movedSource ? movedSource.backup + file.source.path.slice(movedSource.path.length) : file.source.path;
          if (contentSignature(await fs.lstat(sourcePath, { bigint: true })) !== file.source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.');
        }
        for (const source of file.appendSources || []) { await assertComponents(source.path); if (contentSignature(await fs.lstat(source.path, { bigint: true })) !== source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.'); }
        file.completed = true;
        report(file, { phase: 'published', transferred: 0, total: file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0, granular: process.platform === 'win32' });
        publishedBytes += file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0;
      }
      for (const item of deferredSources) {
        throwIfAborted(operation.signal);
        await verifyEntry(item, operation.signal);
        const backup = `${await backupDirectory(item.path)}/${crypto.randomUUID()}`;
        await fs.rename(item.path, backup); moved.push({ path: item.path, backup });
      }
      for (const change of caseChanges) {
        await changeCase(change.original.path, change.target, change.original);
        change.afterSignature = statSignature(await fs.lstat(change.target, { bigint: true }));
        renamedCases.push(change);
        for (const ancestor of renamedCases) if (ancestor !== change && ancestor.original.type === 'folder' && below(change.target, ancestor.target)) ancestor.afterSignature = statSignature(await fs.lstat(ancestor.target, { bigint: true }));
      }
    } catch (error) {
      if (error.name === 'AbortError' && transfer) {
        const completedFiles = createdFiles.filter(file => file.completed);
        const origins = file => (file.appendSources?.length ? file.appendSources : [file.source]).filter(Boolean).map(entry => entry.path);
        const completedRoots = transfer.selected.filter(entry => {
          const related = [...staged.values()].filter(file => origins(file).some(source => below(source, entry.path)));
          return related.length > 0 && related.every(file => file.completed);
        });
        const retainedPaths = [];
        try {
          for (const file of createdFiles.filter(file => !file.completed).reverse()) {
            await assertComponents(file.path);
            const stat = await fs.lstat(file.path, { bigint: true });
            if (statSignature(stat) !== file.createdSignature) throw new Error('Neue Datei extern verändert.', { cause: error });
            await fs.unlink(file.path);
          }
          for (const stage of stages) await removeStage(stage);
          const isPublished = value => completedFiles.some(file => identity(file.path) === identity(value));
          const isCompletedSource = value => transfer.mode === 'move' && !desired.has(identity(value)) && completedFiles.some(file => origins(file).some(source => below(source, value)));
          for (const item of moved.filter(item => !isPublished(item.path) && !isCompletedSource(item.path)).reverse()) {
            await assertComponents(item.path, true);
            try { await fs.lstat(item.path); throw new Error('Wiederherstellungsziel bereits vorhanden.', { cause: error }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.rename(item.backup, item.path); item.restored = true;
          }
          if (transfer.mode === 'move') {
            const sourceEntries = new Map(completedFiles.flatMap(file => origins(file)).map(source => [identity(source), baseline.entries.get(identity(source))]));
            for (const entry of sourceEntries.values()) {
              if (!entry || desired.has(identity(entry.path)) || moved.some(item => identity(item.path) === identity(entry.path))) continue;
              await verifyEntry(entry);
              const backup = `${await backupDirectory(entry.path)}/${crypto.randomUUID()}`;
              await fs.rename(entry.path, backup); moved.push({ path: entry.path, backup });
            }
          }
          for (const directory of createdDirectories.reverse()) {
            const originalDirectory = desired.get(identity(directory))?.row.fsSource;
            if (completedFiles.some(file => below(file.path, directory)) || originalDirectory && completedRoots.some(entry => entry.type === 'folder' && below(originalDirectory, entry.path))) continue;
            await assertComponents(directory); await fs.rmdir(directory);
          }
          for (const item of moved.filter(item => !item.restored)) await removeBackup(item.backup, item.path);
          for (const directory of backups.values()) await fs.rmdir(directory);
          if (transfer.mode === 'move') {
            const directories = [...baseline.entries.values()].filter(entry => !entry.root && entry.type === 'folder' && !desired.has(identity(entry.path))).sort((a, b) => b.path.length - a.path.length);
            for (const entry of directories) {
              const destination = [...desired.values()].find(item => item.type === 'folder' && item.row.fsSource && identity(item.row.fsSource) === identity(entry.path) && identity(item.path) !== identity(entry.path));
              if (!destination || !nativeFs.existsSync(destination.path) || !nativeFs.existsSync(entry.path) || (await fs.readdir(entry.path)).length) continue;
              await assertComponents(entry.path);
              const stat = await fs.lstat(entry.path, { bigint: true });
              if (`${stat.dev}:${stat.ino}` !== entry.signature.split(':').slice(0, 2).join(':')) throw new Error('Ordner extern verändert.', { cause: error });
              await fs.rmdir(entry.path);
            }
          }
          return await abortedState(completedRoots);
        } catch (cause) {
          retainedPaths.push(...backups.values(), ...stages.filter(stage => !stage.cleaned).map(stage => stage.path));
          snapshot = null; throw createOperationError('recovery-incomplete', { cause, paths: retainedPaths });
        }
      }
      let rollbackFailed = false;
      const retained = [];
      for (const file of createdFiles.reverse()) {
        try {
          await assertComponents(file.path);
          const stat = await fs.lstat(file.path, { bigint: true });
          if ((file.data ? statSignature(stat) !== file.createdSignature : contentSignature(stat) !== file.createdContentSignature) || file.createdHash && hash(await fs.readFile(file.path)) !== file.createdHash) throw new Error('Neue Datei extern verändert.', { cause: error });
          await fs.unlink(file.path);
        } catch { rollbackFailed = true; retained.push(file.path); }
      }
      for (const stage of stages) { try { await removeStage(stage); } catch { rollbackFailed = true; } }
      for (const directory of createdDirectories.reverse()) { try { await assertComponents(directory); await fs.rmdir(directory); } catch { rollbackFailed = true; } }
      for (const item of moved.reverse()) {
        try {
          await assertComponents(item.path, true);
          try { await fs.lstat(item.path); throw new Error('Wiederherstellungsziel bereits vorhanden.', { cause: error }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await fs.rename(item.backup, item.path);
        } catch { rollbackFailed = true; }
      }
      for (const change of renamedCases.reverse()) {
        try {
          if (statSignature(await fs.lstat(change.target, { bigint: true })) !== change.afterSignature) throw new Error('Neue Datei extern verändert.', { cause: error });
          await changeCase(change.target, change.original.path, change.original, true);
          for (const ancestor of renamedCases) if (ancestor !== change && ancestor.original.type === 'folder' && below(change.target, ancestor.target)) ancestor.afterSignature = statSignature(await fs.lstat(ancestor.target, { bigint: true }));
        }
        catch { rollbackFailed = true; retained.push(change.target); }
      }
      snapshot = null;
      if (rollbackFailed) throw createOperationError('recovery-incomplete', { cause: error, paths: [...backups.values(), ...stages.filter(stage => !stage.cleaned).map(stage => stage.path), ...retained] });
      for (const directory of backups.values()) await fs.rmdir(directory);
      throw error;
    }
    async function removeBackup(backupPath, originalPath) {
      await assertComponents(backupPath);
      const original = baseline.entries.get(identity(originalPath));
      const stat = await fs.lstat(backupPath, { bigint: true });
      if (original.type === 'file') {
        if (!stat.isFile() || contentSignature(stat) !== original.contentSignature || original.hash && hash(await fs.readFile(backupPath)) !== original.hash) throw new Error('Sicherungsdatei extern verändert.');
        await fs.unlink(backupPath);
        return;
      }
      if (!stat.isDirectory()) throw new Error('Sicherungsordner extern verändert.');
      const children = [...baseline.entries.values()].filter(child => !child.root && identity(slash(path.dirname(child.path))) === identity(originalPath));
      if (JSON.stringify((await fs.readdir(backupPath)).sort()) !== JSON.stringify(children.map(child => path.basename(child.path)).sort())) throw new Error('Sicherungsordner enthält externe Einträge.');
      for (const child of children) await removeBackup(`${backupPath}/${path.basename(child.path)}`, child.path);
      await fs.rmdir(backupPath);
    }
    try {
      for (const directory of backups.values()) {
        const expected = moved.filter(item => slash(path.dirname(item.backup)) === directory);
        if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(expected.map(item => path.basename(item.backup)).sort())) throw new Error('Sicherungsordner enthält externe Einträge.');
      }
      for (const item of moved) await removeBackup(item.backup, item.path);
      for (const directory of backups.values()) await fs.rmdir(directory);
    } catch (error) {
      snapshot = null;
      throw createOperationError('cleanup-failed', { cause: error, paths: [...backups.values()] });
    }
    const next = inheritedPanes(await load({ directories: await availableViewDirectories([...baseline.loadedDirectories, ...newDirectories.map(item => item.path)].filter(directory => roots.includes(directory) || baseline.entries.get(identity(directory))?.root || desired.get(identity(directory))?.type === 'folder')) }), after);
    snapshot.state = clone(next);
    return next;
  }

  async function measureFolder(before, directory, settings = {}) {
    if (busy) throw new Error('Eine Dateisystemoperation läuft bereits.');
    if (!snapshot || before?.snapshotId !== snapshot.state.snapshotId || filesystemDigest(before) !== snapshot.digest) throw new Error('Der Dateisystem-Snapshot ist veraltet oder wurde verändert.');
    const target = allowed(directory), entry = snapshot.entries.get(identity(target));
    if (!entry || entry.root || entry.type !== 'folder') throw new Error('Ein bekannter Unterordner ist erforderlich.');
    busy = true;
    try {
      let total = 0;
      const pending = [target];
      while (pending.length) {
        throwIfAborted(settings.signal);
        const current = pending.pop();
        await assertComponents(current);
        const beforeStat = await fs.lstat(current, { bigint: true });
        if (!beforeStat.isDirectory()) throw new Error('Der Ordner wurde während der Größenberechnung geändert.');
        for (const name of await fs.readdir(current)) {
          throwIfAborted(settings.signal);
          const child = allowed(path.join(current, name));
          const stat = await fs.lstat(child, { bigint: true });
          if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('Nicht reguläre Dateisystemeinträge sind nicht erlaubt.');
          if (stat.isDirectory()) pending.push(child);
          else {
            total += Number(stat.size);
            if (!Number.isSafeInteger(total)) throw new Error('Die Ordnergröße überschreitet den unterstützten Zahlenbereich.');
          }
        }
        if (statSignature(await fs.lstat(current, { bigint: true })) !== statSignature(beforeStat)) throw new Error('Der Ordner wurde während der Größenberechnung geändert.');
      }
      throwIfAborted(settings.signal);
      return total;
    } finally { busy = false; }
  }

  async function prepare(before, settings = {}) {
    if (busy) throw new Error('Eine Dateisystemoperation läuft bereits.');
    if (!snapshot || before?.snapshotId !== snapshot.state.snapshotId || filesystemDigest(before) !== snapshot.digest) throw new Error('Der Dateisystem-Snapshot ist veraltet oder wurde verändert.');
    const directories = (settings.directories || []).map(allowed);
    const fresh = await load({ directories: [...snapshot.loadedDirectories, ...directories], recursiveDirectories: settings.recursive ? directories : [], signal: settings.signal, onProgress: settings.onProgress });
    const state = inheritedPanes(fresh, before);
    snapshot.state = clone(state);
    return state;
  }
  async function remove(before, request = {}) {
    if (busy) throw new Error('Eine Dateisystemoperation läuft bereits.');
    const baseline = snapshot;
    if (!baseline || before?.snapshotId !== baseline.state.snapshotId || filesystemDigest(before) !== baseline.digest) throw new Error('Der Dateisystem-Snapshot ist veraltet oder wurde verändert.');
    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > limits.entries || typeof request.useTrash !== 'boolean') throw new Error('Ungültige Löschanfrage.');
    const selected = [...new Set(request.paths.map(value => identity(allowed(value))))].map(key => {
      const item = baseline.entries.get(key);
      if (!item || item.root) throw new Error('Root-Ordner oder unbekannte Einträge dürfen nicht entfernt werden.');
      if (baseline.unloadedFolders.some(directory => below(directory, item.path))) throw new Error('Der Ordner muss vor der Dateioperation vollständig eingelesen und vorbereitet werden.');
      return item;
    });
    const targets = selected.filter(item => !selected.some(other => other !== item && other.type === 'folder' && below(item.path, other.path)));
    if (typeof options.deletePath !== 'function') throw new Error('Die native Löschfunktion ist nicht verfügbar.');
    busy = true;
    let completed = 0;
    try {
      await validateEntries(baseline, targets);
      for (const item of targets) {
        await validateEntries(baseline, [item]);
        await options.deletePath(item.path, { recursive: true, useTrash: request.useTrash });
        completed++;
      }
      const remainingDirectories = baseline.loadedDirectories.filter(directory => !targets.some(item => below(directory, item.path)));
      const state = inheritedPanes(await load({ directories: await availableViewDirectories(remainingDirectories) }), before);
      snapshot.state = clone(state);
      return state;
    } catch (error) {
      snapshot = null;
      const failure = new Error(`Löschen fehlgeschlagen nach ${completed} Einträgen: ${error.message}`, { cause: error });
      failure.deletedCount = completed;
      throw failure;
    } finally { busy = false; }
  }
  return { contains, load, apply, prepare, remove, measureFolder };
}

module.exports = { createProvider };
