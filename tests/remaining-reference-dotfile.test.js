const test = require('node:test');
const assert = require('node:assert/strict');
const transfer = require('../media/commander-transfer');

test('target masks retain a leading-dot filename stem when adding an extension', async () => {
  assert.equal(transfer.applyNameMask('.env', '*'), '.env');
  assert.equal(transfer.applyNameMask('.env', '*.new'), '.env.new');
  const folders = { '/source': [{ id: 'env', name: '.env', type: 'text', content: 'configuration' }], '/target': [] };
  const result = await transfer.execute({ folders, sourcePath: '/source', targetPath: '/target/*.new', ids: ['env'] });
  assert.equal(result.completed, 1);
  assert.deepEqual(folders['/target'].map(row => [row.name, row.content]), [['.env.new', 'configuration']]);
  assert.deepEqual(folders['/source'].map(row => [row.name, row.content]), [['.env', 'configuration']]);
});
