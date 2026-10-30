const { parentPort } = require('node:worker_threads');
const word = character => character && /[\p{L}\p{N}\p{M}_]/u.test(character);
parentPort.on('message', ({ text, settings }) => {
  try {
    const escaped = settings.text.replace(/\\(t|n|\\)/g, (_, value) => ({ t: '\t', n: '\n', '\\': '\\' })[value]);
    const pattern = settings.regex ? settings.text : escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(pattern, `gmu${settings.caseSensitive ? '' : 'i'}`);
    let result = null;
    const segments = settings.regex ? text.split(/(?<=\n)|(?<=\r)(?!\n)/) : [text];
    let offset = 0;
    for (const segment of segments) {
      expression.lastIndex = 0;
      for (const match of segment.matchAll(expression)) {
        const start = offset + match.index, end = start + match[0].length;
        if (start < (settings.minIndex || 0) || end > (settings.maxIndex ?? text.length)) continue;
        if (!match[0].length || settings.wholeWords && (word(text[start - 1]) || word(text[end]))) continue;
        result = { start, end };
        if (!settings.backward) break;
      }
      if (result && !settings.backward) break;
      offset += segment.length;
    }
    parentPort.postMessage({ match: result });
  } catch (error) { parentPort.postMessage({ error: `Ungültiger regulärer Ausdruck: ${error.message}` }); }
});
