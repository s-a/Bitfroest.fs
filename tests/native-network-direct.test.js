const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('network roots resolve directly from a standalone native module without executables', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-network-direct-'));
  const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
  try {
    const standalone = path.join(directory, 'binding.node');
    await fs.copyFile(binary, standalone);
    assert.deepEqual(await fs.readdir(directory), ['binding.node']);
    const drive = path.parse(__filename).root.slice(0, 2).toUpperCase();
    const workerSource = `const { parentPort, workerData } = require('node:worker_threads');
        (async () => { const s = require(workerData.binary).openSession(); try {
          parentPort.postMessage([await s.invoke('paths.resolveNetwork', { drives: [workerData.drive] }),
            await s.invoke('paths.resolveNetwork', { drives: [] })]);
        } finally { s.close(); } })().catch(error => { throw error; });`;
    const childSource = `const { Worker } = require('node:worker_threads'); let message;
      const worker = new Worker(${JSON.stringify(workerSource)}, { eval: true, workerData: { binary: process.argv[1], drive: process.argv[2] } });
      worker.on('message', value => { message = value; });
      worker.on('error', error => { console.error(error); process.exitCode = 1; });
      worker.on('exit', code => { if (code === 0 && message) process.stdout.write(JSON.stringify(message)); else process.exitCode = 1; });`;
    const child = spawnSync(process.execPath, ['-e', childSource, standalone, drive], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result[0].mappings, { [drive]: null });
    assert.deepEqual(result[1].mappings, {});
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
