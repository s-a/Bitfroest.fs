const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadIconTheme } = require('../icon-theme');

class MockUri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }

  toString() {
    return `file://${this.fsPath.replace(/\\/g, '/')}`;
  }
}

function createVscode(iconTheme, themeText) {
  const root = new MockUri(path.resolve('extension'));
  const extensionUri = new MockUri(path.join(root.fsPath, 'extension'));
  const extension = {
    extensionUri,
    packageJSON: {
      contributes: {
        iconThemes: [{ id: 'sample-theme', path: 'themes/icons.json' }]
      }
    }
  };

  return {
    Uri: {
      joinPath(uri, ...segments) {
        return new MockUri(path.resolve(uri.fsPath, ...segments));
      }
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'workbench');
        return { get: key => key === 'iconTheme' ? iconTheme : undefined };
      },
      fs: {
        async readFile(uri) {
          assert.equal(uri.fsPath, path.join(extensionUri.fsPath, 'themes', 'icons.json'));
          return Buffer.from(themeText);
        }
      }
    },
    extensions: { all: [extension] },
    extensionUri
  };
}

test('returns an empty theme when no icon theme is configured', async () => {
  const vscode = createVscode(undefined, '');

  const theme = await loadIconTheme(vscode);

  assert.deepEqual(theme.roots, []);
  assert.deepEqual(theme.associations, {});
  assert.equal(theme.css({}), '');
});

test('loads icon associations and CSS from a contributed theme', async () => {
  const themeText = `{
    // Theme comments and trailing commas are accepted.
    "iconDefinitions": {
      "fileIcon": { "iconPath": "images/file.svg" },
    },
    "file": "fileIcon",
    "fileExtensions": { "TXT": "fileIcon", "ignored": "unknownIcon" },
  }`;
  const vscode = createVscode('sample-theme', themeText);

  const theme = await loadIconTheme(vscode);

  assert.deepEqual(theme.roots, [vscode.extensionUri]);
  assert.deepEqual(theme.associations.base, {
    file: 'theme-icon-0',
    fileNames: {},
    fileExtensions: { txt: 'theme-icon-0' },
    folderNames: {},
    languageIds: {}
  });
  assert.match(theme.css({ asWebviewUri: uri => ({ toString: () => `webview:${uri.fsPath}` }) }),
    /\.fileicon\.theme-icon-0\{background-image:url\("/);
  assert.deepEqual(theme.associations.light.fileNames, {});
});

function render(theme) {
  const resources = [];
  const css = theme.css({ asWebviewUri(uri) { resources.push(uri.fsPath); return { toString: () => `webview:${uri.fsPath}` }; } });
  return { css, resources };
}

test('returns empty associations when a configured theme is absent or cannot be read', async () => {
  const absent = createVscode('missing', '{}');
  absent.extensions.all.unshift({ packageJSON: {} });
  let theme = await loadIconTheme(absent);
  assert.deepEqual(theme.associations, {});
  const failing = createVscode('sample-theme', '{}');
  failing.workspace.fs.readFile = async () => { throw new Error('unavailable'); };
  theme = await loadIconTheme(failing);
  assert.deepEqual(theme.roots, []);
  assert.equal(theme.css({}), '');
});

test('invalid JSON produces a graceful empty theme', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', '{ unclosed'));
  assert.deepEqual(theme.associations, {});
});

test('JSONC comments do not alter quoted strings, escapes, arrays or BOM', async () => {
  const source = '\uFEFF{ /* comment */ "iconDefinitions": {"one":{"iconPath":"images/a//b\\"c.svg"},}, "fileNames": {"a,b}.txt":"one"}, "fonts": [], } // end';
  const theme = await loadIconTheme(createVscode('sample-theme', source));
  assert.equal(theme.associations.base.fileNames['a,b}.txt'], 'theme-icon-0');
  assert.equal(render(theme).resources.length, 1);
});

test('light and high contrast definitions preserve valid file, folder and language mappings', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', JSON.stringify({
    iconDefinitions: { first: { iconPath: 'first.svg' }, second: { iconPath: 'second.svg' } },
    file: 'first', folder: 'second', folderExpanded: 'first',
    fileNames: { 'PACKAGE.JSON': 'first', ignored: 'missing' },
    folderNames: { 'SRC': 'second' }, languageIds: { TypeScript: 'first' },
    light: { file: 'second', folderNames: { src: 'first' } },
    highContrast: { folder: 'first', fileExtensions: { 'D.TS': 'second' } }
  })));
  assert.equal(theme.associations.base.folderExpanded, 'theme-icon-0');
  assert.deepEqual(theme.associations.base.folderNames, { src: 'theme-icon-1' });
  assert.deepEqual(theme.associations.base.languageIds, { typescript: 'theme-icon-0' });
  assert.equal(theme.associations.light.file, 'theme-icon-1');
  assert.deepEqual(theme.associations.highContrast.fileExtensions, { 'd.ts': 'theme-icon-1' });
  assert.equal(render(theme).resources.length, 2);
});

test('resources outside the extension are excluded from image and font CSS', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', JSON.stringify({
    iconDefinitions: { unsafe: { iconPath: '../../../outside.svg' }, safe: { iconPath: './safe.svg' } },
    file: 'unsafe', fonts: [{ id: 'one', src: [{ path: '../../../../font.woff' }, {}, { path: './safe.woff' }] }]
  })));
  const { css, resources } = render(theme);
  assert.equal(resources.length, 2);
  assert.ok(resources.every(resource => resource.includes(`${path.sep}themes${path.sep}safe.`)));
  assert.ok(!css.includes('.fileicon.theme-icon-0{background-image'));
  assert.match(css, /@font-face/);
});

test('font glyphs use declared font, color and dimensions with safe CSS escaping', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', JSON.stringify({
    fonts: [{ id: 'first', size: '125%', src: [{ path: './font.woff' }] }, { id: 'second', src: [] }],
    iconDefinitions: {
      glyph: { fontCharacter: '\\E001', fontId: 'first', fontColor: '#12ab34', fontSize: '120%' },
      fallback: { fontCharacter: '";}', fontId: 'missing', fontColor: 'red;display:none', fontSize: 'expression(1)' }
    }, file: 'glyph'
  })));
  const { css } = render(theme);
  assert.match(css, /content:"\\e001 "/);
  assert.match(css, /font-size:120%;color:#12ab34;/);
  assert.match(css, /\.fileicon\.themed\{font-size:var\(--icon-size,16px\)/);
  assert.match(css, /content:"\\22 \\3b \\7d "/);
  assert.match(css, /font-size:100%;/);
  assert.ok(!css.includes('display:none;'));
  assert.ok(!css.includes('expression(1)'));
});

test('glyphs without a declared font use a fallback family and size', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', JSON.stringify({
    fonts: {}, iconDefinitions: { bare: { fontCharacter: 'x' }, empty: {} }, file: 'bare'
  })));
  const { css, resources } = render(theme);
  assert.equal(resources.length, 0);
  assert.match(css, /font-size:100%;/);
  assert.ok(!css.includes('@font-face'));
});

test('a missing icon-definition object remains a usable empty theme', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', '{"iconDefinitions":null,"file":"missing"}'));
  assert.deepEqual(theme.associations.base.fileNames, {});
  assert.doesNotThrow(() => render(theme));
});

test('a null icon definition cannot crash CSS generation', async () => {
  const theme = await loadIconTheme(createVscode('sample-theme', JSON.stringify({
    iconDefinitions: { invalid: null, valid: { iconPath: 'valid.svg' } }, file: 'invalid', folder: 'valid'
  })));
  assert.doesNotThrow(() => render(theme));
  assert.equal(theme.associations.base.file, undefined);
});
