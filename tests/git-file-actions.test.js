const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createGitFileActions } = require('../git-file-actions');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-file-actions-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'a [copy] #!.txt'); await fs.writeFile(target, 'LOCAL BYTES');
  const calls = [], index = { prepare: async input => ({ ...input, expectedIndex: 'old-index' }), untrack: async ticket => { calls.push(ticket); return { status: 'committed', removed: true }; } };
  return { root, target, index, calls, service: createGitFileActions({ index }) };
}
test('Keep Local removes only the prepared index entry and leaves local bytes unchanged', async t => {
  const app = await fixture(t); const ticket = await app.service.prepare({ repositoryRoot: app.root, target: app.target });
  assert.equal(app.calls.length, 0); await app.service.execute(ticket);
  assert.equal(app.calls.length, 1); assert.equal(await fs.readFile(app.target, 'utf8'), 'LOCAL BYTES');
  await assert.rejects(app.service.execute(ticket), /selection|Auswahl/i);
});
test('untrack and ignore appends an anchored literal rule while preserving existing and concurrent ignore edits', async t => {
  const app = await fixture(t), ignore = path.join(app.root, '.gitignore'); await fs.writeFile(ignore, '# existing\r\nother');
  const ticket = await app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true });
  await fs.appendFile(ignore, '\r\nconcurrent'); await app.service.execute(ticket);
  const content = await fs.readFile(ignore, 'utf8');
  assert.ok(content.startsWith('# existing\r\nother\r\nconcurrent'));
  assert.match(content, /\/a\\ \\\[copy\\\]\\ \\#\\!\.txt/);
  assert.equal(await fs.readFile(app.target, 'utf8'), 'LOCAL BYTES');
});
test('native refusal never writes ignore rules and unsafe ignore contents never remove tracking', async t => {
  const app = await fixture(t), ignore = path.join(app.root, '.gitignore');
  app.index.untrack = async () => { throw new Error('StagedChanges'); };
  const ticket = await app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true });
  await assert.rejects(app.service.execute(ticket), /StagedChanges/); await assert.rejects(fs.stat(ignore), { code: 'ENOENT' });
  await fs.writeFile(ignore, Buffer.from([255, 254, 0, 0]));
  await assert.rejects(app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true }), /UTF-8/);
  assert.equal(app.calls.length, 0);
});
test('an ignore write failure after untracking reports a partial result without deleting local data', async t => {
  const app = await fixture(t), ignore = path.join(app.root, '.gitignore');
  const ticket = await app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true }); await fs.mkdir(ignore);
  await assert.rejects(app.service.execute(ticket), error => error.untracked === true && /ignore/i.test(error.message));
  assert.equal(await fs.readFile(app.target, 'utf8'), 'LOCAL BYTES');
});

test('nested ignore exceptions are overridden in the file directory and case variants of .gitignore are protected', async t => {
  const app = await fixture(t), directory = path.join(app.root, 'sub'); await fs.mkdir(directory);
  const target = path.join(directory, 'kept.txt'), ignore = path.join(directory, '.gitignore');
  await fs.writeFile(target, 'LOCAL'); await fs.writeFile(ignore, '!kept.txt\n');
  await app.service.execute(await app.service.prepare({ repositoryRoot: app.root, target, ignore: true }));
  assert.match(await fs.readFile(ignore, 'utf8'), /!kept\.txt\n\n\/kept\.txt\n$/);
  if (process.platform === 'win32') {
    const variant = path.join(directory, '.GITIGNORE');
    await assert.rejects(app.service.prepare({ repositoryRoot: app.root, target: variant, ignore: true }), /ignore itself/);
  }
});

test('ignore refuses hardlinks to the selected local file before index mutation and before appending', async t => {
  const app = await fixture(t), ignore = path.join(app.root, '.gitignore');
  await fs.link(app.target, ignore);
  await assert.rejects(app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true }), /same file|ignore itself/i);
  assert.equal(app.calls.length, 0); assert.equal(await fs.readFile(app.target, 'utf8'), 'LOCAL BYTES');
  await fs.unlink(ignore);
  const ticket = await app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true });
  app.index.untrack = async () => { await fs.link(app.target, ignore); return { removed: true }; };
  await assert.rejects(app.service.execute(ticket), error => error.untracked === true);
  assert.equal(await fs.readFile(app.target, 'utf8'), 'LOCAL BYTES');
});

test('Git evaluates the exact local rule despite an earlier exception and leaves similar names visible', async t => {
  const app = await fixture(t), directory = path.join(app.root, 'sub'); await fs.mkdir(directory);
  const target = path.join(directory, 'file[1].txt'), other = path.join(directory, 'file1.txt');
  await fs.writeFile(target, 'KEEP'); await fs.writeFile(other, 'OTHER');
  await fs.writeFile(path.join(directory, '.gitignore'), '/file[1].txt\n!file[1].txt\n');
  const git = (...args) => spawnSync('git', args, { cwd: app.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(app.root, 'no-global-config') } });
  assert.equal(git('init', '-q').status, 0);
  await app.service.execute(await app.service.prepare({ repositoryRoot: app.root, target, ignore: true }));
  assert.equal(git('check-ignore', '--quiet', '--', target).status, 0);
  assert.equal(git('check-ignore', '--quiet', '--', other).status, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'KEEP');
});

test('a concurrent append to an initially empty ignore file cannot join the exact rule to a foreign line', async t => {
  const app = await fixture(t), ignore = path.join(app.root, '.gitignore'); await fs.writeFile(ignore, '');
  const ticket = await app.service.prepare({ repositoryRoot: app.root, target: app.target, ignore: true });
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] !== ignore) return handle;
    return { stat: () => handle.stat(), close: () => handle.close(), sync: () => handle.sync(), writeFile: (...args) => handle.writeFile(...args),
      readFile: async () => { const bytes = await handle.readFile(); await fs.appendFile(ignore, 'foreign-no-newline'); return bytes; } };
  });
  await app.service.execute(ticket);
  assert.match(await fs.readFile(ignore, 'utf8'), /^foreign-no-newline\r?\n\/a/);
});
