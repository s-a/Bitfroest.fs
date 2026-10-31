(function (root, factory) {
  const fileNames = typeof module === 'object' && module.exports ? require('./commander-file-names') : root.CommanderFileNames;
  const paths = typeof module === 'object' && module.exports ? require('./commander-paths') : root.CommanderPaths;
  const api = factory(fileNames, paths);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderTransfer = api;
})(typeof globalThis === 'object' ? globalThis : this, function (fileNames, paths) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const join = paths.joinPath;
  const parent = paths.parentPath;
  const base = paths.baseName;
  const validName = name => typeof name === 'string' && Boolean(name.trim()) && !/[\\/:*?"<>|]/.test(name) && !['.', '..'].includes(name) && !/[. ]$/.test(name);
  const sameName = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
  const inTree = (key, value, archive) => {
    if (/^[a-z]:\//i.test(value)) { key = key.toLowerCase(); value = value.toLowerCase(); }
    return key === value || key.startsWith(`${value}/`) || archive && (key === `${value}!` || key.startsWith(`${value}!/`));
  };
  const policies = Object.freeze(['ask', 'overwrite-all', 'skip-all', 'overwrite-older', 'overwrite-older-equal', 'autorename-source', 'autorename-target', 'rename-older-target', 'larger', 'smaller']);
  let sequence = 0;

  function normalizePath(value, source) {
    return paths.normalizePath(value, { base: source, input: true });
  }

  function uniqueName(items, name) {
    const dot = name.lastIndexOf('.');
    let stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    const numbered = /^(.*?) ?\((\d+)\)$/.exec(stem);
    let counter = numbered ? BigInt(numbered[2]) + 1n : 2n, candidate = name;
    if (numbered) stem = numbered[1];
    while (items.some(item => sameName(item.name, candidate))) candidate = `${stem} (${counter++})${extension}`;
    return candidate;
  }

  function matches(name, filter) {
    const [include = '*', exclude = ''] = String(filter || '*').split('|');
    const patterns = value => value.split(/[;,\s]+/).map(item => item.trim()).filter(Boolean);
    const match = pattern => new RegExp('^' + (pattern === '*.*' ? '*' : pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i').test(name);
    return (patterns(include).length ? patterns(include) : ['*']).some(match) && !patterns(exclude).some(match);
  }

  function timestamp(value) {
    const local = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value || '');
    return local ? Date.UTC(Number(local[3]), Number(local[2]) - 1, Number(local[1]), Number(local[4] || 0), Number(local[5] || 0), Number(local[6] || 0)) : Date.parse(value);
  }
  function compareAge(source, target, versions = true) {
    const valid = version => Array.isArray(version) && version.length === 4 && version.every(part => Number.isInteger(part) && part >= 0 && part <= 65535);
    if (versions && valid(source.fileVersion) && valid(target.fileVersion)) {
      for (let index = 0; index < 4; index++) if (source.fileVersion[index] !== target.fileVersion[index]) {
        return Math.sign(source.fileVersion[index] - target.fileVersion[index]);
      }
    }
    return (Number.isFinite(source.mtimeMs) ? source.mtimeMs : timestamp(source.date)) - (Number.isFinite(target.mtimeMs) ? target.mtimeMs : timestamp(target.date));
  }
  function dropMode(modifiers) {
    if ((modifiers.ctrlKey || modifiers.metaKey) && modifiers.shiftKey) return 'link';
    return modifiers.shiftKey || modifiers.altKey ? 'move' : 'copy';
  }
  function applyNameMask(name, mask) {
    const part = (original, pattern, restart = original, prefix = '') => {
      let output = '', position = 0, input = original;
      for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '?') { input = restart; position = 0; index++; }
        else if (character === '*') {
          if (pattern[index + 1] === '*') {
            input = original; position = 0;
            while (pattern[index + 1] === '*') index++;
          }
          output += input.slice(position); position = input.length;
          if (pattern[index + 1] === '.' && (prefix + output).endsWith('.')) index++;
        } else { output += character === '?' ? input[position] || '' : character; position++; }
      }
      return output;
    };
    const dot = mask.indexOf('.'), originalDot = name.lastIndexOf('.');
    const stem = originalDot > 0 ? name.slice(0, originalDot) : name, extension = originalDot > 0 ? name.slice(originalDot + 1) : '';
    if (dot < 0) return part(stem, mask);
    const resultStem = part(stem, mask.slice(0, dot));
    const resultExtension = part(extension, mask.slice(dot + 1), stem, `${resultStem}.`);
    return `${resultStem}.${resultExtension}`.replace(/\.$/, '');
  }
  function planTarget(options) {
    const { folders, sourcePath, ids } = options;
    const selected = (folders[sourcePath] || []).filter(file => ids.includes(file.id));
    const raw = String(options.targetPath || '').trim() || sourcePath;
    const destination = normalizePath(raw, sourcePath), leaf = base(destination);
    const mask = /[*?]/.test(leaf) ? leaf : null;
    const existing = path => Object.keys(folders).find(key => /^[a-z]:\//i.test(path) ? key.toLowerCase() === path.toLowerCase() : key === path);
    const existingDirectory = existing(destination);
    const directoryTarget = existingDirectory || /[\\/]"?$/.test(raw) || selected.length > 1 && !mask;
    let directory = directoryTarget ? destination : parent(destination);
    let name = directoryTarget || mask ? undefined : leaf;
    const known = existing(directory);
    let directories = [];
    if (known) directory = known;
    else {
      const plan = fileNames.plan(directory, { base: sourcePath, folders, kind: 'folder', allowExisting: true });
      directory = plan.paths[0]; directories = plan.directories;
    }
    if (name && !validName(name)) throw new Error('Der neue Dateiname ist ungültig oder bereits vorhanden.');
    if (mask && selected.some(file => !validName(applyNameMask(file.name, mask)))) throw new Error('Der neue Dateiname ist ungültig oder bereits vorhanden.');
    if (selected.some(file => file.type === 'folder' && inTree(directory, join(sourcePath, file.name), false) || file.type === 'archive' && inTree(directory, `${join(sourcePath, file.name)}!`, false))) throw new Error('Das Ziel darf nicht im ausgewählten Quellordner oder Quellarchiv liegen.');
    return { directory, name, mask, directories };
  }

  async function execute(options) {
    const { folders, sourcePath, ids } = options;
    const mode = options.mode === 'move' ? 'move' : 'copy';
    const createId = options.createId || (() => `transfer-${Date.now()}-${++sequence}`);
    const result = { completed: 0, directories: 0, skipped: 0, cancelled: false, errors: [], completedIds: [] };
    let processed = 0;
    const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));
    const cancelled = () => {
      if (options.signal?.aborted) result.cancelled = true;
      return result.cancelled;
    };
    let policy = policies.includes(options.policy) ? options.policy : 'ask';
    if (!folders || !Array.isArray(folders[sourcePath]) || !Array.isArray(ids) || !ids.length || typeof options.targetPath !== 'string') {
      result.errors.push('Quelle, Ziel oder Auswahl sind ungültig.'); return result;
    }
    const selected = folders[sourcePath].filter(item => ids.includes(item.id));
    if (!selected.length) { result.errors.push('Zuerst eine Datei oder einen Ordner auswählen.'); return result; }
    let targetPlan;
    try { targetPlan = planTarget(options); } catch (error) { result.errors.push(error.message); return result; }
    const { directory: destinationDirectory, name: destinationName, mask } = targetPlan;
    fileNames.ensureDirectories(folders, targetPlan.directories, name => ({ id: createId(), name, type: 'folder', size: 0 }));
    result.directories += targetPlan.directories.length;

    function removeTree(value, archive) {
      for (const key of Object.keys(folders)) if (inTree(key, value, archive)) delete folders[key];
    }
    function relocateTree(from, to, archive) {
      const entries = Object.entries(folders).filter(([key]) => inTree(key, from, archive));
      for (const [key] of entries) delete folders[key];
      for (const [key, value] of entries) folders[to + key.slice(from.length)] = value;
    }
    function duplicateTree(from, to, archive) {
      for (const [key, values] of Object.entries(folders).filter(([key]) => inTree(key, from, archive))) folders[to + key.slice(from.length)] = values.map(item => ({ ...clone(item), id: createId() }));
    }
    function removeEntry(directory, file) {
      folders[directory] = folders[directory].filter(item => item !== file);
      removeTree(join(directory, file.name), file.type === 'archive');
    }
    function allowedOverwrite(action, source, target) {
      if (action === 'overwrite-older') return compareAge(source, target) > 0;
      if (action === 'overwrite-older-equal') return compareAge(source, target) >= 0;
      if (action === 'rename-older-target') return compareAge(source, target) > 0;
      if (action === 'larger') return Number(source.size || 0) > Number(target.size || 0);
      if (action === 'smaller') return Number(source.size || 0) < Number(target.size || 0);
      return true;
    }
    async function put(sourceDirectory, source, targetDirectory, requestedName) {
      if (++processed % 64 === 0) await yieldControl();
      if (cancelled()) return;
      const excludedDirectories = String(options.filter || '').split('|')[1]?.split(/[;,\s]+/).filter(pattern => /[\\/]$/.test(pattern)) || [];
      if (source.type === 'folder' && excludedDirectories.some(pattern => matches(source.name, pattern.slice(0, -1)))) { result.skipped++; return; }
      if (source.type !== 'folder' && !matches(source.name, options.filter)) { result.skipped++; return; }
      let name = requestedName || source.name;
      const items = folders[targetDirectory];
      let existing = items.find(item => sameName(item.name, name));
      const samePath = targetDirectory === sourceDirectory && sameName(source.name, name);
      if (samePath && existing === source && mode === 'move' && source.name !== name && !items.some(item => item !== source && sameName(item.name, name))) {
        relocateTree(join(sourceDirectory, source.name), join(targetDirectory, name), source.type === 'archive');
        source.name = name;
        if (source.type === 'folder') result.directories++; else result.completed++;
        return true;
      }
      if (existing && !(existing.type === 'folder' && source.type === 'folder' && !samePath)) {
        if (policy === 'ask') {
          const sourceType = source.type, targetType = existing.type;
          if (await options.onBeforeDecision?.(result) === false || cancelled()) { result.cancelled = true; return; }
          if (!folders[sourceDirectory]?.includes(source) || source.type !== sourceType) throw new Error('Die Quellauswahl wurde während der Übertragung geändert.');
          if (folders[targetDirectory] !== items) throw new Error('Der Zielordner wurde während der Übertragung geändert.');
          existing = items.find(item => sameName(item.name, name));
          if (!existing) return put(sourceDirectory, source, targetDirectory, name);
          if (existing.type !== targetType) throw new Error('Der Zieltyp wurde während der Übertragung geändert.');
        }
        const conflict = { source: clone(source), target: clone(existing), sourcePath: join(sourceDirectory, source.name), targetPath: join(targetDirectory, name), samePath };
        let decision = policy === 'ask' ? await options.onConflict?.(conflict, result) : { action: policy };
        if (policy === 'ask' && Object.values(folders).some(rows => rows.length >= 64)) await yieldControl();
        if (cancelled()) return;
        if (typeof decision === 'string') decision = { action: decision };
        const action = decision?.action || 'cancel';
        if (action === 'cancel') { result.cancelled = true; return; }
        if (policies.includes(action) && action !== 'ask') policy = action;
        if (action === 'skip' || action === 'skip-all' || !allowedOverwrite(action, source, existing)) { result.skipped++; return; }
        if (action === 'rename-source' || action === 'autorename-source') {
          name = action === 'autorename-source' ? uniqueName(items, name) : decision.name;
          if (!validName(name) || items.some(item => sameName(item.name, name))) { result.errors.push('Der neue Dateiname ist ungültig oder bereits vorhanden.'); result.skipped++; return; }
          existing = undefined;
        } else if (action === 'rename-target' || action === 'autorename-target' || action === 'rename-older-target') {
          const renamed = action !== 'rename-target' ? uniqueName(items, name) : decision.name;
          if (samePath || !validName(renamed) || items.some(item => sameName(item.name, renamed))) { result.errors.push('Die Zieldatei kann unter diesem Namen nicht umbenannt werden.'); result.skipped++; return; }
          relocateTree(join(targetDirectory, existing.name), join(targetDirectory, renamed), existing.type === 'archive');
          existing.name = renamed; existing = undefined;
        } else if (samePath) { result.errors.push('Quelle und Ziel sind identisch.'); result.skipped++; return; }
        else if (action === 'append') {
          const real = source.fsSource && existing.fsSource;
          if (['folder', 'archive'].includes(source.type) || ['folder', 'archive'].includes(existing.type) || !real && (typeof source.content !== 'string' || typeof existing.content !== 'string')) { result.errors.push('Anhängen ist nur für Textdateien verfügbar.'); result.skipped++; return; }
          if (real) {
            const previous = existing.fsAppend;
            existing.fsAppend = previous ? { source: previous.source, target: previous.target, sources: [...(previous.sources || [previous.source]), source.fsSource] } : { source: source.fsSource, target: existing.fsSource };
            existing.size = Number(existing.size) + Number(source.size);
            delete existing.content;
          } else {
            existing.content += source.content;
            existing.size = new TextEncoder().encode(existing.content).length;
          }
          if (mode === 'move') removeEntry(sourceDirectory, source);
          result.completed++; return true;
        } else if (!['overwrite', 'overwrite-all', 'overwrite-older', 'overwrite-older-equal', 'larger', 'smaller'].includes(action)) { result.errors.push('Unbekannte Konfliktentscheidung.'); result.skipped++; return; }
        if (existing) { removeTree(join(targetDirectory, existing.name), existing.type === 'archive'); items.splice(items.indexOf(existing), 1); existing = undefined; }
      }
      if (source.type === 'folder') {
        const sourceFolder = join(sourceDirectory, source.name), targetFolder = join(targetDirectory, name);
        if (!existing) { items.push({ ...clone(source), id: createId(), name }); folders[targetFolder] = []; result.directories++; }
        for (const child of [...(folders[sourceFolder] || [])]) { await put(sourceFolder, child, targetFolder, child.name); if (result.cancelled) break; }
        if (mode === 'move' && !(folders[sourceFolder] || []).length && !result.cancelled) removeEntry(sourceDirectory, source);
        return !result.cancelled && (mode === 'copy' || !folders[sourceFolder]);
      } else {
        items.push({ ...clone(source), id: createId(), name });
        if (source.type === 'archive') duplicateTree(`${join(sourceDirectory, source.name)}!`, `${join(targetDirectory, name)}!`, false);
        if (mode === 'move') removeEntry(sourceDirectory, source);
        result.completed++;
        return true;
      }
    }
    for (const item of selected) {
      let name = destinationName || (mask ? applyNameMask(item.name, mask) : item.name);
      if (options.individualNames) {
        if (await options.onBeforeDecision?.(result) === false || cancelled()) { result.cancelled = true; break; }
        if (!folders[sourcePath]?.includes(item)) throw new Error('Die Quellauswahl wurde während der Übertragung geändert.');
        const decision = await options.onRename?.(clone(item), destinationDirectory, result);
        if (cancelled()) break;
        if (!decision || decision.action === 'cancel') { result.cancelled = true; break; }
        if (decision.action === 'skip') { result.skipped++; continue; }
        name = decision.name;
        if (!validName(name) || [...name].some(character => character.charCodeAt(0) < 32) || /^[a-z]:\//i.test(destinationDirectory) && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
          result.errors.push('Der neue Dateiname ist ungültig oder bereits vorhanden.'); result.skipped++; continue;
        }
      }
      if (await put(sourcePath, item, destinationDirectory, name)) result.completedIds.push(item.id);
      if (result.cancelled) break;
    }
    return result;
  }

  return Object.freeze({ execute, uniqueName, matches, normalizePath, policies, dropMode, applyNameMask, planTarget });
});
