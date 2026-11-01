const path = require('node:path');
const { defaults: iconLayoutDefaults } = require('./media/icon-layout');

function parseTheme(text) {
  let result = '', quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index], next = text[index + 1];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index++; result += '\n'; }
    else if (char === '/' && next === '*') { index += 2; while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++; index++; }
    else result += char;
  }
  let cleaned = '';
  quoted = false; escaped = false;
  for (let index = 0; index < result.length; index++) {
    const char = result[index];
    if (quoted) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; cleaned += char; }
    else if (char === ',' && /^[\s]*[}\]]/.test(result.slice(index + 1))) continue;
    else cleaned += char;
  }
  return JSON.parse(cleaned.replace(/^\uFEFF/, ''));
}

async function loadIconTheme(vscode) {
  const empty = { roots: [], associations: {}, css: () => '' };
  const id = vscode.workspace.getConfiguration('workbench').get('iconTheme');
  if (!id) return empty;
  const extension = vscode.extensions.all.find(item => item.packageJSON.contributes?.iconThemes?.some(theme => theme.id === id));
  if (!extension) return empty;
  try {
    const contribution = extension.packageJSON.contributes.iconThemes.find(theme => theme.id === id);
    const themeUri = vscode.Uri.joinPath(extension.extensionUri, contribution.path);
    const theme = parseTheme(Buffer.from(await vscode.workspace.fs.readFile(themeUri)).toString('utf8'));
    const directory = vscode.Uri.joinPath(themeUri, '..');
    const root = extension.extensionUri;
    function resource(relative) {
      const uri = vscode.Uri.joinPath(directory, relative);
      const remainder = path.relative(root.fsPath, uri.fsPath);
      return remainder.startsWith('..') || path.isAbsolute(remainder) ? null : uri;
    }
    const definitions = Object.fromEntries(Object.entries(theme.iconDefinitions || {}).filter(([, definition]) => definition && typeof definition === 'object' && !Array.isArray(definition)));
    const names = Object.keys(definitions);
    const classes = Object.fromEntries(names.map((name, index) => [name, `theme-icon-${index}`]));
    const associations = {};
    for (const variant of ['base', 'light', 'highContrast']) {
      const source = variant === 'base' ? theme : theme[variant] || {};
      const target = {};
      for (const field of ['file', 'folder', 'folderExpanded']) if (source[field] && classes[source[field]]) target[field] = classes[source[field]];
      for (const field of ['fileNames', 'fileExtensions', 'folderNames', 'languageIds']) {
        target[field] = Object.fromEntries(Object.entries(source[field] || {}).filter(([, value]) => classes[value]).map(([key, value]) => [key.toLowerCase(), classes[value]]));
      }
      associations[variant] = target;
    }
    const fonts = Array.isArray(theme.fonts) ? theme.fonts : [];
    const fontNames = Object.fromEntries(fonts.map((font, index) => [font.id, `file-theme-font-${index}`]));
    function quoted(value) { return '"' + [...String(value)].map(char => `\\${char.codePointAt(0).toString(16)} `).join('') + '"'; }
    function dimension(value, fallback) { return /^\d+(?:\.\d+)?(?:px|em|%)$/.test(value || '') ? value : fallback; }
    return {
      roots: [root], associations,
      css(webview) {
        const rules = [`.fileicon.themed{font-size:var(--icon-size,${iconLayoutDefaults.size}px);background-repeat:no-repeat;background-position:center;background-size:contain;position:relative}.fileicon.themed::before,.fileicon.themed::after{display:none}`];
        for (const font of fonts) {
          const sources = (font.src || []).map(source => {
            const uri = source.path && resource(source.path);
            return uri ? `url(${quoted(webview.asWebviewUri(uri).toString())})` : null;
          }).filter(Boolean);
          if (sources.length) rules.push(`@font-face{font-family:${quoted(fontNames[font.id])};src:${sources.join(',')};font-weight:normal;font-style:normal;font-display:block}`);
        }
        for (const name of names) {
          const definition = definitions[name], selector = `.fileicon.${classes[name]}`;
          if (definition.iconPath) {
            const uri = resource(definition.iconPath);
            if (uri) rules.push(`${selector}{background-image:url(${quoted(webview.asWebviewUri(uri).toString())})}`);
          } else if (definition.fontCharacter) {
            const font = fonts.find(item => item.id === definition.fontId) || fonts[0];
            const glyph = definition.fontCharacter.replace(/\\([a-f\d]{1,6})/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
            const color = /^#[a-f\d]{3,8}$/i.test(definition.fontColor || '') ? `color:${definition.fontColor};` : '';
            rules.push(`${selector}::before{display:block;position:static;border:0;width:auto;height:auto;content:${quoted(glyph)};font-family:${quoted(fontNames[font?.id] || 'inherit')};font-size:${dimension(definition.fontSize || font?.size, '100%')};${color}}`);
          }
        }
        return rules.join('\n');
      }
    };
  } catch {
    return empty;
  }
}

module.exports = { loadIconTheme };
