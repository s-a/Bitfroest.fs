const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');

test('native window work preserves filesystem capacity and survives owner-environment termination', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-window-lifecycle-'));
  const isolated = path.join(root, 'binding.node');
  await fs.copyFile(binary, isolated);
  try {
    const program = `
      const assert = require('node:assert/strict');
      const { Worker } = require('node:worker_threads');
      const fs = require('node:fs/promises');
      (async () => {
        const worker = new Worker(\`const { parentPort, workerData } = require('node:worker_threads');
          const { randomUUID } = require('node:crypto');
          const binding = require(workerData);
          const sessions = Array.from({length:4}, () => binding.openSession());
          for (const session of sessions) session.invoke('windows.maximize', {titleToken:randomUUID()}).catch(() => {});
          parentPort.postMessage('queued');\`, {eval:true, workerData:process.argv[1]});
        await new Promise((resolve,reject) => {worker.once('message',resolve);worker.once('error',reject);});
        const started = performance.now();
        await fs.readFile(process.argv[1]);
        assert.ok(performance.now()-started < 1200, 'Window lookup occupied the shared filesystem pool.');
        await worker.terminate();
        await fs.stat(process.argv[1]);
        process.stdout.write('native-worker-closed');
      })().catch(error => { console.error(error); process.exitCode=1; });`;
    const result = spawnSync(process.execPath, ['-e', program, isolated], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, 'native-worker-closed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
