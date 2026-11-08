const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');

function scriptExtension(platform) {
  return platform === 'win32' ? '.ps1' : '.sh';
}

async function isScript(file, platform) {
  const extension = path.extname(file);
  if ((platform === 'win32' ? extension.toLowerCase() : extension) !== scriptExtension(platform)) return false;
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    if (platform !== 'win32') await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findScripts(pathValue, platform, stopped = () => false) {
  const entries = new Map();
  const seen = new Set();
  const windows = platform === 'win32';
  const key = file => windows ? file.toLowerCase() : file;
  for (const entry of (pathValue || '').split(windows ? ';' : ':')) {
    if (stopped()) break;
    const directory = path.normalize(windows ? entry.replace(/^"(.*)"$/, '$1') : entry);
    if (!path.isAbsolute(directory) || seen.has(key(directory))) continue;
    seen.add(key(directory));
    const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (stopped()) break;
      if (!file.isFile() && !file.isSymbolicLink()) continue;
      const fullPath = path.join(directory, file.name);
      if (await isScript(fullPath, platform)) {
        entries.set(key(fullPath), { label: file.name, description: directory, path: fullPath });
      }
    }
  }
  return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Recognize literal declarations only. Strings and comments are kept out of
// structural matching, and expressions are never evaluated.
function inspectParameters(source) {
  const lexemes = [...source.matchAll(/<#(?:[\s\S]*?#>|[\s\S]*$)|#[^\r\n]*|@['"]\r?\n[\s\S]*?(?:^['"]@|$)|'(?:[^']|'')*'|"(?:[^"\x60]|\x60[\s\S])*"|\x60\r?\n|\$[\w:]+|[\w-]+|[^\s]/gm)]
    .filter(([token]) => !token.startsWith('#') && !token.startsWith('<#') && !token.startsWith('\x60\n') && !token.startsWith('\x60\r\n'));
  const tokens = lexemes.map(([token]) => token);
  const lower = tokens.map(token => token.toLowerCase());
  let index = 0;
  while (lower[index] === 'using' && ['namespace', 'module', 'assembly'].includes(lower[index + 1])) {
    const start = index;
    do {
      const previous = lexemes[index++];
      if (previous[0] === ';' || /[\r\n]/.test(source.slice(previous.index + previous[0].length, lexemes[index]?.index))) break;
    } while (index < tokens.length);
    if (index <= start + 2) break;
  }
  let defaultSet;
  const parameters = [];
  const result = () => ({ parameters, defaultSet });
  const literal = token => {
    if (/^'[^']*'$/.test(token || '') || /^"[^"$\x60]*"$/.test(token || '')) return token.slice(1, -1);
    return undefined;
  };
  function group() {
    const opening = tokens[index++];
    const closing = { '[': ']', '(': ')', '{': '}' }[opening];
    const contents = [];
    while (index < tokens.length && tokens[index] !== closing) {
      if (['[', '(', '{'].includes(tokens[index])) {
        const start = index;
        if (!group()) return undefined;
        contents.push(...tokens.slice(start, index));
      } else contents.push(tokens[index++]);
    }
    if (tokens[index++] === closing) return contents;
    return undefined;
  }
  function namedValue(attribute, name) {
    const position = attribute.findIndex((token, i) => token.toLowerCase() === name && attribute[i + 1] === '=');
    return position < 0 ? undefined : attribute[position + 2];
  }
  while (tokens[index] === '[') {
    const attribute = group();
    if (!attribute) return result();
    if (attribute[0]?.toLowerCase() === 'cmdletbinding') defaultSet = literal(namedValue(attribute, 'defaultparametersetname'));
  }
  if (lower[index] !== 'param' || tokens[index + 1] !== '(') {
    return result();
  }
  index += 2;
  while (index < tokens.length && tokens[index] !== ')') {
    const parameter = { sets: [], switch: false };
    while (tokens[index] === '[') {
      const attribute = group();
      if (!attribute) return result();
      const name = attribute[0]?.toLowerCase();
      if (name === 'parameter') {
        const set = literal(namedValue(attribute, 'parametersetname'));
        const mandatory = namedValue(attribute, 'mandatory');
        const implicit = !mandatory && attribute.some((token, i) => token.toLowerCase() === 'mandatory' &&
          ['(', ','].includes(attribute[i - 1]) && [')', ','].includes(attribute[i + 1]));
        parameter.sets.push({ name: set, mandatory: implicit || mandatory?.toLowerCase() === '$true' });
      } else if (name === 'validateset' && attribute[1] === '(' && attribute.at(-1) === ')') {
        const choices = attribute.slice(2, -1);
        if (choices.length && choices.every((token, i) => i % 2 ? token === ',' : literal(token) !== undefined) && choices.length % 2) {
          parameter.choices = choices.filter((_, i) => i % 2 === 0).map(literal);
        }
      } else if (name === 'switch' || name === 'switchparameter') parameter.switch = true;
    }
    if (!/^\$[\w]+$/.test(tokens[index] || '')) return result();
    parameter.name = tokens[index++].slice(1);
    if (tokens[index] === '=') {
      index++;
      while (index < tokens.length && ![',', ')'].includes(tokens[index])) {
        if (['[', '(', '{'].includes(tokens[index])) {
          if (!group()) return result();
        } else index++;
      }
    }
    if (![',', ')'].includes(tokens[index])) return result();
    parameters.push(parameter);
    if (tokens[index] === ',') index++;
  }
  return result();
}

function rankHistory(history, recent = false) {
  return [...history].sort((a, b) => (recent ? b[2] - a[2] || b[1] - a[1] : b[1] - a[1] || b[2] - a[2]) ||
    a[0].localeCompare(b[0])).map(entry => entry[0]);
}

async function listHistoryScripts(history, platform) {
  const items = [];
  for (const file of rankHistory(history)) {
    if (await isScript(file, platform)) items.push({ path: file, label: path.basename(file), description: path.dirname(file) });
  }
  return items;
}

function createScriptHistory(storage) {
  const directory = path.join(storage, 'script-history');
  const file = path.join(directory, randomUUID() + '.json');
  const counts = new Map();
  let pending = Promise.resolve();
  return {
    async read() {
      const totals = new Map();
      const files = await fs.readdir(directory).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const name of files.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const entries = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
        for (const [script, count, last] of entries) {
          const key = process.platform === 'win32' ? script.toLowerCase() : script;
          const previous = totals.get(key) || [script, 0, 0];
          totals.set(key, [last >= previous[2] ? script : previous[0], previous[1] + count, Math.max(previous[2], last)]);
        }
      }
      return [...totals.values()];
    },
    record(script) {
      const write = pending.then(async () => {
        await fs.mkdir(directory, { recursive: true });
        const key = process.platform === 'win32' ? script.toLowerCase() : script;
        const next = new Map(counts);
        next.set(key, [script, (counts.get(key)?.[1] || 0) + 1, Date.now()]);
        await fs.writeFile(file + '.tmp', JSON.stringify([...next.values()]));
        for (let attempt = 0; ; attempt++) {
          try {
            await fs.rename(file + '.tmp', file);
            break;
          } catch (error) {
            if (attempt === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
            await delay(20 * (attempt + 1));
          }
        }
        counts.set(key, next.get(key));
      });
      pending = write.catch(() => {});
      return write;
    },
  };
}

async function shellArguments(window, t) {
  const args = [];
  for (;;) {
    const run = t(args.length ? 'Ausführen' : 'Ohne Parameter starten');
    const options = [run, t('Argument hinzufügen')];
    const choice = await window.showQuickPick(options, { title: t('Skriptargumente') });
    if (choice === undefined) return undefined;
    if (choice === run) return args;
    const value = await window.showInputBox({ title: t('Argument hinzufügen') });
    if (value === undefined) return undefined;
    args.push(value);
  }
}

async function powerShellArguments(window, t, metadata) {
  const { parameters, defaultSet } = metadata;
  if (!parameters.length) return [];
  const mode = await window.showQuickPick([
    { label: t('Ohne Parameter starten') },
    { label: t('Deklarierte Parameter'), detail: parameters.map(parameter => '-' + parameter.name).join(', '), form: true },
  ], { title: t('Skriptargumente') });
  if (!mode) return undefined;
  if (!mode.form) return [];
  const sets = [...new Set(parameters.flatMap(parameter => parameter.sets.map(set => set.name)
    .filter(name => name && name !== '__AllParameterSets')))];
  if (defaultSet && sets.includes(defaultSet)) sets.unshift(...sets.splice(sets.indexOf(defaultSet), 1));
  const set = sets.length > 1 ? await window.showQuickPick(sets, { title: t('Parametersatz') }) : sets[0];
  if (sets.length > 1 && set === undefined) return undefined;
  const args = [];
  for (const parameter of parameters) {
    const applicable = parameter.sets.filter(rule => !rule.name || rule.name === '__AllParameterSets' || rule.name === set);
    if (parameter.sets.length && !applicable.length) continue;
    const required = applicable.some(rule => rule.mandatory);
    const title = '-' + parameter.name + (required ? ' (' + t('Pflichtfeld') + ')' : '');
    if (parameter.switch || parameter.choices) {
      const options = parameter.switch
        ? [{ label: t('Ein'), value: true }, { label: t('Aus'), value: false }]
        : parameter.choices.map(value => ({ label: value || '""', value }));
      if (!required) options.unshift({ label: t('Standardwert verwenden') });
      const choice = await window.showQuickPick(options, { title });
      if (!choice) return undefined;
      if (Object.hasOwn(choice, 'value')) args.push({ name: parameter.name, value: choice.value });
    } else {
      const value = await window.showInputBox({ title, validateInput: value => required && value === '' ? t('Pflichtfeld') : undefined });
      if (value === undefined) return undefined;
      if (value !== '') args.push({ name: parameter.name, value });
    }
  }
  return args;
}

async function pickScript(window, t, load) {
  const picker = window.createQuickPick();
  picker.title = t('Skript auswählen');
  picker.placeholder = t('Skriptname eingeben');
  const selected = await new Promise(resolve => {
    let closed = false;
    let failure;
    const accept = picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item) { resolve({ item }); picker.hide(); }
    });
    const hide = picker.onDidHide(() => {
      closed = true;
      accept.dispose();
      hide.dispose();
      picker.dispose();
      resolve({ failure });
    });
    picker.show();
    if (closed) return;
    load(() => closed).then(items => {
      if (!closed) {
        picker.items = items;
        if (items.length && !picker.value) picker.activeItems = [items[0]];
        picker.placeholder = items.length ? t('Skriptname eingeben') : t('Keine Skripte gefunden.');
      }
    }, error => {
      if (!closed) { failure = error; picker.hide(); }
    });
  });
  if (selected.failure) throw selected.failure;
  return selected.item;
}

function scriptSource(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  return buffer.toString('utf8');
}

async function runScriptPicker({ window, translate: t, launch, directory, platform, pathValue, history = [], selected, record }) {
  const item = selected || await pickScript(window, t, async stopped => {
    const items = await findScripts(pathValue, platform, stopped);
    const key = file => platform === 'win32' ? file.toLowerCase() : file;
    const order = new Map(rankHistory(history, true).map((file, index) => [key(file), index]));
    return items.sort((a, b) => (order.get(key(a.path)) ?? Infinity) - (order.get(key(b.path)) ?? Infinity) || a.label.localeCompare(b.label));
  });
  if (!item) return;
  const validate = async () => {
    if (!await isScript(item.path, platform)) throw new Error('Das Skript ist nicht mehr verfügbar.');
    if (!(await fs.stat(directory).catch(() => null))?.isDirectory()) throw new Error('Ungültiger Ordnerpfad.');
  };
  await validate();
  const args = platform === 'win32'
    ? await powerShellArguments(window, t, inspectParameters(scriptSource(await fs.readFile(item.path))))
    : await shellArguments(window, t);
  if (!args) return;
  await validate();
  await launch(directory, { path: item.path, args });
  try {
    await record(item.path);
  } catch (error) {
    throw new Error('Skript an Terminal übergeben. Der Verlauf konnte nicht gespeichert werden.', { cause: error });
  }
  return true;
}

module.exports = { createScriptHistory, findScripts, inspectParameters, listHistoryScripts, rankHistory, runScriptPicker };
