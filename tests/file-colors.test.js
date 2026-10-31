const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../media/commander-file-colors');

test('text colors retain adequate colors and correct background-identical and translucent colors', () => {
  for (const background of ['#ffffff', '#181818', '#789abc']) {
    for (const desired of [background, '#ff0000', '#00ff00', '#ffffff00', 'rgba(0,0,0,0.2)', 'invalid']) {
      const result = colors.readable(desired, background, '#777777');
      assert.ok(colors.ratio(result, background) >= 4.5, `${desired} on ${background}: ${result}`);
    }
  }
  assert.equal(colors.readable('#123456', '#ffffff'), '#123456');
  assert.equal(colors.readable('#123456', 'unknown'), null);
});

test('background composition and pattern priority are explicit', () => {
  assert.equal(colors.composite('rgba(255,255,255,0.5)', '#000000'), '#808080');
  assert.equal(colors.match('report.test.js', { '*.js': '#ff0000', '*.test.js': '#00ff00' }), '#00ff00');
  assert.equal(colors.match('README.MD', { '*.md': '#ff0000' }), '#ff0000');
  assert.equal(colors.match('notes.txt', { '*.md': '#ff0000' }), null);
  assert.equal(colors.match('notes.txt', { '*': 'url(bad)' }), null);
});

test('contrast uses linear sRGB and rejects unresolved or invalid backgrounds', () => {
  assert.equal(colors.ratio('#000000', '#ffffff'), 21);
  assert.equal(colors.ratio('#ffffff', '#ffffff'), 1);
  assert.ok(Math.abs(colors.ratio('#777777', '#ffffff') - 4.478) < .001);
  for (const value of ['rgba(300,0,0,1)', 'rgba(0,0,0,2)', '#ggg', 'var(--missing)']) assert.equal(colors.parse(value), null);
  assert.equal(colors.readable('#000000', '#ffffff80'), null);
  assert.equal(colors.composite('transparent', '#123456'), '#123456');
});

test('repeated wildcards cannot block matching ordinary long file names', async () => {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); const colors=require(${JSON.stringify(require.resolve('../media/commander-file-colors'))}); parentPort.postMessage(colors.match('a'.repeat(120), {'*a*a*a*a*a*a*a*a*a*a*a*a*b':'#ffffff'}));`, { eval: true });
  let timer;
  try {
    const result = await Promise.race([
      new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 1000); })
    ]);
    assert.equal(result, null);
  } finally { clearTimeout(timer); await worker.terminate(); }
});
