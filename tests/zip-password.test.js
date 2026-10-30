const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zip = require('@zip.js/zip.js');
const { createZipProvider } = require('../zip-provider');
for (const encryption of ['zipcrypto', 'aes128', 'aes192', 'aes256']) test(`ZIP-F27/F30 ${encryption} opens without password and prompts only on selected read or copy`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-password-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'encrypted.zip'), target = path.join(root, 'out'); await fs.mkdir(target);
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('secret.txt', new zip.TextReader('secret'), { password: 'correct', zipCrypto: encryption === 'zipcrypto', encryptionStrength: { aes128: 1, aes192: 2, aes256: 3 }[encryption] || 3 });
  await fs.writeFile(archive, await writer.close());
  const checker = new zip.ZipReader(new zip.Uint8ArrayReader(await fs.readFile(archive))), [encryptedEntry] = await checker.getEntries();
  let rejectedPassword;
  try {
    for (let candidate = 0; candidate < 20; candidate++) {
      const password = `incorrect-${candidate}`;
      try { await encryptedEntry.getData(new zip.Uint8ArrayWriter(), { password, checkPasswordOnly: true, useWebWorkers: false }); }
      catch (error) { if (error.message !== 'Invalid password') throw error; rejectedPassword = password; break; }
    }
    assert.equal(typeof rejectedPassword, 'string');
  } finally { await checker.close(); }
  const provider = createZipProvider({ contains: value => path.resolve(value).startsWith(root + path.sep) }); t.after(() => provider.dispose());
  const opened = await provider.open(archive); assert.equal(opened.folders[opened.path][0].name, 'secret.txt');
  const refs = []; for await (const ref of provider.entries(archive)) refs.push(ref);
  let prompts = 0;
  const chunks = [];
  for await (const chunk of provider.readEntry(refs[0], { onPassword: async () => { prompts++; return prompts === 1 ? rejectedPassword : 'correct'; } })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'secret'); assert.equal(prompts, 2);
  await provider.copy({ path: opened.path, ids: [refs[0].id], target }, { password: 'correct' });
  assert.equal(await fs.readFile(path.join(target, 'secret.txt'), 'utf8'), 'secret');
});
test('ZIP password cancellation produces no file and does not persist secrets in metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-password-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'encrypted.zip'), target = path.join(root, 'out'); await fs.mkdir(target);
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('secret.txt', new zip.TextReader('secret'), { password: 'private-value', encryptionStrength: 3 }); await fs.writeFile(archive, await writer.close());
  const provider = createZipProvider({ contains: value => value.startsWith(root) }); t.after(() => provider.dispose());
  const opened = await provider.open(archive);
  await assert.rejects(provider.copy({ path: opened.path, ids: [opened.folders[opened.path][0].id], target }, { onPassword: async () => undefined }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(target), []); assert.equal(JSON.stringify(opened).includes('private-value'), false);
});

test('ZIP password prompt receives cancellation when its archive view closes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-password-close-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'secret.zip'), writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('secret.txt', new zip.TextReader('secret'), { password: 'password' }); await fs.writeFile(archive, await writer.close());
  const provider = createZipProvider({ contains: value => path.resolve(value).startsWith(root + path.sep) }); t.after(() => provider.dispose());
  const [reference] = (await provider.open(archive)).folders[(await provider.open(archive)).path];
  let shown, release, observed; const prompt = new Promise(resolve => { shown = resolve; });
  const reading = provider.readEntry(reference, { onPassword: request => new Promise(resolve => { observed = request; release = resolve; request.signal?.addEventListener('abort', () => resolve(undefined), { once: true }); shown(); }) }).next(); reading.catch(() => {});
  try { await prompt; assert.ok(observed.signal); provider.clear(); await assert.rejects(reading, { name: 'AbortError' }); }
  finally { release?.(undefined); await reading.catch(() => {}); }
});
