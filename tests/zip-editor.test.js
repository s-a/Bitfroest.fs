const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-editor-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = [], prompts = [], retained = [];
  const { createZipEditor } = require('../zip-editor');
  const editor = createZipEditor({ temporaryRoot: root, read: async function* () { yield Buffer.from('original'); },
    confirm: async reference => { prompts.push(reference); return options.confirm !== false; },
    write: async (reference, data, settings) => { writes.push({ reference: { ...reference }, data: Buffer.from(data), settings }); if (options.failure) { const error = new Error(options.failure); if (options.committed) error.committedResult = { revision: 'new-revision', committed: true }; throw error; } return { revision: 'new-revision' }; },
    retain: value => retained.push(value) });
  t.after(() => editor.dispose());
  const reference = { archive: path.join(root, 'archive.zip'), archiveEntry: 'docs/file.txt', revision: 'original-revision', name: 'file.txt', encrypted: true };
  return { root, editor, reference, writes, prompts, retained };
}

test('ZIP-F07 editor reads only the selected entry and confirms changed content before repacking', async t => {
  const { editor, reference, writes, prompts } = await fixture(t);
  const target = await editor.open(reference); assert.equal(await fs.readFile(target, 'utf8'), 'original');
  await editor.saved(target); assert.equal(prompts.length, 0); assert.equal(writes.length, 0);
  await fs.writeFile(target, 'changed'); await editor.saved(target);
  assert.equal(prompts.length, 1); assert.equal(writes[0].reference.revision, 'original-revision'); assert.equal(writes[0].data.toString(), 'changed');
  await fs.writeFile(target, 'again'); await editor.saved(target); assert.equal(writes[1].reference.revision, 'new-revision');
  await editor.close(target); await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('ZIP-F07 declined repacking retains the edited file when its editor closes', async t => {
  const { editor, reference, writes, retained } = await fixture(t, { confirm: false });
  const target = await editor.open(reference); await fs.writeFile(target, 'keep my work'); await editor.saved(target); await editor.close(target);
  assert.equal(writes.length, 0); assert.equal(await fs.readFile(target, 'utf8'), 'keep my work'); assert.deepEqual(retained, [target]);
});

test('ZIP-F07 failed repacking preserves the working copy and keeps the original revision', async t => {
  const { editor, reference, writes, retained } = await fixture(t, { failure: 'archive changed' });
  const target = await editor.open(reference); await fs.writeFile(target, 'keep my work');
  await assert.rejects(editor.saved(target), /archive changed/); await assert.rejects(editor.saved(target), /archive changed/);
  assert.ok(writes.every(write => write.reference.revision === 'original-revision'));
  await editor.dispose(); assert.equal(await fs.readFile(target, 'utf8'), 'keep my work'); assert.deepEqual(retained, [target]);
});

test('ZIP-F07 closing an unchanged working copy cleans it and disposal refuses new edits', async t => {
  const { editor, reference } = await fixture(t); const target = await editor.open(reference);
  await editor.dispose(); await assert.rejects(fs.stat(target), { code: 'ENOENT' }); await assert.rejects(editor.open(reference), /geschlossen/);
});

test('ZIP editor forwards integrity-test password prompts and tracks a committed revision after verification failure', async t => {
  const { editor, reference, writes, retained } = await fixture(t, { failure: 'verification failed', committed: true });
  const onPassword = async () => 'password', target = await editor.open(reference, { onPassword });
  await fs.writeFile(target, 'first'); await assert.rejects(editor.saved(target), /verification failed/);
  assert.equal(writes[0].settings.onPassword, onPassword);
  await fs.writeFile(target, 'second'); await assert.rejects(editor.saved(target), /verification failed/);
  assert.equal(writes[1].reference.revision, 'new-revision');
  await editor.close(target); assert.equal(await fs.readFile(target, 'utf8'), 'second'); assert.deepEqual(retained, [target]);
});
