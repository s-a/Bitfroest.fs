const path = require('node:path');
const fs = require('node:fs/promises');
const { createZipProvider, archivePath } = require('./zip-provider');
const { createZipOperations } = require('./zip-operations');

function createZipFilesystem(base, options = {}) {
  const archives = createZipProvider({ ...options, contains: base.contains });
  const operations = createZipOperations({ contains: base.contains });
  const views = new Map();
  let deferredViews = [];
  const real = state => ({ ...state, folders: Object.fromEntries(Object.entries(state.folders).filter(([key]) => !archivePath(key))), unloadedFolders: (state.unloadedFolders || []).filter(key => !archivePath(key)) });
  function overlay(state) {
    if (!state) return state;
    const result = { ...state, folders: { ...state.folders }, archiveLocations: {} };
    for (const view of views.values()) { Object.assign(result.folders, structuredClone(view.folders)); Object.assign(result.archiveLocations, view.locations); }
    for (const directory of deferredViews) result.folders[directory] ||= [];
    result.unloadedFolders = [...new Set([...(result.unloadedFolders || []), ...deferredViews])];
    return result;
  }
  function readonly(before, after) {
    for (const [key, rows] of Object.entries(before.folders)) if (archivePath(key) && JSON.stringify(rows) !== JSON.stringify(after.folders[key])) throw new Error('Änderungen innerhalb von ZIP-Archiven sind im Pilot nicht verfügbar.');
    for (const [key, rows] of Object.entries(after.folders)) if (!archivePath(key) && rows.some(row => archivePath(row.fsSource))) throw new Error('Archiveinträge müssen mit Entpacken kopiert werden.');
  }
  async function load(settings = {}) {
    deferredViews = (settings.deferredDirectories || []).filter(archivePath);
    const requested = settings.directories || [], physical = requested.filter(value => !archivePath(value));
    for (const value of requested) {
      const archive = archivePath(value);
      if (!archive) continue;
      physical.push(path.dirname(archive).replaceAll('\\', '/'));
      try { const view = await archives.open(archive); views.set(view.path, view); }
      catch { for (const [key, view] of views) if (view.locations[key].archive === archive) views.delete(key); }
    }
    return overlay(await base.load({ ...settings, directories: [...new Set(physical)], deferredDirectories: (settings.deferredDirectories || []).filter(value => !archivePath(value)) }));
  }
  return {
    ...base,
    load,
    canNavigate: value => Boolean(archivePath(value) ? base.contains(archivePath(value)) : base.contains(value)),
    async openArchive(state, archive) { const view = await archives.open(archive); views.set(view.path, view); return { state: overlay(real(state)), path: view.path }; },
    copyArchive: (request, settings) => archives.copy({ ...request, target: request.target || path.dirname(archivePath(request.path)) }, settings),
    async unpackArchives(state, request, settings = {}) {
      const rows = state.folders[request.sourcePath]?.filter(row => request.ids?.includes(row.id)) || [];
      if (!rows.length || rows.length !== new Set(request.ids).size || rows.some(row => !/\.zip$/i.test(row.name))) throw new Error('Ungültige Archivauswahl.');
      const results = [];
      const protectedSources = await Promise.all(rows.map(row => fs.stat(row.fsSource, { bigint: true })));
      for (const row of rows) {
        const view = await archives.open(row.fsSource);
        const base = request.target || path.dirname(row.fsSource), target = request.separate ? path.join(base, path.basename(row.name, path.extname(row.name))) : base;
        if (view.folders[view.path].length) results.push(await archives.copy({ ...request, path: view.path, ids: view.folders[view.path].map(row => row.id), target }, { ...settings, protectedSources }));
      }
      return results;
    },
    async testArchives(state, request, settings) {
      const current = state.archiveLocations?.[request.path];
      const rows = current ? [{ fsSource: current.archive }] : state.folders[request.sourcePath]?.filter(row => request.ids?.includes(row.id)) || [];
      if (!rows.length) throw new Error('Ungültige Archivauswahl.');
      const results = []; for (const row of rows) results.push(await operations.test(row.fsSource, settings)); return results;
    },
    readArchiveEntry: archives.readEntry,
    async replaceArchiveEntry(reference, data, settings = {}) {
      if (!reference?.archiveEntry || !reference.revision || !reference.encryption) throw new Error('Ungültige Archivdatei.');
      const result = await operations.write({ archive: reference.archive, revision: reference.revision, additions: [{ name: reference.archiveEntry, data, preserveMetadata: true }], policy: 'overwrite', encryption: reference.encryption, password: settings.password }, settings);
      archives.clear();
      for (const [key, view] of views) if (path.resolve(view.locations[key].archive) === path.resolve(reference.archive)) views.delete(key);
      return result;
    },
    async writeArchive(state, request, settings = {}) {
      if (!['pack', 'add', 'remove', 'rename', 'mkdir', 'new-file', 'replace'].includes(request.action)) throw new Error('Ungültige ZIP-Aktion.');
      let archive = request.archive, inside = request.inside || '', revision, sources, remove, rename, additions;
      if (request.path) {
        const current = state.archiveLocations?.[request.path]; if (!current) throw new Error('Die ZIP-Ansicht ist nicht mehr verfügbar.');
        archive = current.archive; revision = current.revision;
        inside = request.path.slice(request.path.indexOf('!') + 1).replace(/^\//, '');
      }
      if (request.action === 'pack' && !request.path && typeof archive === 'string' && !/\.zip$/i.test(archive)) archive += '.zip';
      if (['remove', 'rename'].includes(request.action)) {
        const selected = state.folders[request.path]?.filter(row => request.ids?.includes(row.id)) || [];
        if (!selected.length || selected.length !== new Set(request.ids).size) throw new Error('Ungültige Archivauswahl.');
        if (request.action === 'remove') remove = selected.map(row => row.archiveEntry);
        else {
          if (selected.length !== 1 || typeof request.name !== 'string' || /[\\/]/.test(request.name)) throw new Error('Ungültiger Archivpfad.');
          rename = [{ from: selected[0].archiveEntry, to: [inside, request.name].filter(Boolean).join('/') }];
        }
      } else if (['mkdir', 'new-file', 'replace'].includes(request.action)) additions = [{ name: request.name, data: request.text || '', directory: request.action === 'mkdir' }];
      else {
        const selected = state.folders[request.sourcePath]?.filter(row => request.ids?.includes(row.id)) || [];
        if (!selected.length || selected.length !== new Set(request.ids).size) throw new Error('Ungültige Archivauswahl.');
        if (selected.some(row => row.archive)) {
          const source = state.archiveLocations?.[request.sourcePath];
          if (!source || selected.some(row => row.archive !== source.archive) || request.move) throw new Error('Ungültige Archivauswahl.');
          const prefix = request.sourcePath.slice(request.sourcePath.indexOf('!') + 1).replace(/^\//, '');
          additions = [];
          for await (const reference of archives.entries(source.archive, settings)) {
            if (!selected.some(row => row.archiveEntry === reference.archiveEntry || row.type === 'folder' && reference.archiveEntry.startsWith(row.archiveEntry + '/'))) continue;
            if (reference.revision !== source.revision) throw new Error('Das ZIP-Archiv wurde geändert.');
            if (request.paths === false && reference.directory) continue;
            const name = request.paths === false ? path.posix.basename(reference.archiveEntry) : prefix ? reference.archiveEntry.slice(prefix.length + 1) : reference.archiveEntry;
            additions.push({ name, directory: reference.directory, date: reference.date ? new Date(reference.date) : undefined, data: reference.directory ? undefined : archives.readEntry(reference, settings) });
          }
        } else sources = selected.map(row => row.fsSource);
      }
      const result = await operations.write({ archive, revision, inside, sources, remove, rename, additions, confirmExisting: request.action === 'pack', level: request.level, encryption: request.encryption, password: settings.password, paths: request.paths, recursive: request.recursive, omitRoot: request.omitRoot, move: request.move, verify: request.verify, comment: request.comment, policy: request.policy }, settings);
      archives.clear();
      for (const [key, view] of views) if (path.resolve(view.locations[key].archive) === path.resolve(archive)) views.delete(key);
      return result;
    },
    async apply(before, after, operation) { readonly(before, after); return overlay(await base.apply(real(before), real(after), operation)); },
    async prepare(before, settings) {
      for (const value of settings.directories || []) {
        const archive = archivePath(value);
        if (archive) { const view = await archives.open(archive); if (!Object.hasOwn(view.folders, value)) throw new Error('Dieser Archivordner ist nicht vorhanden.'); views.set(view.path, view); deferredViews = deferredViews.filter(directory => directory !== value); }
      }
      const directories = (settings.directories || []).filter(value => !archivePath(value));
      return directories.length ? overlay(await base.prepare(real(before), { ...settings, directories })) : overlay(real(before));
    },
    async remove(before, request, settings) {
      if (request.paths?.some(archivePath)) throw new Error('Änderungen innerhalb von ZIP-Archiven sind im Pilot nicht verfügbar.');
      return overlay(await base.remove(real(before), request, settings));
    },
    measureFolder: (before, directory, settings) => base.measureFolder(real(before), directory, settings),
    clear() { views.clear(); archives.clear(); operations.clear(); },
    dispose() { views.clear(); archives.dispose(); operations.dispose(); }
  };
}
module.exports = { createZipFilesystem };
