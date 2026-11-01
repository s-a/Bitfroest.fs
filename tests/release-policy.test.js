const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releaseContext, targetFor, validatePackageEntries, validateMarketplaceIcon } = require('../scripts/release-policy.cjs');

const manifest = { version: '0.0.28', preview: true };
const lock = { version: '0.0.28', packages: { '': { version: '0.0.28' } } };

function pngHeader(width, height, length = 33) {
  const bytes = Buffer.alloc(length);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('the package gate validates both PNG dimensions and rejects malformed headers', () => {
  for (const dimensions of [[128, 128], [1024, 1024], [128, 1024]]) assert.doesNotThrow(() => validateMarketplaceIcon(pngHeader(...dimensions)));
  for (const dimensions of [[0, 128], [127, 128], [128, 127], [1025, 128], [128, 1025]]) assert.throws(() => validateMarketplaceIcon(pngHeader(...dimensions)), /128|1024/);
  for (const bytes of [Buffer.alloc(10), Buffer.alloc(33), pngHeader(128, 128).subarray(0, 24)]) assert.throws(() => validateMarketplaceIcon(bytes), /PNG/);
});

test('the package gate rejects missing and oversized Marketplace icons at the exact size boundary', () => {
  assert.throws(() => validateMarketplaceIcon(Buffer.alloc(0)), /icon/);
  assert.doesNotThrow(() => validateMarketplaceIcon(pngHeader(128, 128, 1024 * 1024)));
  assert.throws(() => validateMarketplaceIcon(pngHeader(128, 128, 1024 * 1024 + 1)), /1024 KB/);
});

test('version tags must match both package and lockfile versions', () => {
  assert.deepEqual(releaseContext('refs/tags/v0.0.28', manifest, lock), { version: '0.0.28', release: true, prerelease: true });
  assert.throws(() => releaseContext('refs/tags/v0.0.29', manifest, lock), /match/);
  assert.throws(() => releaseContext('refs/tags/v0.0.28', manifest, { ...lock, version: '0.0.27' }), /lock/);
  assert.throws(() => releaseContext('refs/tags/v0.0.28', manifest, { ...lock, packages: { '': { version: '0.0.27' } } }), /lock/);
  for (const ref of ['refs/tags/v01.0.28', 'refs/tags/v0.0.28-beta', 'refs/tags/v0.0.28;echo']) {
    assert.throws(() => releaseContext(ref, manifest, lock), /version tag/);
  }
});

test('branch builds produce artifacts without authorizing a release', () => {
  assert.equal(releaseContext('refs/heads/main', manifest, lock).release, false);
});

test('experimental macOS targets cannot enter regular release assets', () => {
  assert.equal(targetFor('win32', 'x64').release, true);
  assert.equal(targetFor('linux', 'x64').release, true);
  assert.throws(() => targetFor('darwin', 'arm64'), /experimental/);
  assert.equal(targetFor('darwin', 'arm64', true).release, false);
  assert.throws(() => targetFor('win32', 'arm64'), /not configured/);
});

const entries = ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/extension.js', 'extension/native/binding.node', 'extension/node_modules/@zip.js/zip.js/package.json'];
test('packages must contain the native module and the ZIP runtime dependency', () => {
  assert.doesNotThrow(() => validatePackageEntries(entries));
  assert.throws(() => validatePackageEntries(entries.filter(name => !name.endsWith('binding.node'))), /binding/);
  assert.throws(() => validatePackageEntries(entries.filter(name => !name.includes('@zip.js'))), /ZIP/);
});

test('packages reject development files, process helpers and unsafe archive paths', () => {
  for (const extra of ['extension/Docs/Internal/report.md', 'extension/.github/workflows/build.yml', 'extension/native/src/binding.cc', 'extension/scripts/build.cjs', 'extension/tests/example.test.js', 'extension/native/helper.exe', 'extension/native/helper.ps1', 'extension/cache.obj', 'extension/../escape.txt', '/absolute.txt', 'extension\\escape.txt']) {
    assert.throws(() => validatePackageEntries([...entries, extra]), /Unexpected|Unsafe/, extra);
  }
});

test('release publication refuses branch builds before calling a release service', () => {
  const result = spawnSync(process.execPath, ['scripts/publish-release.cjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GH_TOKEN: '' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Only a pushed version tag/);
});

test('release publication rejects tampered or experimental assets before uploading', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'release'));
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const filename = path.join(directory, 'release', `bitfroest-fs-${version}-win32-x64.vsix`);
  fs.writeFileSync(filename, 'changed package');
  for (const experimental of [false, true]) {
    fs.writeFileSync(`${filename}.json`, JSON.stringify({ target: 'win32-x64', version, experimental, commit: 'fixture', sha256: 'incorrect' }));
    const result = spawnSync(process.execPath, ['scripts/publish-release.cjs'], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: directory, GITHUB_REF: `refs/tags/v${version}`, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'fixture', GH_TOKEN: '' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release provenance mismatch/);
  }
});
