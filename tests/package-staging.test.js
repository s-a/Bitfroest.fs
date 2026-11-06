const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stagePackage } = require('../scripts/package-staging.cjs');

test('package staging excludes temporary files while retaining runtime assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfroest-staging-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'stage');
  fs.mkdirSync(path.join(source, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(source, 'media'), { recursive: true });
  fs.writeFileSync(path.join(source, '.tmp', 'test-data'), 'keep');
  fs.writeFileSync(path.join(source, 'node_modules', 'dependency'), 'dependency');
  fs.writeFileSync(path.join(source, 'media', 'asset'), 'asset');
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  stagePackage(source, target);
  assert.equal(fs.existsSync(path.join(target, '.tmp')), false);
  assert.equal(fs.readFileSync(path.join(source, '.tmp', 'test-data'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(target, 'media', 'asset'), 'utf8'), 'asset');
  assert.equal(fs.readFileSync(path.join(target, 'node_modules', 'dependency'), 'utf8'), 'dependency');
});
