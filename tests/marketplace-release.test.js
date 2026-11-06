const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('manual Marketplace publication cannot cancel an unrelated main build', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  const template = workflow.match(/^ {2}group: (.+)$/m)[1];
  const group = tag => template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    const context = { 'github.ref': 'refs/heads/main', 'inputs.marketplace_tag': tag };
    return expression.split('||').map(term => context[term.trim()]).find(Boolean) || '';
  });
  assert.notEqual(group('v0.0.39'), group(''));
  assert.notEqual(group('v0.0.39'), group('v0.0.40'));
});

function fixture(t, { version = '0.0.39', targets = ['win32-x64', 'linux-x64'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const directory = path.join(root, 'release');
  fs.mkdirSync(source);
  fs.mkdirSync(directory);
  const commit = 'a'.repeat(40);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version, preview: true, publisher: 'bitfroest' }));
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  const names = [];
  for (const target of targets) {
    const name = `bitfroest-fs-${version}-${target}.vsix`;
    const bytes = Buffer.from(`verified ${target}`);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(directory, name), bytes);
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ version, target, experimental: target === 'darwin-arm64', commit, sha256 }));
    fs.writeFileSync(path.join(directory, `${name}.sha256`), `${sha256}  ${name}\n`);
    names.push(name, `${name}.sha256`, `${name}.json`);
  }
  const calls = [];
  const release = { tagName: `v${version}`, isDraft: false, assets: names.map(name => ({ name })) };
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'git') return `${commit}\n`;
    if (command === 'gh' && args[1] === 'view') return JSON.stringify(release);
    return '';
  };
  return { source, directory, commit, calls, release, run, tag: release.tagName, event: 'workflow_dispatch', ref: 'refs/heads/main' };
}

test('Marketplace pre-releases include the verified experimental Apple Silicon package', t => {
  const { publishMarketplace } = require('../scripts/publish-marketplace.cjs');
  const version = '0.0.52';
  const targets = ['win32-x64', 'linux-x64', 'darwin-arm64'];
  const context = fixture(t, { version, targets });
  publishMarketplace(context);
  const args = context.calls.find(call => call.command === 'npm').args;
  assert.ok(args.includes('--pre-release'));
  assert.deepEqual(args.slice(args.indexOf('--packagePath') + 1),
    targets.map(target => path.join(context.directory, `bitfroest-fs-${version}-${target}.vsix`)));
});

test('Marketplace refuses missing Apple Silicon assets or provenance without the experimental flag', t => {
  const { publishMarketplace } = require('../scripts/publish-marketplace.cjs');
  const version = '0.0.52';
  const missing = fixture(t, { version });
  assert.throws(() => publishMarketplace(missing), /platform assets/);
  assert.equal(missing.calls.some(call => call.command === 'npm'), false);

  const unmarked = fixture(t, { version, targets: ['win32-x64', 'linux-x64', 'darwin-arm64'] });
  const filename = path.join(unmarked.directory, `bitfroest-fs-${version}-darwin-arm64.vsix.json`);
  const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
  fs.writeFileSync(filename, JSON.stringify({ ...metadata, experimental: false }));
  assert.throws(() => publishMarketplace(unmarked), /provenance mismatch for darwin-arm64/);
  assert.equal(unmarked.calls.some(call => call.command === 'npm'), false);
});

test('Marketplace publication uses both verified packages with OIDC without rebuilding', t => {
  const context = fixture(t);
  const { publishMarketplace } = require('../scripts/publish-marketplace.cjs');
  publishMarketplace(context);
  const publish = context.calls.find(call => call.command === 'npm');
  assert.ok(publish);
  assert.deepEqual(publish.args, ['exec', '--yes', '--package', '@vscode/vsce@4.1.0', '--', 'vsce', 'publish', '--oidc', '--pre-release', '--skip-duplicate', '--packagePath',
    path.join(context.directory, 'bitfroest-fs-0.0.39-win32-x64.vsix'), path.join(context.directory, 'bitfroest-fs-0.0.39-linux-x64.vsix')]);
  assert.equal(context.calls.filter(call => call.command === 'npm').length, 1);
  assert.ok(context.calls.some(call => call.command === 'gh' && call.args[1] === 'download'));
});

test('Marketplace publication refuses branch pushes and mismatched tags before external calls', t => {
  const { publishMarketplace } = require('../scripts/publish-marketplace.cjs');
  for (const override of [{ event: 'push' }, { event: 'pull_request' }, { ref: 'refs/heads/other' }, { tag: 'v0.0.40' }, { tag: 'main' }]) {
    const context = { ...fixture(t), ...override };
    assert.throws(() => publishMarketplace(context));
    assert.equal(context.calls.length, 0);
  }
});

test('Marketplace publication validates both packages before uploading either', t => {
  const { publishMarketplace } = require('../scripts/publish-marketplace.cjs');
  for (const failure of ['bytes', 'checksum', 'commit', 'experimental', 'missing', 'extra', 'draft', 'release-tag']) {
    const context = fixture(t);
    const linux = path.join(context.directory, 'bitfroest-fs-0.0.39-linux-x64.vsix');
    if (failure === 'bytes') fs.appendFileSync(linux, 'changed');
    if (failure === 'checksum') fs.writeFileSync(`${linux}.sha256`, 'incorrect');
    if (failure === 'commit' || failure === 'experimental') {
      const metadata = JSON.parse(fs.readFileSync(`${linux}.json`, 'utf8'));
      if (failure === 'commit') metadata.commit = 'b'.repeat(40);
      else metadata.experimental = true;
      fs.writeFileSync(`${linux}.json`, JSON.stringify(metadata));
    }
    if (failure === 'missing') fs.unlinkSync(linux);
    if (failure === 'extra') context.release.assets.push({ name: 'experimental.vsix' });
    if (failure === 'draft') context.release.isDraft = true;
    if (failure === 'release-tag') context.release.tagName = 'v0.0.38';
    assert.throws(() => publishMarketplace(context), undefined, failure);
    assert.equal(context.calls.some(call => call.command === 'npm'), false, failure);
  }
});

test('Marketplace publication accepts a pushed release tag and propagates publishing errors', t => {
  const context = fixture(t);
  const { publishMarketplace } = require('../scripts/publish-marketplace.cjs');
  const run = context.run;
  context.event = 'push';
  context.ref = 'refs/tags/v0.0.39';
  context.run = (command, args) => {
    if (command === 'npm') throw new Error('Marketplace authentication failed');
    return run(command, args);
  };
  assert.throws(() => publishMarketplace(context), /Marketplace authentication failed/);
});
