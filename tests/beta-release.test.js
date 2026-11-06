const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('the actual Marketplace icon fits the one MiB upload limit', () => {
  assert.ok(fs.statSync(path.join(root, manifest.icon)).size <= 1024 * 1024, 'Marketplace rejects icons larger than 1024 KB');
});

test('the actual Marketplace PNG icon fits the supported pixel dimensions', () => {
  const bytes = fs.readFileSync(path.join(root, manifest.icon));
  for (const dimension of [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]) {
    assert.ok(dimension >= 128 && dimension <= 1024, `Marketplace icon dimension ${dimension} must be between 128 and 1024 pixels`);
  }
});

test('Marketplace metadata identifies the extension as a beta preview', () => {
  assert.match(manifest.displayName, /\bBeta\b/);
  assert.equal(manifest.preview, true);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('localized Marketplace summaries lead with the file manager features', () => {
  const key = manifest.description.match(/^%([^%]+)%$/)?.[1];
  assert.ok(key, 'the manifest must reference a localized description');
  for (const [file, features, warning] of [
    ['package.nls.json', /side by side.*VS Code.*tabs.*search.*Git/i, /\b(?:beta|data loss|backup)\b/i],
    ['package.nls.de.json', /nebeneinander.*VS Code.*Tab.*Suche.*Git/i, /\b(?:beta|Datenverlust|Sicherung)\b/i],
  ]) {
    const description = JSON.parse(read(file))[key];
    assert.match(description, features, file);
    assert.doesNotMatch(description, warning, file);
  }
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

test('the Marketplace README identifies the beta and explains data loss and backup requirements', () => {
  const intro = read('README.md').split('## Beta packaging')[0];
  assert.match(intro, /\*\*Beta version\*\*/);
  for (const pattern of [/may contain bugs/, /data loss/, /Git repository/, /committed/, /untracked or ignored files/, /does not replace a backup/, /production data/, /current backup that can be restored/]) {
    assert.match(intro, pattern);
  }
});
