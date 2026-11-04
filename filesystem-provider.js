const nativeFs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Progress = require('./media/commander-progress');
const { createOperationError } = require('./operation-errors');
const { getFileVersionInfo } = require('./pe-file-version');
const { readDirectoryComments } = require('./content-comments');
const { renameCase, renameNoReplace } = require('./native-rename');
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
function statIdentity(stat) {
  return Object.fromEntries(['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
}
function contentSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs].map(String).join(':');
}
function matchesOwnedFile(stat, identity) {
  return (!stat.isSymbolicLink() || process.platform === 'linux') && String(stat.dev) === String(identity.dev) && String(stat.ino) === String(identity.ino);
}
function matchesOwnedSnapshot(stat, identity) {
  return matchesOwnedFile(stat, identity) && ['size', 'mtimeNs', 'ctimeNs'].every(key => String(stat[key]) === String(identity[key]));
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
  const publishedEntries = new Map();
  const directoryHistory = new Map();
  let directoryClock = 0;
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

  function canNavigate(value, allowFinalLink = false) {
    try {
      const absolute = allowed(value);
      for (const component of components(absolute)) {
        let stat;
        try { stat = nativeFs.lstatSync(component); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        if (stat.isSymbolicLink()) return allowFinalLink === true && process.platform === 'linux' && component === absolute && permittedRoots().some(root => below(absolute, root));
      }
      return true;
    } catch { return false; }
  }

  async function resolveNavigation(value) {
    const absolute = allowed(value);
    if (process.platform !== 'linux') return { path: absolute, kind: 'directory' };
    await assertComponents(absolute);
    const linkBefore = await fs.lstat(absolute, { bigint: true });
    let resolved = absolute, targetStat = linkBefore;
    let linkText;
    if (linkBefore.isSymbolicLink()) {
      if (process.platform !== 'linux' || !permittedRoots().some(root => below(absolute, root))) throw new Error('Symbolische Verknüpfungen außerhalb des erlaubten Dateibaums sind nicht zulässig.');
      linkText = (await fs.readlink(absolute, { encoding: 'buffer' })).toString('base64');
      resolved = canonical(await fs.realpath(absolute));
      if (!permittedRoots().some(root => below(resolved, root))) throw new Error('Das Verknüpfungsziel liegt außerhalb der erlaubten Root-Verzeichnisse.');
      await assertComponents(resolved);
      targetStat = await fs.lstat(resolved, { bigint: true });
      const linkAfter = await fs.lstat(absolute, { bigint: true });
      const linkTextAfter = (await fs.readlink(absolute, { encoding: 'buffer' })).toString('base64');
      if (!linkAfter.isSymbolicLink() || statSignature(linkAfter) !== statSignature(linkBefore) || linkTextAfter !== linkText) throw Object.assign(new Error('Die symbolische Verknüpfung wurde während der Navigation geändert.'), { code: 'EntryChangedBeforeWrite', path: absolute });
    } else await assertComponents(absolute);
    const identities = { target: statIdentity(targetStat), ...(linkText !== undefined ? { link: { ...statIdentity(linkBefore), linkText } } : {}) };
    if (targetStat.isDirectory()) return { path: resolved, kind: 'directory', identities };
    if (targetStat.isFile()) return { path: resolved, kind: 'file', identities };
    throw new Error('Das Verknüpfungsziel ist kein regulärer Datei- oder Ordnerpfad.');
  }

  async function assertComponents(value, missing = false) {
    const absolute = allowed(value);
    for (const component of components(absolute)) {
      let stat;
      try { stat = await fs.lstat(component); } catch (error) { if (missing && error.code === 'ENOENT') return absolute; throw error; }
      if (stat.isSymbolicLink() && !(process.platform === 'linux' && component === absolute)) throw new Error('Symbolische Verknüpfung oder Reparse-Link ist nicht erlaubt.');
    }
    return absolute;
  }

  async function readSnapshot(settings = {}) {
    const sourceSnapshot = snapshot;
    const folders = settings.baseline ? clone(settings.baseline.folders) : {}, entries = new Map(settings.baseline?.entries);
    const loadedDirectories = new Set(settings.baseline?.loadedDirectories);
    const scannedDirectories = new Set(), discardedDirectories = new Set();
    function discardSubtree(directory, retainEntry = false) {
      discardedDirectories.add(directory);
      for (const key of Object.keys(folders)) if (below(key, directory)) delete folders[key];
      for (const key of loadedDirectories) if (below(key, directory)) loadedDirectories.delete(key);
      for (const [key, entry] of entries) if (below(entry.path, directory) && (!retainEntry || identity(entry.path) !== identity(directory))) entries.delete(key);
      if (retainEntry) folders[directory] = [];
    }
    for (const directory of settings.refreshDirectories || []) {
      loadedDirectories.delete(directory);
      for (const [key, entry] of entries) if (identity(slash(path.dirname(entry.path))) === identity(directory)) entries.delete(key);
    }
    let count = settings.baseline ? [...entries.values()].filter(entry => !entry.root).length : 0, processedEntries = 0;
    async function scan(directory, ...args) {
      try { return await scanDirectory(directory, ...args); }
      catch (error) {
        error.path ??= directory;
        error.scanPhase ??= 'directory-scan';
        throw error;
      }
    }
    async function scanDirectory(directory, depth, root = false, recursive = false) {
      throwIfAborted(settings.signal);
      const strict = recursive || (settings.recursiveDirectories || []).some(target => below(directory, target));
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
      scannedDirectories.add(directory);
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory()) throw new Error('Ein Root- oder Ordnerpfad ist kein Verzeichnis.');
      const existing = entries.get(identity(directory));
      if (existing?.signature && existing.signature.split(':').slice(0, 3).join(':') !== statSignature(stat).split(':').slice(0, 3).join(':')) discardSubtree(directory, true);
      entries.set(identity(directory), { path: directory, type: 'folder', signature: statSignature(stat), root: root || existing?.root, row: existing?.row });
      const listing = !strict && options.readDirectory ? await options.readDirectory(directory, settings.signal) : null;
      if (listing && (listing.dev !== stat.dev || listing.ino !== stat.ino)) throw Object.assign(new Error('Ordner während der Bestandsaufnahme geändert.'), { code: 'DirectoryChangedDuringScan', path: directory, scanPhase: 'directory-identity' });
      const enumerated = listing && new Map(listing.entries.map(entry => [entry.name, entry]));
      const names = (enumerated ? [...enumerated.keys()] : await fs.readdir(directory)).sort();
      loadedDirectories.add(directory);
      folders[directory] = [];
      let emitted = 0, emittedAt = Date.now();
      const publish = async final => {
        if (!settings.onDirectory || !final && folders[directory].length - emitted < 64 && Date.now() - emittedAt < 50) return;
        const rows = folders[directory].slice(emitted);
        emitted = folders[directory].length; emittedAt = Date.now();
        if (rows.length) {
          if (sourceSnapshot && snapshot === sourceSnapshot) for (const row of rows) {
            const entry = entries.get(identity(row.fsSource));
            if (entry) publishedEntries.set(identity(entry.path), { snapshot: sourceSnapshot, entry });
          }
          await settings.onDirectory({ path: directory, rows, completed: folders[directory].length, total: names.length, ...(final ? { phase: 'publication' } : {}) });
        }
      };
      await settings.onDirectory?.({ path: directory, names, rows: [], completed: 0, total: names.length });
      let directoryEntries;
      for (const name of names) {
        processedEntries++;
        await publish(false);
        throwIfAborted(settings.signal);
        const absolute = canonical(path.join(directory, name));
        if (!entries.has(identity(absolute)) && ++count > limits.entries) throw new Error('Die Eintragsgrenze des Dateisystem-Scans wurde erreicht.');
        let child, versionInfo, attributeFlags;
        try {
          const listed = enumerated?.get(name);
          child = listed?.stat || await fs.lstat(absolute, { bigint: true });
          if (!listed?.stat && !child.isSymbolicLink()) await assertComponents(absolute);
          if (listed?.stat) attributeFlags = listed.attributes;
          else if (options.readAttributes) {
            try { attributeFlags = await options.readAttributes(absolute); }
            catch (cause) {
              const code = { NotFound: 'ENOENT', Denied: 'EACCES' }[cause.code];
              if (!code) throw cause;
              throw Object.assign(new Error(cause.message, { cause }), { code, path: absolute, nativeCode: cause.nativeCode });
            }
          }
          throwIfAborted(settings.signal);
          if (child.isFile() && /\.(exe|dll)$/i.test(name)) {
            versionInfo = await getFileVersionInfo(absolute, { fs });
            if (statSignature(await fs.lstat(absolute, { bigint: true })) !== statSignature(child)) throw Object.assign(new Error('Datei während der Bestandsaufnahme geändert.'), { code: 'FileChangedDuringScan', path: absolute, scanPhase: 'file-metadata-validation' });
          }
        }
        catch (error) {
          if (!strict && error.code === 'ENOENT' && (!error.path || identity(canonical(error.path)) === identity(absolute))) continue;
          if (strict || !['EPERM', 'EACCES'].includes(error.code)) throw error;
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
        const hidden = attributeFlags?.hidden ?? (process.platform !== 'win32' && name.startsWith('.'));
        const row = { id: `fs:${identity(absolute)}`, name, type: child.isSymbolicLink() ? 'link' : child.isDirectory() ? 'folder' : fileType(name), size: child.isDirectory() ? 0 : Number(child.size), date: displayDate(child.mtimeMs), mtimeMs: Number(child.mtimeMs), attributes: `${child.isSymbolicLink() ? 'l' : child.isDirectory() ? 'd' : '-'}${child.isFile() ? 'a' : '-'}${(child.mode & 0o200n) === 0n ? 'r' : '-'}${hidden ? 'h' : '-'}`, fsSource: absolute };
        for (const [field, timestamp] of [['writedate', child.mtimeMs], ['creationdate', child.birthtimeMs], ['accessdate', child.atimeMs]]) {
          if (timestamp !== undefined && Number.isFinite(Number(timestamp))) row[field] = new Date(Number(timestamp)).toISOString();
        }
        row.attributeFlags = attributeFlags ? Object.fromEntries(Object.entries(attributeFlags).filter(([, value]) => typeof value === 'boolean')) : { directory: child.isDirectory(), readonly: (child.mode & 0o222n) === 0n, hidden };
        if (process.platform !== 'win32') row.posixMode = Number(child.mode);
        if (typeof attributeFlags?.dosName === 'string' && attributeFlags.dosName) row.dosName = attributeFlags.dosName;
        if (versionInfo?.version) row.fileVersion = versionInfo.version;
        if (versionInfo?.versionString !== undefined) row.fileVersionString = versionInfo.versionString;
        const linkText = child.isSymbolicLink() && process.platform === 'linux' ? (await fs.readlink(absolute, { encoding: 'buffer' })).toString('base64') : undefined;
        if (linkText !== undefined && statSignature(await fs.lstat(absolute, { bigint: true })) !== statSignature(child)) throw new Error('Verknüpfung während der Bestandsaufnahme geändert.');
        entries.set(identity(absolute), { path: absolute, type: child.isDirectory() ? 'folder' : 'file', signature: statSignature(child), contentSignature: contentSignature(child), ...(linkText !== undefined ? { linkText } : {}), row });
        folders[directory].push(row);
        settings.onProgress?.(Progress.event({ phase: settings.phase || 'preparing', filesScanned: count, path: absolute, overall: Progress.unknown('items', count, 'enumerating'), current: Progress.known('items', folders[directory].length, names.length) }));
        throwIfAborted(settings.signal);
        if (child.isDirectory()) {
          folders[absolute] ||= [];
          if (recursive) await scan(absolute, depth + 1, false, true);
        }
      }
      await settings.onDirectory?.({ path: directory, phase: 'comments', rows: [], completed: names.length, total: names.length });
      const comments = await readDirectoryComments(directory, names, { fs, platform: process.platform, encoding: typeof options.commentEncoding === 'function' ? options.commentEncoding(directory) : options.commentEncoding, signal: settings.signal, onProgress: settings.onDirectory ? progress => settings.onDirectory({ path: directory, phase: 'comments', rows: [], completed: names.length, total: names.length, progress: Progress.read(progress) }) : undefined });
      for (const row of folders[directory]) {
        const key = process.platform === 'win32' ? row.name.toLowerCase() : row.name;
        if (comments.has(key)) row.comment = comments.get(key);
      }
      await settings.onDirectory?.({ path: directory, phase: 'validation', rows: [], completed: names.length, total: names.length });
      let finalStat = await fs.lstat(directory, { bigint: true });
      const timeFields = ['mtimeNs', 'ctimeNs'];
      const incompleteTimes = timeFields.some(key => stat[key] > 0n && finalStat[key] === 0n)
        && timeFields.every(key => finalStat[key] === stat[key] || stat[key] > 0n && finalStat[key] === 0n);
      if (strict && finalStat.isDirectory() && !finalStat.isSymbolicLink() && incompleteTimes
          && ['dev', 'ino', 'mode', 'size'].every(key => finalStat[key] === stat[key])) {
        throwIfAborted(settings.signal);
        finalStat = await fs.lstat(directory, { bigint: true });
      }
      throwIfAborted(settings.signal);
      if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalStat.mode !== stat.mode || strict && statSignature(finalStat) !== statSignature(stat)) {
        const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
        const describe = value => JSON.stringify(Object.fromEntries(fields.map(key => [key, String(value[key])])));
        throw Object.assign(new Error('Ordner während der Bestandsaufnahme geändert.'), { code: 'DirectoryChangedDuringScan', path: directory, scanPhase: 'directory-validation', expectedDirectory: describe(stat), observedDirectory: describe(finalStat), changedFields: fields.filter(key => stat[key] !== finalStat[key]).join(', ') });
      }
      await publish(true);
      await settings.onDirectory?.({ path: directory, done: true, rows: [], completed: names.length, total: names.length });
    }
    if (!settings.visibleOnly) for (const root of roots) await scan(root, 0, true, settings.recursive === true);
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
    for (const directory of settings.directories || []) {
      if (settings.visibleOnly) { const target = allowed(directory); await scan(target, 0, roots.includes(target) || !entries.get(identity(target))?.row, false); }
      else await scanAncestors(directory, false);
    }
    for (const directory of settings.recursiveDirectories || []) {
      if (settings.visibleOnly) { const target = allowed(directory); await scan(target, 0, roots.includes(target) || !entries.get(identity(target))?.row, true); }
      else await scanAncestors(directory, true);
    }
    for (const directory of settings.refreshDirectories || []) {
      for (const previous of settings.baseline?.entries.values() || []) {
        if (previous.type !== 'folder' || identity(slash(path.dirname(previous.path))) !== identity(directory)) continue;
        const current = entries.get(identity(previous.path));
        if (current?.type !== 'folder' || current.row?.type === 'link') discardSubtree(previous.path);
        else if (current.signature.split(':').slice(0, 3).join(':') !== previous.signature.split(':').slice(0, 3).join(':')) discardSubtree(previous.path, true);
      }
    }
    const unloadedFolders = [...entries.values()].filter(entry => entry.type === 'folder' && !loadedDirectories.has(entry.path)).map(entry => entry.path);
    settings.onProgress?.(Progress.event({ phase: settings.phase || 'preparing', filesScanned: count, done: true, overall: Progress.known('items', processedEntries, processedEntries), current: Progress.known('items', processedEntries, processedEntries) }));
    throwIfAborted(settings.signal);
    return { folders, entries, loadedDirectories: [...loadedDirectories], unloadedFolders, scannedDirectories, discardedDirectories };
  }

  function pane(directory) { return { tabs: [directory], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false }; }
  const activeDirectories = state => [...new Set((state.panes || []).map(pane => pane.tabs?.[pane.tab || 0]).filter(directory => typeof directory === 'string' && !directory.startsWith('zip:')))];
  const deferredDirectories = state => [...new Set((state.panes || []).flatMap(pane => pane.tabs || []).filter(directory => !directory.startsWith('zip:') && !activeDirectories(state).includes(directory)))];

  async function availableViewDirectories(directories) {
    const available = await Promise.all(directories.map(async directory => {
      try { return (await fs.lstat(directory)).isDirectory() ? directory : null; }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
    }));
    return available.filter(Boolean);
  }

  async function load(settings = {}) {
    const left = allowed(settings.left || roots[0]), right = allowed(settings.right || roots[1] || roots[0]);
    let previous = snapshot;
    const visibleOnly = settings.baseline ? true : settings.visibleOnly ?? previous?.visibleOnly ?? false;
    const result = await readSnapshot({ ...settings, visibleOnly, directories: visibleOnly || settings.baseline ? settings.directories || [] : [...(settings.directories || []), left, right] });
    const classifiedDirectories = new Set(Object.keys(result.folders));
    let networkDirectories = typeof options.networkPaths === 'function' ? await options.networkPaths([...classifiedDirectories]) : [];
    throwIfAborted(settings.signal);
    if (settings.getVisibleDirectories) settings = { ...settings, visibleDirectories: settings.getVisibleDirectories() };
    if (settings.baseline && snapshot !== previous) {
      networkDirectories = [...new Set([...networkDirectories, ...(snapshot.state.networkDirectories || []).filter(directory => !classifiedDirectories.has(directory))])];
      const scanned = result.scannedDirectories;
      const discarded = new Set([...result.discardedDirectories].filter(directory => {
        const current = snapshot.entries.get(identity(directory)), incoming = result.entries.get(identity(directory));
        return !snapshot.loadedDirectories.includes(directory) || current?.type !== 'folder' || incoming?.type !== 'folder' || incoming.row?.type === 'link' || current.signature.split(':').slice(0, 3).join(':') !== incoming.signature.split(':').slice(0, 3).join(':');
      }));
      const removed = target => [...discarded].some(directory => below(target, directory));
      const replacedEntry = entry => scanned.has(slash(path.dirname(entry.path))) || removed(entry.path);
      const folders = clone(snapshot.folders), entries = new Map(snapshot.entries);
      for (const directory of Object.keys(folders)) if (removed(directory)) delete folders[directory];
      for (const [directory, rows] of Object.entries(result.folders)) {
        if (scanned.has(directory) || removed(directory) || scanned.has(slash(path.dirname(directory))) && !Object.hasOwn(folders, directory)) folders[directory] = rows;
      }
      for (const [key, entry] of entries) if (replacedEntry(entry)) entries.delete(key);
      for (const [key, entry] of result.entries) if (replacedEntry(entry) || scanned.has(entry.path)) entries.set(key, entry);
      result.folders = folders; result.entries = entries;
      result.loadedDirectories = [...new Set([...snapshot.loadedDirectories.filter(directory => !scanned.has(directory) && !removed(directory)), ...result.loadedDirectories.filter(directory => scanned.has(directory) || removed(directory))])];
      result.unloadedFolders = [...entries.values()].filter(entry => entry.type === 'folder' && !result.loadedDirectories.includes(entry.path)).map(entry => entry.path);
      previous = snapshot;
    }
    if (settings.visibleDirectories) {
      for (const directory of settings.directories || []) directoryHistory.set(directory, ++directoryClock);
      const inactive = Object.keys(result.folders).filter(directory => !settings.visibleDirectories.includes(directory));
      let bytes = inactive.reduce((sum, directory) => sum + Buffer.byteLength(JSON.stringify([directory, result.folders[directory]])), 0);
      const budget = options.directoryCacheBytes ?? 2 * 1024 * 1024;
      for (const directory of inactive.sort((a, b) => (directoryHistory.get(a) || 0) - (directoryHistory.get(b) || 0))) {
        if (bytes <= budget) break;
        bytes -= Buffer.byteLength(JSON.stringify([directory, result.folders[directory]]));
        delete result.folders[directory]; directoryHistory.delete(directory);
        result.loadedDirectories = result.loadedDirectories.filter(value => value !== directory);
        for (const [key, entry] of result.entries) if (identity(slash(path.dirname(entry.path))) === identity(directory) && !settings.visibleDirectories.includes(entry.path)) result.entries.delete(key);
      }
      for (const directory of [left, right, ...(settings.baseline?.state.panes || []).flatMap(p => p.tabs)]) result.folders[directory] ||= [];
      for (const [directory, rows] of Object.entries(result.folders)) for (const row of rows) if (row.type === 'folder') result.folders[canonical(path.join(directory, row.name))] ||= [];
      for (const directory of settings.visibleDirectories) {
        const entry = result.entries.get(identity(directory));
        if (entry && !(result.folders[slash(path.dirname(directory))] || []).some(row => row.type === 'folder' && row.name === path.basename(directory))) entry.root = true;
      }
    }
    const inactiveDirectories = settings.visibleDirectories ? result.loadedDirectories.filter(directory => !settings.visibleDirectories.includes(directory)) : [];
    result.loadedDirectories = result.loadedDirectories.filter(directory => !inactiveDirectories.includes(directory));
    const requestedDeferred = new Set((settings.deferredDirectories || []).flatMap(directory => { try { return [allowed(directory)]; } catch { return []; } }));
    const retainedDeferred = directory => {
      if (!(settings.recursiveDirectories || []).some(root => below(directory, root))) return true;
      const entry = result.entries.get(identity(directory));
      return entry?.type === 'folder' && entry.row?.type !== 'link';
    };
    const deferredDirectories = [...new Set([...(visibleOnly ? roots : []), ...inactiveDirectories, ...(settings.baseline?.state.panes || []).flatMap(pane => pane.tabs), ...(settings.deferredDirectories || previous?.deferredDirectories || [])].flatMap(directory => { try { return [allowed(directory)]; } catch { return []; } }))].filter(directory => retainedDeferred(directory) && (requestedDeferred.has(directory) || roots.includes(directory) || Object.hasOwn(result.folders, directory) || Object.hasOwn(previous?.folders || {}, directory)) && !result.loadedDirectories.includes(directory));
    for (const directory of deferredDirectories) {
      if (!settings.baseline) {
        const refreshed = target => result.loadedDirectories.some(loaded => below(target, loaded));
        for (const [key, entry] of previous?.entries || []) if (below(entry.path, directory) && !refreshed(entry.path) && !result.entries.has(key)) result.entries.set(key, entry);
        for (const [key, rows] of Object.entries(previous?.folders || {})) if (below(key, directory) && !refreshed(key)) result.folders[key] = clone(rows);
      }
      result.folders[directory] ||= [];
    }
    result.unloadedFolders = [...new Set([...result.unloadedFolders.filter(directory => Object.hasOwn(result.folders, directory)), ...Object.keys(result.folders).filter(directory => !result.loadedDirectories.includes(directory))])];
    if (!Object.hasOwn(result.folders, left) || !Object.hasOwn(result.folders, right)) throw new Error('Der gewählte Ordner wurde nicht vollständig eingelesen.');
    for (const entry of result.entries.values()) if (entry.root) visitedRoots.add(entry.path);
    const state = { version: 1, active: 0, realFilesystem: true, snapshotId: crypto.randomUUID(), panes: [pane(left), pane(right)], folders: result.folders, unloadedFolders: result.unloadedFolders, networkDirectories };
    snapshot = { ...result, deferredDirectories, visibleOnly, state: clone(state), digest: filesystemDigest(state) };
    publishedEntries.clear();
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
      if (!roots.some(root => identity(root) === identity(directory)) && !snapshot?.deferredDirectories?.includes(directory) && !snapshot?.entries.get(identity(directory))?.root && entries.get(identity(directory))?.type !== 'folder') throw Object.assign(new Error('Ein virtueller Archiv- oder fremder Ordnerpfad ist nicht erlaubt.'), { path: directory });
    }
    for (const root of roots) if (!Object.hasOwn(state.folders, root)) throw new Error('Root-Ordner dürfen nicht entfernt werden.');
    for (const item of entries.values()) if (item.type === 'folder' && !Object.hasOwn(state.folders, item.path)) throw new Error('Ein Ordner ist nicht vollständig im Zielzustand enthalten.');
    return entries;
  }

  async function validateEntries(expected, selected, signal, recursive = true) {
    const checked = new Set();
    async function verify(entry) {
      if (checked.has(identity(entry.path))) return;
      checked.add(identity(entry.path));
      throwIfAborted(signal);
      if (entry.metadataError) throw entry.metadataError;
      await assertComponents(entry.path);
      const observed = await fs.lstat(entry.path, { bigint: true });
      if (observed.isSymbolicLink() && entry.linkText === undefined) throw new Error('Eintrag vor dem Schreiben durch eine Verknüpfung ersetzt.');
      const signature = statSignature(observed);
      const matches = !recursive && entry.type === 'folder'
        ? signature.split(':').slice(0, 3).join(':') === entry.signature.split(':').slice(0, 3).join(':')
        : signature === entry.signature;
      if (!matches) {
        const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
        const values = entry.signature.split(':');
        throw Object.assign(new Error('Eintrag vor dem Schreiben extern geändert.'), {
          code: 'EntryChangedBeforeWrite', path: entry.path,
          outcome: { sourceIdentity: {
            expected: Object.fromEntries(fields.map((key, index) => [key, values[index]])),
            observed: Object.fromEntries(fields.map(key => [key, String(observed[key])]))
          } }
        });
      }
      if (!recursive && entry.type === 'folder') return;
      if (entry.linkText !== undefined && (!observed.isSymbolicLink() || (await fs.readlink(entry.path, { encoding: 'buffer' })).toString('base64') !== entry.linkText)) throw new Error('Verknüpfung vor dem Schreiben extern geändert.');
      if (entry.type === 'file' && entry.hash && hash(await fs.readFile(entry.path)) !== entry.hash) throw new Error('Datei vor dem Schreiben extern geändert.');
      if (!recursive || entry.type !== 'folder') return;
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
      const directories = baseline.visibleOnly ? activeDirectories(before) : [...new Set([transfer.sourcePath, ...before.panes.flatMap(pane => pane.tabs)])];
      const fresh = inheritedPanes(refresh ? await load({ directories: directories.filter(directory => contains(directory) && nativeFs.existsSync(directory)), ...(baseline.visibleOnly ? { visibleOnly: true, deferredDirectories: deferredDirectories(before) } : {}) }) : clone(baseline.state), before);
      const completedSources = completed.filter(entry => transfer.mode === 'copy' || !nativeFs.existsSync(entry.path));
      fresh.operationOutcome = { cancelled: true, completedIds: completedSources.map(entry => entry.row.id), completedSourcePaths: completedSources.map(entry => entry.path) };
      fresh.updatedDirectories = activeDirectories(before).filter(directory => completedSources.some(source => transfer.mode === 'move' && below(source.path, directory) || [...desired.values()].some(item => item.row.fsSource && below(item.row.fsSource, source.path) && identity(item.path) !== identity(item.row.fsSource) && below(item.path, directory))));
      snapshot.state = clone(fresh); return fresh;
    };
    if (operation.signal?.aborted) {
      if (transfer) return abortedState([], false);
      throw abortError();
    }
    for (const directory of baseline.unloadedFolders) {
      const untouched = desired.get(identity(directory));
      const viewRoot = roots.includes(directory) || baseline.deferredDirectories?.includes(directory) || baseline.entries.get(identity(directory))?.root;
      if ((untouched ? untouched.row.fsSource !== directory : !viewRoot) || JSON.stringify(after.folders[directory]) !== JSON.stringify(baseline.folders[directory]) || [...desired.values()].some(item => item.type === 'folder' && item.row.fsSource === directory && identity(item.path) !== identity(directory))) throw new Error('Der Ordner muss vor der Dateioperation vollständig eingelesen und vorbereitet werden.');
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
        if (source?.linkText !== undefined) throw new Error('Verknüpfungsziele dürfen nicht als Dateiinhalt ersetzt werden.');
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
    const createdDirectoryIdentities = new Map();
    const completedDirectoryMetadata = new Set();
    const totalBytes = [...staged.values()].reduce((sum, file) => sum + (file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0), 0);
    let publishedBytes = 0;
    /** @param {object} file @param {{phase: string, transferred?: number, [field: string]: unknown}} event */
    const report = (file, event) => { const bytes = file.expectedSize ?? file.data?.length ?? file.source?.row.size ?? 0; const transferred = event.phase === 'published' ? bytes : Math.min(bytes, event.transferred || 0); operation.onProgress?.(Progress.event({ ...event, path: file.path, sourcePath: file.appendSources?.[0]?.path || file.source?.path || file.path, totalBytes, completedBytes: publishedBytes + transferred, filesCompleted: createdFiles.filter(item => item.completed).length, filesTotal: staged.size, overall: Progress.known('bytes', publishedBytes + transferred, totalBytes), current: Progress.known('bytes', transferred, bytes) })); };
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
    async function removeStage(stage, keepDirectory = false) {
      if (stage.cleaned) return;
      await assertComponents(stage.directory);
      const names = await fs.readdir(stage.directory);
      if (!names.length) { await fs.rmdir(stage.directory); stage.cleaned = true; return; }
      if (!stage.signature || names.length !== 1 || names[0] !== path.basename(stage.path)) throw new Error('Sicherungsdatei extern verändert.');
      await assertComponents(stage.path);
      if (statSignature(await fs.lstat(stage.path, { bigint: true })) !== stage.signature || stage.hash && hash(await fs.readFile(stage.path)) !== stage.hash) throw new Error('Sicherungsdatei extern verändert.');
      await fs.unlink(stage.path);
      if (!keepDirectory) { await fs.rmdir(stage.directory); stage.cleaned = true; }
    }
    async function verifyEntry(item, signal) {
      await validateEntries(baseline, [item], signal);
    }
    async function verifyPublications(originalPath, signal) {
      for (const file of createdFiles.filter(file => file.completed)) {
        if (originalPath && !below(file.path, originalPath) && ![file.source, ...(file.appendSources || [])].some(source => source && below(source.path, originalPath))) continue;
        throwIfAborted(signal);
        await assertComponents(file.path);
        if (statSignature(await fs.lstat(file.path, { bigint: true })) !== file.createdSignature) throw new Error('Veröffentlichtes Kopierziel fehlt oder wurde extern geändert.');
      }
    }
    async function restore(item) {
      const original = baseline.entries.get(identity(item.path));
      await assertComponents(item.backup);
      const stat = await fs.lstat(item.backup, { bigint: true });
      if (`${stat.dev}:${stat.ino}` !== original.signature.split(':').slice(0, 2).join(':')) throw new Error('Sicherungsdatei extern verändert.');
      await (options.renameNoReplace || renameNoReplace)({ source: item.backup, target: item.path, expected: { dev: String(stat.dev), ino: String(stat.ino) } }, { fs });
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
        if (process.platform === 'linux' && !options.fs) {
          const stat = await fs.lstat(directory.path, { bigint: true });
          createdDirectoryIdentities.set(directory.path, { dev: String(stat.dev), ino: String(stat.ino) });
        }
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
          await fs.mkdir(directory, process.platform === 'linux' ? { mode: 0o700 } : undefined);
          const stage = { directory, path: `${directory}/${path.basename(file.path)}` }; stages.push(stage);
          await assertComponents(sourcePath);
          const sourceStat = await fs.lstat(sourcePath, { bigint: true });
          const sourceIsQuarantined = Boolean(movedSource);
          if (sourceIsQuarantined
            ? contentSignature(sourceStat) !== file.source.contentSignature
            : statSignature(sourceStat) !== file.source.signature) throw new Error('Datei vor dem Kopieren extern geändert.');
          const copyOptions = { signal: operation.signal, onProgress: event => report(file, { ...event, phase: 'copying' }), expectedSource: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(sourceStat[key])])) };
          if (options.copyFile) await options.copyFile(sourcePath, stage.path, copyOptions);
          else if ((operation.signal || process.platform === 'linux') && !options.fs) {
            const copied = await operation.copySession().copy({ roots: permittedRoots(), source: sourcePath, target: stage.path, expected: copyOptions.expectedSource }, copyOptions);
            if (copied?.ownedDestination) {
              const owned = copied.ownedDestination;
              const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
              if (fields.some(key => !/^-?\d+$/.test(String(owned[key])))) throw new Error('Die native Zielidentität ist unvollständig.');
              const observed = await fs.lstat(stage.path, { bigint: true });
              if (!matchesOwnedSnapshot(observed, owned)) throw new Error('Die native Zielidentität hat sich geändert.');
              stage.nativeOwnedDestination = owned;
            }
          }
          else if (file.source.linkText !== undefined) await fs.symlink(Buffer.from(file.source.linkText, 'base64'), stage.path);
          else await fs.copyFile(sourcePath, stage.path, nativeFs.constants.COPYFILE_EXCL);
          const copiedStage = await fs.lstat(stage.path, { bigint: true });
          if (stage.nativeOwnedDestination && !matchesOwnedSnapshot(copiedStage, stage.nativeOwnedDestination)) throw new Error('Die native Zielidentität hat sich geändert.');
          stage.signature = statSignature(copiedStage);
          if (file.source.linkText !== undefined) {
            if (!copiedStage.isSymbolicLink() || (await fs.readlink(stage.path, { encoding: 'buffer' })).toString('base64') !== file.source.linkText) throw new Error('Die Kopierprüfung der Verknüpfung ist fehlgeschlagen.');
            throwIfAborted(operation.signal);
            await validateEntries(baseline, [file.source], operation.signal, false);
            await (options.renameNoReplace || renameNoReplace)({ source: stage.path, target: file.path, expected: { dev: String(copiedStage.dev), ino: String(copiedStage.ino) }, expectedSnapshot: Object.fromEntries(['size', 'mode', 'mtimeNs', 'ctimeNs'].map(key => [key, String(copiedStage[key])])), allowSymbolicLink: true }, { fs });
            const published = await fs.lstat(file.path, { bigint: true });
            if (!published.isSymbolicLink() || !matchesOwnedFile(published, copiedStage)) throw new Error('Die veröffentlichte Verknüpfung wurde extern verändert.');
            file.createdIdentity = `${published.dev}:${published.ino}`;
            file.createdContentSignature = contentSignature(published);
            file.createdSignature = statSignature(published);
            createdFiles.push(file);
            await removeStage(stage);
          } else {
          for (const source of file.appendSources || []) await appendToStage(source, stage, file);
          const input = await fs.open(stage.path, 'r');
          try {
            const stat = await input.stat({ bigint: true });
            if (stage.nativeOwnedDestination && !(file.appendSources?.length
              ? matchesOwnedFile(stat, stage.nativeOwnedDestination)
              : matchesOwnedSnapshot(stat, stage.nativeOwnedDestination))) throw new Error('Die native Zielidentität hat sich geändert.');
            stage.signature = statSignature(stat);
            if (file.hash) stage.hash = hash(await input.readFile());
            throwIfAborted(operation.signal);
            if (Number(stat.size) !== (file.expectedSize ?? file.source.row.size) || file.hash && stage.hash !== file.hash) throw new Error('Die Kopierprüfung der Zieldatei ist fehlgeschlagen.');
            if (operation.verifyAfterCopy !== false) await verifyCopiedBytes(file, sourcePath, input);
            if (contentSignature(await fs.lstat(sourcePath, { bigint: true })) !== file.source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.');
            for (const source of file.appendSources || []) { await assertComponents(source.path); if (contentSignature(await fs.lstat(source.path, { bigint: true })) !== source.contentSignature) throw new Error('Datei während des Kopierens extern geändert.'); }
            await assertComponents(file.path, true);
            const stageStat = await fs.lstat(stage.path, { bigint: true });
            if (statSignature(stageStat) !== stage.signature || stage.nativeOwnedDestination && !matchesOwnedFile(stageStat, stage.nativeOwnedDestination)) throw new Error('Sicherungsdatei extern verändert.');
            if (process.platform === 'linux' && (!options.fs || options.renameNoReplace)) {
              await (options.renameNoReplace || renameNoReplace)({ source: stage.path, target: file.path, expected: { dev: String(stat.dev), ino: String(stat.ino) }, expectedSnapshot: Object.fromEntries(['size', 'mode', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])])) }, { fs });
            } else await fs.link(stage.path, file.path);
            const publishedStat = await fs.lstat(file.path, { bigint: true });
            if (stage.nativeOwnedDestination && !matchesOwnedFile(publishedStat, stage.nativeOwnedDestination)) throw new Error('Die native Zielidentität hat sich bei der Veröffentlichung geändert.');
            file.createdIdentity = `${stat.dev}:${stat.ino}`;
            file.createdContentSignature = contentSignature(stat);
            file.createdHash = stage.hash;
            createdFiles.push(file);
            stage.signature = statSignature(await input.stat({ bigint: true }));
            await removeStage(stage, true);
            file.createdSignature = statSignature(await input.stat({ bigint: true }));
          } finally { await input.close(); }
          await removeStage(stage);
          }
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
      if (process.platform === 'linux' && !options.fs) {
        for (const directory of [...newDirectories].reverse()) {
          if (!directory.row.fsSource) continue;
          const source = baseline.entries.get(identity(directory.row.fsSource));
          if (!source || source.type !== 'folder') throw new Error('Die Ordnerquelle gehört nicht zum ursprünglichen Snapshot.');
          throwIfAborted(operation.signal);
          await validateEntries(baseline, [source], operation.signal, false);
          await assertComponents(directory.path);
          const targetStat = await fs.lstat(directory.path, { bigint: true });
          if (!targetStat.isDirectory() || !matchesOwnedFile(targetStat, createdDirectoryIdentities.get(directory.path))) throw new Error('Der neue Zielordner wurde extern verändert.');
          const sourceStat = await fs.lstat(source.path, { bigint: true });
          const describe = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
          operation.onProgress?.(Progress.event({ phase: 'metadata', path: directory.path, sourcePath: source.path, overall: Progress.unknown('items', 0, 'native-operation'), current: Progress.unknown('items', 0, 'native-operation') }));
          const result = await operation.copySession().copy({ roots: permittedRoots(), source: source.path, target: directory.path, expected: describe(sourceStat), metadataOnly: true, expectedTarget: describe(targetStat) }, { signal: operation.signal });
          const observed = await fs.lstat(directory.path, { bigint: true });
          if (!result.ownedDestination || !matchesOwnedSnapshot(observed, result.ownedDestination)) throw new Error('Die native Ordner-Metadatenübernahme wurde nicht bestätigt.');
          completedDirectoryMetadata.add(directory.path);
        }
      }
      for (const item of deferredSources) {
        throwIfAborted(operation.signal);
        await verifyPublications(item.path, operation.signal);
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
        const publishedRoots = transfer.selected.filter(entry => {
          const related = [...staged.values()].filter(file => origins(file).some(source => below(source, entry.path)));
          return related.length > 0 && related.every(file => file.completed);
        });
        const completedRoots = publishedRoots.filter(entry => {
          const directories = process.platform === 'linux' && !options.fs
            ? newDirectories.filter(directory => directory.row.fsSource && below(directory.row.fsSource, entry.path)) : [];
          return directories.every(directory => completedDirectoryMetadata.has(directory.path));
        });
        const retainedPaths = [];
        try {
          await verifyPublications();
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
            await restore(item); item.restored = true;
          }
          if (transfer.mode === 'move') {
            const sourceEntries = new Map(completedFiles.flatMap(file => origins(file)).map(source => [identity(source), baseline.entries.get(identity(source))]));
            for (const entry of sourceEntries.values()) {
              if (!entry || desired.has(identity(entry.path)) || moved.some(item => identity(item.path) === identity(entry.path))) continue;
              await verifyEntry(entry);
              await verifyPublications(entry.path);
              const backup = `${await backupDirectory(entry.path)}/${crypto.randomUUID()}`;
              await fs.rename(entry.path, backup); moved.push({ path: entry.path, backup });
            }
          }
          for (const directory of createdDirectories.reverse()) {
            const originalDirectory = desired.get(identity(directory))?.row.fsSource;
            if (completedFiles.some(file => below(file.path, directory)) || originalDirectory && publishedRoots.some(entry => entry.type === 'folder' && below(originalDirectory, entry.path))) continue;
            await assertComponents(directory); await fs.rmdir(directory);
          }
          for (const item of moved.filter(item => !item.restored)) await removeBackup(item.backup, item.path);
          for (const directory of backups.values()) await fs.rmdir(directory);
          if (transfer.mode === 'move') {
            const directories = [...baseline.entries.values()].filter(entry => !entry.root && entry.type === 'folder' && !desired.has(identity(entry.path))).sort((a, b) => b.path.length - a.path.length);
            for (const entry of directories) {
              const destination = [...desired.values()].find(item => item.type === 'folder' && item.row.fsSource && identity(item.row.fsSource) === identity(entry.path) && identity(item.path) !== identity(entry.path));
              if (!destination || !nativeFs.existsSync(destination.path) || !nativeFs.existsSync(entry.path) || (await fs.readdir(entry.path)).length) continue;
              if (process.platform === 'linux' && !options.fs && !completedDirectoryMetadata.has(destination.path)) continue;
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
          await restore(item);
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
        if (!(original.linkText !== undefined ? stat.isSymbolicLink() && (await fs.readlink(backupPath, { encoding: 'buffer' })).toString('base64') === original.linkText : stat.isFile()) || contentSignature(stat) !== original.contentSignature || original.hash && hash(await fs.readFile(backupPath)) !== original.hash) throw new Error('Sicherungsdatei extern verändert.');
        await verifyPublications(originalPath);
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
    const reloadDirectories = baseline.visibleOnly ? activeDirectories(after) : [...baseline.loadedDirectories, ...newDirectories.map(item => item.path)];
    const next = inheritedPanes(await load({ directories: await availableViewDirectories(reloadDirectories.filter(directory => roots.includes(directory) || baseline.entries.get(identity(directory))?.root || desired.get(identity(directory))?.type === 'folder')), ...(baseline.visibleOnly ? { visibleOnly: true, deferredDirectories: deferredDirectories(after) } : {}) }), after);
    const updatedPaths = [...staged.values(), ...removed, ...newDirectories].map(item => item.path).concat(caseChanges.flatMap(change => [change.original.path, change.target]));
    next.updatedDirectories = activeDirectories(after).filter(directory => updatedPaths.some(target => below(target, directory)));
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
      let total = 0, scanned = 0;
      const pending = [target];
      while (pending.length) {
        throwIfAborted(settings.signal);
        const current = pending.pop();
        await assertComponents(current);
        const beforeStat = await fs.lstat(current, { bigint: true });
        if (!beforeStat.isDirectory()) throw new Error('Der Ordner wurde während der Größenberechnung geändert.');
        const names = await fs.readdir(current); let processed = 0;
        settings.onProgress?.(Progress.event({ phase: 'folder-size', path: current, overall: Progress.unknown('items', scanned, 'enumerating'), current: Progress.known('items', 0, names.length) }));
        for (const name of names) {
          throwIfAborted(settings.signal);
          const child = allowed(path.join(current, name));
          const stat = await fs.lstat(child, { bigint: true });
          settings.onProgress?.(Progress.event({ phase: 'folder-size', path: child, overall: Progress.unknown('items', ++scanned, 'enumerating'), current: Progress.known('items', ++processed, names.length) }));
          if (stat.isSymbolicLink() && process.platform === 'linux') continue;
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
    if (!settings.navigation && (!snapshot || before?.snapshotId !== snapshot.state.snapshotId || filesystemDigest(before) !== snapshot.digest)) throw new Error('Der Dateisystem-Snapshot ist veraltet oder wurde verändert.');
    const directories = settings.navigation
      ? await Promise.all((settings.directories || []).map(async directory => {
        const resolved = await resolveNavigation(directory);
        if (resolved.kind !== 'directory') throw Object.assign(new Error('Der Navigationspfad ist kein Ordner.'), { code: 'NotDirectory', path: resolved.path });
        return resolved.path;
      }))
      : (settings.directories || []).map(allowed);
    const fresh = await load({ directories: settings.navigation ? directories : [...(snapshot.visibleOnly ? activeDirectories(before) : snapshot.loadedDirectories), ...directories], ...(settings.navigation ? { baseline: snapshot, refreshDirectories: directories, visibleDirectories: settings.visibleDirectories, getVisibleDirectories: settings.getVisibleDirectories, onDirectory: settings.onDirectory } : {}), recursiveDirectories: settings.recursive ? directories : [], signal: settings.signal, onProgress: settings.onProgress });
    const state = inheritedPanes(fresh, before);
    if (snapshot.state.snapshotId === fresh.snapshotId) snapshot.state = clone(state);
    return state;
  }
  async function remove(before, request = {}, settings = {}) {
    if (busy) throw new Error('Eine Dateisystemoperation läuft bereits.');
    const baseline = snapshot;
    if (!baseline || before?.snapshotId !== baseline.state.snapshotId || filesystemDigest(before) !== baseline.digest) throw new Error('Der Dateisystem-Snapshot ist veraltet oder wurde verändert.');
    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > limits.entries || typeof request.useTrash !== 'boolean') throw new Error('Ungültige Löschanfrage.');
    const selected = [...new Set(request.paths.map(value => identity(allowed(value))))].map(key => {
      const published = publishedEntries.get(key);
      const item = baseline.entries.get(key) || (published?.snapshot === baseline ? published.entry : undefined);
      const currentDirectory = typeof request.currentDirectory === 'string' && identity(allowed(request.currentDirectory)) === key && request.paths.length === 1 && activeDirectories(before).some(directory => identity(directory) === key);
      const protectedRoot = roots.some(root => identity(root) === key) || identity(slash(path.parse(item?.path || '').root)) === key;
      if (!item || item.root && (!currentDirectory || protectedRoot) || request.currentDirectory !== undefined && !currentDirectory) throw new Error('Root-Ordner oder unbekannte Einträge dürfen nicht entfernt werden.');
      return item;
    });
    const targets = selected.filter(item => !selected.some(other => other !== item && other.type === 'folder' && below(item.path, other.path)));
    if (typeof options.deletePath !== 'function') throw new Error('Die native Löschfunktion ist nicht verfügbar.');
    busy = true;
    let completed = 0;
    try {
      throwIfAborted(settings.signal);
      const permanentPaths = new Set(typeof options.prepareDelete === 'function' ? await options.prepareDelete(targets.map(item => item.path), request.useTrash, request.confirmedNetworkPaths) : []);
      throwIfAborted(settings.signal);
      await validateEntries(baseline, targets, settings.signal, false);
      for (const item of targets) {
        throwIfAborted(settings.signal);
        settings.onProgress?.(Progress.event({ phase: 'deleting', path: item.path, overall: Progress.known('items', completed, targets.length), current: Progress.unknown('items', 0, 'native-operation') }));
        await validateEntries(baseline, [item], settings.signal, false);
        throwIfAborted(settings.signal);
        await options.deletePath(item.path, { recursive: true, useTrash: request.useTrash && !permanentPaths.has(item.path) });
        completed++;
        settings.onProgress?.(Progress.event({ phase: 'deleting', path: item.path, overall: Progress.known('items', completed, targets.length), current: Progress.known('items', 1, 1) }));
      }
      const remainingDirectories = (baseline.visibleOnly ? activeDirectories(before) : baseline.loadedDirectories).filter(directory => !targets.some(item => below(directory, item.path)));
      const state = inheritedPanes(await load({ directories: await availableViewDirectories(remainingDirectories), ...(baseline.visibleOnly ? { visibleOnly: true, deferredDirectories: deferredDirectories(before) } : {}) }), before);
      state.updatedDirectories = activeDirectories(before).filter(directory => targets.some(target => below(target.path, directory)));
      snapshot.state = clone(state);
      return state;
    } catch (error) {
      snapshot = null;
      publishedEntries.clear();
      if (error.name === 'AbortError') throw error;
      const failure = new Error(`Löschen fehlgeschlagen nach ${completed} Einträgen: ${error.message}`, { cause: error });
      failure.deletedCount = completed;
      throw failure;
    } finally { busy = false; }
  }
  return { contains, canNavigate, resolveNavigation, load, apply, prepare, remove, measureFolder };
}

module.exports = { createProvider };
