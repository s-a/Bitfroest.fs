const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const binary = process.env.NATIVE_BINDING_TEST_PATH || path.join(__dirname, '../native/binding.node');
const windows = { skip: process.platform !== 'win32' };

test('native icon requests validate all fields before broker work', windows, () => {
  const s = require(binary).openSession();
  const valid = { key: 'unicode-文件', path: '', name: 'file.txt', type: 'file', iconResource: '' };
  try {
    for (const request of [null, {}, { requests: null }, { requests: Array(25).fill(valid) }, { requests: [{ ...valid, key: 'x'.repeat(301) }] }, { requests: [{ ...valid, path: 'bad\0path' }] }, { requests: [{ ...valid, name: 'x'.repeat(301) }] }, { requests: [{ ...valid, type: 'other' }] }]) {
      assert.throws(() => s.invoke('icons.resolve', request), { code: 'InvalidRequest' });
    }
  } finally { s.close(); }
});

test('an empty native icon batch completes without an external process', windows, async () => {
  const s = require(binary).openSession();
  try { assert.deepEqual(await s.invoke('icons.resolve', { requests: [] }), { icons: [] }); }
  finally { s.close(); }
});

test('native icon extraction works from an isolated binding copy without a sibling executable', windows, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-icons-direct-'));
  const copiedBinding = path.join(directory, 'binding.node');
  const root = path.join(directory, 'folder');
  const resourcePath = path.join(process.env.SystemRoot, 'System32', 'shell32.dll');
  await fs.mkdir(root);
  try {
    await fs.copyFile(binary, copiedBinding);
    await fs.writeFile(path.join(root, 'desktop.ini'), `\uFEFF[.ShellClassInfo]\nIconResource=${resourcePath},3\n`, 'utf16le');
    const script = `const fs=require('node:fs');(async()=>{const s=require(process.argv[1]).openSession();try{const root=process.argv[2],resourcePath=process.argv[3],before=fs.statSync(root).mode,resource=resourcePath+',3';const result=await s.invoke('icons.resolve',{requests:[{key:'system-file',path:resourcePath,name:'shell32.dll',type:'file',iconResource:resource},{key:'custom-folder',path:root,name:'folder',type:'folder',iconResource:''}]});const icons=result.icons;const signature=Buffer.from([137,80,78,71,13,10,26,10]);if(icons.length!==2||icons.some(icon=>!Buffer.isBuffer(icon.png)||!icon.png.subarray(0,8).equals(signature))||!icons[0].png.equals(icons[1].png)||fs.statSync(root).mode!==before)throw Error('icon-contract');process.stdout.write('direct-icons-ok')}finally{s.close()}})().catch(error=>{process.stderr.write(String(error.code||error.message));process.exitCode=1});`;
    const output = execFileSync(process.execPath, ['-e', script, copiedBinding, root, resourcePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(output, 'direct-icons-ok');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
