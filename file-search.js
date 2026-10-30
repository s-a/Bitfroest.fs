const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCodepageDecoder } = require('./lister-codepages');
const { archiveEntries, officeText } = require('./search-archives');
const { archivePath } = require('./zip-provider');

const slash = value => value.replaceAll('\\', '/');
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (target, root) => identity(target) === identity(root) || identity(target).startsWith(identity(root).replace(/\/$/, '') + '/');
const abort = signal => { if (signal?.aborted) throw new DOMException('Suche abgebrochen.', 'AbortError'); };
const escapeRegex = value => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const fields = ['name', 'extension', 'path', 'size', 'modified', 'attributes', 'directory'];
const operators = ['=', '!=', '=case', '!=case', '>', '<', '>=', '<=', 'contains', '!contains', 'containsCase', '!containsCase', 'regex'];
function fieldSpec(value) {
  const match = /^\[=tc\.(\w+)(?::(\d+)(?:-(\d+))?)?\]$/.exec(value);
  const field = match ? match[1] : String(value).replace(/^tc\./, '');
  if (!fields.includes(field) || match?.[2] && (Number(match[2]) < 1 || match[3] && Number(match[3]) < Number(match[2]))) throw new Error('Ungültiges Pluginfeld für Dubletten.');
  return { field, start: match?.[2] ? Number(match[2]) - 1 : undefined, end: match?.[3] ? Number(match[3]) : match?.[2] ? Number(match[2]) : undefined };
}

function wildcard(mask) {
  if (mask === '*.*') mask = '*';
  return new RegExp('^' + escapeRegex(mask).replaceAll('**/', '\u0001').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replaceAll('\u0001', '(?:.*/)?') + '$', 'iu');
}
function tokens(value) { return (value.match(/"[^"]*"|[^\s]+/g) || []).map(value => value.replace(/^"(.*)"$/, '$1')); }
function compileName(value = '*', regex = false) {
  if (regex) { const expression = new RegExp(value || '.*', 'iu'); return name => expression.test(path.posix.basename(slash(name))); }
  const [include = '', exclude = ''] = value.split('|');
  const make = text => tokens(slash(text)).filter(mask => !mask.endsWith('/')).map(mask => ({ mask, test: /[*?./]/.test(mask) ? wildcard(mask) : new RegExp(escapeRegex(mask), 'iu') }));
  const inclusions = make(include), exclusions = make(exclude);
  if (!value.includes('|') && include.includes(' ') && !include.includes('"')) inclusions.push({ mask: include, test: /[*?.]/.test(include) ? wildcard(include) : new RegExp(escapeRegex(include), 'iu') });
  return name => {
    name = slash(name);
    const match = item => item.test.test(item.mask.includes('/') ? name : path.posix.basename(name));
    return (!inclusions.length || inclusions.some(match)) && !exclusions.some(match);
  };
}
function hexBytes(value) {
  const bytes = []; let index = 0;
  while (index < value.length) {
    if (/\s/.test(value[index])) { index++; continue; }
    if (value[index] === '"') {
      const end = value.indexOf('"', index + 1); if (end < 0) throw new Error('Ungültige Hex-Suche.');
      bytes.push(...Buffer.from(value.slice(index + 1, end), 'latin1')); index = end + 1;
    } else {
      const pair = value.slice(index, index + 2); if (!/^[\da-f]{2}$/i.test(pair)) throw new Error('Ungültige Hex-Suche.');
      bytes.push(parseInt(pair, 16)); index += 2;
    }
  }
  if (!bytes.length) throw new Error('Die Hex-Suche benötigt mindestens ein Byte.');
  return Buffer.from(bytes);
}
function validateSettings(input = {}) {
  const s = { name: '*', searchIn: '', depth: -1, encodings: ['utf-8'], rules: [], combine: 'and', ...input };
  if (typeof s.name !== 'string' || typeof s.searchIn !== 'string' || !Number.isInteger(Number(s.depth)) || Number(s.depth) < -1) throw new Error('Ungültige Suchparameter.');
  s.depth = Number(s.depth);
  if (s.everything || /^(ev|ed):/i.test(s.name)) throw new Error('Everything ist als Suchanbieter nicht verfügbar.');
  try { compileName(s.name, s.nameRegex); if (s.textEnabled && s.textRegex) new RegExp(s.text || '', s.caseSensitive ? 'u' : 'iu'); }
  catch { throw new Error('Ungültiger regulärer Ausdruck.'); }
  if (s.textEnabled && !s.text) throw new Error('Ein Suchtext ist erforderlich.');
  if (s.textEnabled && s.hex && s.textRegex) throw new Error('Hex und regulärer Ausdruck können nicht gleichzeitig verwendet werden.');
  if (s.textEnabled && s.hex) hexBytes(s.text);
  if (s.textEnabled && !s.hex && (!Array.isArray(s.encodings) || !s.encodings.length || s.encodings.some(x => !['utf-8', 'utf-16le', 'ansi', 'dos'].includes(x)))) throw new Error('Mindestens eine unterstützte Zeichencodierung ist erforderlich.');
  if (!Array.isArray(s.rules) || s.rules.length > 100 || s.rules.some(rule => rule.provider && rule.provider !== 'tc' || !fields.includes(rule.field) || !operators.includes(rule.operator))) throw new Error('Ungültige oder nicht verfügbare Plugin-Eigenschaft.');
  for (const rule of s.rules) if (rule.operator === 'regex') { try { new RegExp(rule.value, 'iu'); } catch { throw new Error('Ungültiger regulärer Ausdruck in Pluginregel.'); } }
  for (const key of ['dateFrom', 'dateTo']) if (s.dateEnabled && s[key] && !Number.isFinite(Date.parse(s[key]))) throw new Error('Ungültige Datumsgrenze.');
  if (s.dateEnabled && s.dateFrom && s.dateTo && Date.parse(s.dateFrom) > Date.parse(s.dateTo)) throw new Error('Der Datumsbereich ist umgekehrt.');
  if (s.sizeEnabled && (!Number.isFinite(Number(s.size)) || Number(s.size) < 0 || ![1, 1024, 1048576, 1073741824].includes(Number(s.sizeUnit || 1)) || !['=', '<', '>'].includes(s.sizeOperator || '='))) throw new Error('Ungültige Dateigröße.');
  for (const key of ['younger', 'older']) if (s[key + 'Enabled'] && (!Number.isFinite(Number(s[key])) || Number(s[key]) < 0)) throw new Error('Ungültiges Dateialter.');
  if (s.duplicates && !s.sameName && !s.sameSize && !s.sameContent && !s.sameFields?.length) throw new Error('Mindestens ein Dublettenkriterium ist erforderlich.');
  for (const field of s.sameFields || []) fieldSpec(field);
  return s;
}
function compare(actual, op, expected) {
  if (['>', '<', '>=', '<='].includes(op)) {
    const a = Number(actual), b = Number(expected); if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
  }
  if (op === 'regex') return new RegExp(expected, 'iu').test(String(actual));
  let a = String(actual), b = String(expected); if (!op.includes('case') && !op.includes('Case')) { a = a.toLowerCase(); b = b.toLowerCase(); }
  const match = op.includes('contains') ? a.includes(b) : a === b;
  return op.startsWith('!') ? !match : match;
}
function property(row, field) {
  const spec = fieldSpec(field), value = ({ name: row.name, extension: path.posix.extname(row.name).slice(1), path: path.posix.dirname(row.fsSource), size: row.size, modified: row.mtimeMs, attributes: row.attributes, directory: row.type === 'folder' })[spec.field];
  return spec.start === undefined ? value : String(value).slice(spec.start, spec.end);
}
function ageBoundary(now, count, unit) {
  const d = new Date(now), n = Number(count);
  if (unit === 'months') d.setMonth(d.getMonth() - n);
  else if (unit === 'years') d.setFullYear(d.getFullYear() - n);
  else d.setTime(d.getTime() - n * ({ hours: 3600000, days: 86400000, weeks: 604800000 }[unit] || 86400000));
  return d.getTime();
}
function metadataMatches(row, s, now) {
  if (s.sizeEnabled && !compare(row.size, s.sizeOperator || '=', Number(s.size) * Number(s.sizeUnit || 1))) return false;
  if (s.dateEnabled && (s.dateFrom && row.mtimeMs < Date.parse(s.dateFrom) || s.dateTo && row.mtimeMs > Date.parse(s.dateTo))) return false;
  if (s.youngerEnabled && row.mtimeMs < ageBoundary(now, s.younger, s.youngerUnit)) return false;
  if (s.olderEnabled && row.mtimeMs >= ageBoundary(now, s.older, s.olderUnit)) return false;
  if (s.attributesEnabled && Object.entries(s.attributes || {}).some(([key, state]) => state !== 'any' && Boolean(row.flags[key]) !== (state === 'yes'))) return false;
  if (s.pluginsEnabled && s.rules.length) {
    const values = s.rules.map(rule => {
      let expected = rule.value;
      if (rule.field === 'size') expected = Number(expected) * ({ bytes: 1, kbytes: 1024, mbytes: 1048576, gbytes: 1073741824 }[String(rule.unit || 'bytes').toLowerCase()] || 1);
      if (rule.field === 'modified' && !Number.isFinite(Number(expected))) { const local = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(expected); expected = local ? new Date(+local[3], +local[2] - 1, +local[1], +(local[4] || 0), +(local[5] || 0), +(local[6] || 0)).getTime() : Date.parse(expected); }
      return compare(property(row, rule.field), rule.operator, expected);
    });
    if (!(s.combine === 'or' ? values.some(Boolean) : values.every(Boolean))) return false;
  }
  return true;
}
function textExpression(s) {
  const literal = s.text.replace(/\\([tn\\])/g, (_, key) => ({ t: '\t', n: '\n', '\\': '\\' })[key]);
  const expr = s.textRegex ? s.text : escapeRegex(literal).replaceAll('*', '\\*').replaceAll('?', '\\?');
  return new RegExp(s.wholeWords ? `(?<![\\p{L}])(?:${expr})(?![\\p{L}])` : expr, s.caseSensitive ? 'u' : 'iu');
}
async function contentMatches(chunks, s, decoder, signal) {
  const needle = s.hex ? hexBytes(s.text) : null, expression = s.hex ? null : textExpression(s);
  const encodings = s.encodings || ['utf-8']; let bytes = Buffer.alloc(0), all = [], found = false;
  const decoders = new Map(encodings.filter(x => !['ansi', 'dos'].includes(x)).map(x => [x, new TextDecoder(x)]));
  const tails = new Map(), precededByLetter = new Map();
  function testHex(data) {
    if (s.caseSensitive) return data.indexOf(needle) >= 0;
    for (let i = 0; i <= data.length - needle.length; i++) if (needle.every((n, j) => data[i + j] === n || n >= 97 && n <= 122 && data[i + j] === n - 32)) return true;
    return false;
  }
  for await (const chunk of chunks) {
    abort(signal);
    if (s.textRegex) { all.push(chunk); continue; }
    if (needle) { bytes = Buffer.concat([bytes, chunk]); if (testHex(bytes)) { found = true; break; } bytes = bytes.subarray(-needle.length); continue; }
    for (const encoding of encodings) {
      const text = (tails.get(encoding) || '') + (encoding === 'ansi' || encoding === 'dos' ? await decoder.text(chunk, encoding === 'ansi' ? '0' : '1') : decoders.get(encoding).decode(chunk, { stream: true }));
      const safe = s.wholeWords ? text.slice(0, -1) : text;
      const prefix = s.wholeWords && precededByLetter.get(encoding) ? 'x' : '';
      const inspected = prefix + text, match = expression.exec(inspected);
      if (match && (!s.wholeWords || match.index + match[0].length < inspected.length)) { found = true; break; }
      const keep = Math.max(16, s.text.length * 2 + 4), start = Math.max(0, text.length - keep);
      precededByLetter.set(encoding, start ? /\p{L}/u.test(text[start - 1]) : precededByLetter.get(encoding));
      tails.set(encoding, text.slice(start));
      if (!s.wholeWords && expression.test(safe)) { found = true; break; }
    }
    if (found) break;
  }
  if (!found && s.textRegex) {
    bytes = Buffer.concat(all);
    for (const encoding of encodings) { const text = await decoder.text(bytes, encoding === 'ansi' ? '0' : encoding === 'dos' ? '1' : encoding); if (expression.test(text)) { found = true; break; } }
  } else if (!found && !needle) for (const encoding of encodings) if (expression.test((s.wholeWords && precededByLetter.get(encoding) ? 'x' : '') + (tails.get(encoding) || '') + (decoders.get(encoding)?.decode() || ''))) { found = true; break; }
  return s.notContaining ? !found : found;
}

async function searchFiles(options, input) {
  const s = validateSettings(input), roots = options.roots.map(root => slash(path.resolve(root))), signal = options.signal;
  if (!s.nameRegex && /^(?:[a-z]:[\\/]|\/)/i.test(s.name)) {
    const namePath = slash(s.name), parts = namePath.split('/');
    const firstMask = parts.findIndex(part => /[*?]/.test(part));
    const split = firstMask >= 0 ? firstMask : parts.length - 1;
    s.searchIn = parts.slice(0, split).join('/') || '/'; s.name = parts.slice(split).join('/');
  }
  const nativeDecoder = createCodepageDecoder(), decoder = { text: (bytes, encoding) => process.platform !== 'win32' && ['0', '1'].includes(encoding) ? Promise.resolve(new TextDecoder(encoding === '0' ? 'windows-1252' : 'ibm866').decode(bytes)) : nativeDecoder.text(bytes, encoding) };
  const results = [], errors = [], seen = new Set(), found = new Set();
  let matches = compileName(s.name, s.nameRegex);
  const now = options.now || Date.now();
  const patterns = s.name.split('|');
  const directoryRules = text => tokens(slash(text || '')).filter(x => x.endsWith('/'));
  const exclusions = directoryRules(patterns[1]), inclusions = directoryRules(patterns[0]);
  const matchDirectory = (relative, mask) => {
    const anchored = mask.startsWith('/'); mask = mask.replace(/^\//, '').replace(/\/$/, '');
    return wildcard(anchored ? mask : '**/' + mask).test(relative);
  };
  async function allowed(value) {
    const target = slash(path.resolve(value));
    if (!roots.some(root => inside(target, root))) throw new Error('Der Suchpfad liegt außerhalb der erlaubten Root-Verzeichnisse.');
    const real = slash(await fs.realpath(target));
    if (identity(real) !== identity(target) || !roots.some(root => inside(real, root))) throw new Error('Symbolische Verknüpfungen werden nicht durchsucht.');
    return target;
  }
  async function candidate(target, stat, start, archiveEntry) {
    const name = archiveEntry?.name || path.posix.basename(target), relative = archiveEntry ? archiveEntry.archiveEntry || archiveEntry.entry : slash(path.relative(start, target));
    const resultIdentity = archiveEntry ? JSON.stringify([identity(archiveEntry.archive), archiveEntry.archiveEntry || archiveEntry.entry]) : identity(target);
    if (!matches(relative || name) || exclusions.includes('/') && !relative.includes('/') || found.has(resultIdentity)) return;
    if (stat.resolveSize) await stat.resolveSize();
    if (inclusions.length && !inclusions.some(mask => matchDirectory(path.posix.dirname(relative), mask.replace('/**/', '/')) || mask.endsWith('/**/') && inside(target, slash(path.resolve(start, mask.slice(0, -4)))))) return;
    const flags = archiveEntry ? { directory: stat.isDirectory(), readonly: false, archive: true, hidden: false, system: false, compressed: true, encrypted: Boolean(archiveEntry.encrypted) } : await options.attributes?.(target, stat) || { directory: stat.isDirectory(), readonly: !(stat.mode & 0o200), archive: stat.isFile(), hidden: process.platform !== 'win32' && name.startsWith('.'), system: false, compressed: false, encrypted: false };
    const row = { id: archiveEntry?.id || `fs:${identity(target)}`, name, type: stat.isDirectory() ? 'folder' : /\.(zip|7z|rar|tar|gz)$/i.test(name) ? 'archive' : /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text', fsSource: target, size: stat.isDirectory() ? 0 : stat.size, mtimeMs: stat.mtimeMs, date: new Date(stat.mtimeMs).toLocaleString('de-DE'), flags, attributes: Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(', '), ...(archiveEntry ? { archive: archiveEntry.archive, entry: archiveEntry.entry, archiveEntry: archiveEntry.archiveEntry || archiveEntry.entry, revision: archiveEntry.revision } : {}) };
    if (!metadataMatches(row, s, now)) return;
    let archiveBytes;
    if (archiveEntry && s.duplicates && s.sameContent) {
      const chunks = []; for await (const chunk of archiveEntry.chunks()) { abort(signal); chunks.push(chunk); }
      archiveBytes = Buffer.concat(chunks); row.contentHash = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    }
    if (s.textEnabled) {
      if (stat.isDirectory()) return;
      const office = !archiveEntry && s.office && /\.(docx|xlsx|pptx|odt|ods|odp|epub)$/i.test(target);
      const handle = archiveEntry || office ? null : await fs.open(target, 'r');
      try { if (!await contentMatches(office ? officeText(target, signal) : archiveEntry ? archiveBytes ? [archiveBytes] : archiveEntry.chunks() : handle.createReadStream({ autoClose: false }), office ? { ...s, encodings: ['utf-8'] } : s, decoder, signal)) return; }
      finally { await handle?.close(); }
    }
    found.add(resultIdentity); results.push(row); options.onResult?.(row);
  }
  async function visit(value, start, depth, direct = false) {
    abort(signal); const target = slash(path.resolve(value)), key = identity(target);
    if (seen.has(key)) return; seen.add(key);
    const stat = await fs.lstat(target); if (stat.isSymbolicLink()) return;
    await allowed(target);
    if (!stat.isDirectory() && !stat.isFile()) return;
    if (stat.isDirectory() && options.skipDirectory?.(target)) return;
    options.onProgress?.({ path: target, count: results.length }); abort(signal);
    if (direct || depth > 0) await candidate(target, stat, start);
    if (stat.isDirectory() && (s.depth < 0 || depth <= s.depth)) {
      for (const item of await fs.readdir(target)) {
        abort(signal); if (options.skipDirectory?.(target)) break;
        const child = `${target}/${item}`, relative = slash(path.relative(start, child));
        if (exclusions.some(mask => matchDirectory(relative, mask))) continue;
        try { await visit(child, start, depth + 1); } catch (error) { if (error.name === 'AbortError') throw error; errors.push({ path: child, error: error.message }); }
      }
    } else if (stat.isFile() && s.archives) {
      for await (const entry of (options.archiveEntries || archiveEntries)(target, signal)) { abort(signal); await candidate(entry.fsSource || `${target}!/${entry.entry}`, entry.stat, start, { ...entry, archive: target }); }
    }
  }
  try {
    let sources = s.selectedOnly ? s.selected || [] : s.inResults || null, fromList = false;
    if (!sources && s.searchIn.startsWith('@')) {
      const list = await allowed(s.searchIn.slice(1)); const bytes = await fs.readFile(list);
      const text = bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? bytes.subarray(3).toString('utf8') : await decoder.text(bytes, '0');
      fromList = true; sources = text.replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean).map(line => slash(path.resolve(path.dirname(list), line)));
      if (s.depth === 0) matches = () => true;
    }
    if (sources) {
      if (!sources.length) throw new Error('Keine Dateien oder Verzeichnisse für die eingeschränkte Suche vorhanden.');
      for (const source of sources) {
        abort(signal); seen.clear(); const previous = matches;
        const reference = typeof source === 'object' ? source : null;
        const providerArchive = typeof source === 'string' ? archivePath(source) : null;
        const separator = typeof source === 'string' ? source.indexOf('!/') : -1;
        const legacy = !providerArchive && separator >= 0 && /\.(zip|tar|gz|tgz|docx|xlsx|pptx|odt|ods|odp|epub)$/i.test(source.slice(0, separator));
        if (reference || providerArchive || legacy) {
          const archive = await allowed(reference?.archive || providerArchive || source.slice(0, separator));
          const name = reference?.archiveEntry || (legacy ? source.slice(separator + 2) : null); let located = false;
          for await (const entry of (options.archiveEntries || archiveEntries)(archive, signal)) {
            if (name ? (entry.archiveEntry || entry.entry) !== name : entry.fsSource !== source) continue;
            if (reference?.revision && reference.revision !== entry.revision) throw new Error('Das ZIP-Archiv wurde geändert.');
            await candidate(entry.fsSource || `${archive}!/${entry.entry}`, entry.stat, path.dirname(archive), { ...entry, archive }); located = true; break;
          }
          if (!located) errors.push({ path: reference?.fsSource || source, error: 'Der Archivtreffer ist nicht mehr vorhanden.' });
          continue;
        }
        const maskAt = source.search(/[*?<]/); const split = maskAt >= 0 ? source.lastIndexOf('/', maskAt) : -1;
        if (fromList && maskAt >= 0 && s.depth === 0) continue;
        const target = await allowed(split >= 0 ? source.slice(0, split) : source);
        const stat = await fs.lstat(target), directory = stat.isDirectory();
        if (fromList && split >= 0) { const mask = source.slice(split + 1); matches = compileName(mask[0] === '<' ? mask.slice(1) : mask, mask[0] === '<'); }
        else if (fromList && (!directory || s.depth === 0)) matches = () => true;
        if (s.depth === 0) await candidate(target, stat, path.dirname(target));
        else await visit(target, directory ? target : path.dirname(target), 0, !directory);
        matches = previous;
      }
    } else for (const source of s.searchIn.split(';').map(x => x.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) { const target = await allowed(source); await visit(target, target, 0); }
    if (!sources && !s.searchIn.trim()) throw new Error('Ein Suchort ist erforderlich.');
    if (s.duplicates) {
      const groups = new Map();
      for (const row of results) {
        abort(signal); if (row.type === 'folder') continue;
        const key = [];
        if (s.sameName) key.push(row.name.toLowerCase()); if (s.sameSize) key.push(row.size);
        if (s.sameContent) { if (row.archive) key.push(row.contentHash); else { const digest = crypto.createHash('sha256'); const handle = await fs.open(row.fsSource, 'r'); try { for await (const chunk of handle.createReadStream({ autoClose: false })) { abort(signal); digest.update(chunk); } } finally { await handle.close(); } key.push(digest.digest('hex')); } }
        for (const field of s.sameFields || []) key.push(property(row, field));
        const id = JSON.stringify(key); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row);
      }
      results.length = 0; let group = 0;
      for (const rows of [...groups.values()].filter(rows => rows.length > 1).sort((a, b) => a[0].name.localeCompare(b[0].name))) { for (const row of rows) results.push({ ...row, group }); group++; }
    }
    return { results, errors };
  } finally { nativeDecoder.dispose(); }
}

module.exports = { searchFiles, compileName, validateSettings, fields, operators, contentMatches };
