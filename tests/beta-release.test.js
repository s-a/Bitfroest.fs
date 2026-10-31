const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('Marketplace metadata identifies the extension as a beta preview', () => {
  assert.match(manifest.displayName, /\bBeta\b/);
  assert.equal(manifest.preview, true);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('both Marketplace descriptions start with the beta label', () => {
  for (const file of ['package.nls.json', 'package.nls.de.json']) {
    assert.match(JSON.parse(read(file))['extension.description'], /^Beta\b/);
  }
  assert.match(read('README.md').split('## Development')[0], /\*\*Beta version\*\*/);
});

test('publishing and packaging select the pre-release channel', () => {
  assert.match(manifest.scripts['publish:beta'] || '', /\bvsce publish --pre-release\b/);
  assert.match(manifest.scripts['package:beta'] || '', /\bvsce package --pre-release\b/);
});

test('release packaging resolves product links against the repository and excludes internal documentation', () => {
  assert.equal(manifest.repository.url, 'https://github.com/s-a/Bitfroest.fs.git');
  for (const name of ['package:beta', 'publish:beta']) {
    assert.match(manifest.scripts[name], /--baseContentUrl https:\/\/github\.com\/s-a\/Bitfroest\.fs\/blob\/main\//);
    assert.match(manifest.scripts[name], /--baseImagesUrl https:\/\/raw\.githubusercontent\.com\/s-a\/Bitfroest\.fs\/main\//);
    assert.doesNotMatch(manifest.scripts[name], /--no-rewrite-relative-links/);
  }
  assert.match(read('.vscodeignore'), /^Docs\/\*\*$/m);
  assert.doesNotMatch(read('.vscodeignore'), /^!Docs\//m);
  assert.doesNotMatch(read('README.md'), /\]\(Docs\//);
});

test('Marketplace descriptions warn about data loss and require backups', () => {
  const intro = read('README.md').split('## Beta packaging')[0];
  for (const pattern of [/may contain bugs/, /data loss/, /Git repository/, /committed/, /untracked or ignored files/, /does not replace a backup/, /production data/, /current backup that can be restored/]) {
    assert.match(intro, pattern);
  }
  const de = JSON.parse(read('package.nls.de.json'))['extension.description'];
  const en = JSON.parse(read('package.nls.json'))['extension.description'];
  assert.match(de, /Datenverlust/);
  assert.match(de, /Sicherung/);
  assert.match(en, /data loss/);
  assert.match(en, /backup/);
});
