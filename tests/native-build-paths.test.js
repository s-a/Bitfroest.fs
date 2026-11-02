const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '../scripts/check-native-build.cjs');
for (const encoding of ['utf8', 'utf16le']) for (const home of ['C:\\Users\\build-user', '/home/build-user', '/Users/build-user', os.homedir()]) {
  test(`native build rejects embedded profile paths in ${encoding}: ${home === os.homedir() ? 'current profile' : home.split(/[\\/]/).at(-2)}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-paths-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const binary = path.join(root, 'binding.node'); fs.writeFileSync(binary, Buffer.from(`${home}/dependency/alloc.h\0`, encoding));
    const result = spawnSync(process.execPath, [script, binary], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /build-user directory/); assert.equal(result.stderr.includes(home), false);
  });
}
test('native build accepts source identifiers outside user profiles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-paths-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'binding.node'); fs.writeFileSync(binary, Buffer.from('C:\\compiled\\libgit2\\src\\util\\alloc.h\0src/util/errors.c\0'));
  const result = spawnSync(process.execPath, [script, binary], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
});
