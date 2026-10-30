const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');

function fixture(t, options = {}) {
  const target = path.join(root, 'license-information.js');
  assert.ok(fs.existsSync(target), 'license information provider exists');
  const { createLicenseInformation } = require(target);
  const calls = [], documents = [], errors = [];
  let registration;
  const vscode = {
    Uri: { parse: value => ({ toString: () => value }) },
    workspace: {
      registerTextDocumentContentProvider(scheme, provider) { registration = { scheme, provider, disposed: false }; return { dispose() { registration.disposed = true; } }; },
      async openTextDocument(uri) { const document = { uri }; documents.push(document); return document; }
    },
    commands: { async executeCommand(id, ...args) { calls.push({ id, args }); if (options.previewError) throw new Error('Preview unavailable'); } },
    window: { async showTextDocument(...args) { calls.push({ id: 'showTextDocument', args }); }, async showErrorMessage(message) { errors.push(message); } }
  };
  const view = createLicenseInformation(vscode, { extensionPath: options.extensionPath || root, language: () => options.language || 'de' });
  t.after(() => view.dispose());
  return { view, calls, documents, errors, registration };
}

test('license credits contain the project author, complete required notices and localized summaries', async t => {
  for (const language of ['de', 'en']) {
    const app = fixture(t, { language });
    await app.view.open();
    const uri = app.calls.find(call => call.id === 'markdown.showPreview').args[0];
    assert.equal(app.registration.scheme, 'bitfroest-licenses');
    const content = app.registration.provider.provideTextDocumentContent(uri);
    assert.match(content, language === 'de' ? /Lizenzen und Danksagungen/ : /Licenses and acknowledgements/);
    const manifest = require('../package.json');
    const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
    assert.ok(author, 'the credited project author must be configured');
    assert.ok(content.includes(author));
    for (const name of ['Apache-2.0', 'Microsoft', 'CC BY 4.0', 'Gildas Lormeau', 'Jean-loup Gailly', 'Mark Adler', 'Chromium', 'JCraft']) assert.ok(content.includes(name), name);
    assert.match(content, /https:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/);
    for (const name of ['LICENSE', 'NOTICE', 'WORKBENCH-NOTICES.txt', 'licenses/CODICONS-CC-BY-4.0.txt', 'licenses/ZIP-BSD-3-Clause.txt', 'licenses/ZLIB-STREAMS.txt', 'licenses/ZLIB-STREAMS-TS.txt', 'licenses/JZLIB.txt', 'licenses/EMSCRIPTEN.txt', 'licenses/MUSL.txt']) {
      const text = fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '').trim();
      assert.ok(content.includes(text), `complete offline text: ${name}`);
    }
    assert.doesNotMatch(content, /jsdom|eslint|@eslint|\bc8\b/);
    assert.equal(app.documents.length, 0, 'the native preview resolves the readonly provider');
    app.view.dispose(); assert.equal(app.registration.disposed, true);
  }
});

test('license preview failure falls back to the same readonly document', async t => {
  const app = fixture(t, { previewError: true });
  await app.view.open();
  assert.equal(app.documents.length, 1);
  assert.equal(app.calls.at(-1).id, 'showTextDocument');
  assert.equal(app.calls.at(-1).args[0], app.documents[0]);
  assert.equal(app.calls[0].args[0].toString(), app.documents[0].uri.toString());
  assert.deepEqual(app.errors, []);
});

test('license provider rejects unknown resources without reading arbitrary paths', t => {
  const app = fixture(t);
  for (const value of ['file:///LICENSE', 'bitfroest-licenses:/../../package.json', 'bitfroest-licenses:/unknown.md']) {
    assert.throws(() => app.registration.provider.provideTextDocumentContent({ toString: () => value }), /resource|Ressource/i);
  }
});

test('packaged credits accept the license filename normalized by the packager', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'license-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'licenses'));
  fs.writeFileSync(path.join(directory, 'licenses/components.json'), '[]');
  for (const file of ['package.json', 'NOTICE']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE.txt'));
  const app = fixture(t, { extensionPath: directory });
  await app.view.open();
  const uri = app.calls[0].args[0];
  const content = app.registration.provider.provideTextDocumentContent(uri);
  assert.match(content, /Apache License/);
  assert.ok(content.includes(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim()));
});
