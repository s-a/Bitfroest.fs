const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { productIcon } = require('../product-icons');

test('host and manifest icons use approved public platform identifiers', () => {
  assert.equal(productIcon('folder'), '$(folder)');
  assert.equal(productIcon('star-full'), '$(star-full)');
  assert.throws(() => productIcon('unknown'), /unknown/i);
  const manifest = require('../package.json');
  for (const match of JSON.stringify(manifest).matchAll(/\$\(([a-z-]+)\)/g)) assert.equal(productIcon(match[1]), match[0]);
  for (const name of fs.readdirSync(path.join(__dirname, '..')).filter(name => name.endsWith('.js') && name !== 'product-icons.js')) {
    assert.equal(/\$\([a-z-]+\)/.test(fs.readFileSync(path.join(__dirname, '..', name), 'utf8')), false, name);
  }
});
