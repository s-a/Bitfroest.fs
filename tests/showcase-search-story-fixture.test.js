const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSearchStoryFixture } = require('../scripts/showcases/search-story-fixture.cjs');

test('search story creates a bounded fixture and verifies the actual result and file', async t => {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'search-story-'));
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  const fixture = await createSearchStoryFixture(run);
  assert.equal(path.dirname(fixture.root), await fs.realpath(run));
  assert.equal(await fs.readFile(path.join(fixture.root, '.showcase-search'), 'utf8').then(Boolean), true);
  assert.equal(path.dirname(fixture.file), path.join(fixture.left, 'documents'));
  assert.match(await fs.readFile(fixture.file, 'utf8'), /delivery date/);
  await fixture.verify([fixture.file]);
  await assert.rejects(fixture.verify([]), /Unexpected search results/);
  await assert.rejects(fixture.verify([fixture.file, path.join(run, 'elsewhere')]), /Unexpected search results/);
  await fs.writeFile(fixture.file, 'changed');
  await assert.rejects(fixture.verify([fixture.file]), /changed/);
});

test('fixtures are fresh, isolated and clean up only their own files', async t => {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'search-story-'));
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  const fixture = await createSearchStoryFixture(run);
  const other = await createSearchStoryFixture(run);
  assert.notEqual(fixture.root, other.root);
  await fixture.verify([fixture.file]);
  await fixture.cleanup();
  await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
  await other.verify([other.file]);
  await other.cleanup();
});

test('cleanup rejects foreign entries and replaced files without deleting them', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-search-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = await createSearchStoryFixture(parent), extra = path.join(fixture.left, 'foreign.txt');
  await fs.writeFile(extra, 'leave alone');
  await assert.rejects(fixture.cleanup(), /Unexpected files/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'leave alone');
  await fs.unlink(extra);
  const saved = path.join(parent, 'saved-original');
  await fs.rename(fixture.file, saved); await fs.writeFile(fixture.file, await fs.readFile(saved));
  await assert.rejects(fixture.verify([fixture.file]), /identity changed/);
  await assert.rejects(fixture.cleanup(), /identity changed/);
  await fs.unlink(fixture.file); await fs.rename(saved, fixture.file);
  await fixture.cleanup();
});
