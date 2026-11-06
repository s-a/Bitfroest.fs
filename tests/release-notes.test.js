const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const content = '# Bitfroest.fs 0.0.47\n\nChanges since version 0.0.40.\n\n## Fixed\n\n- Folder navigation retains forward history.\n';

function fixture(t) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const version = '0.0.47';
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version, preview: true }));
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  const notes = path.join(source, '.github', 'release-notes', `${version}.md`);
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, content);
  return { source, notes, ref: `refs/tags/v${version}`, event: 'push', commit: 'a'.repeat(40) };
}

function check(context, ref = context.ref) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-release-notes.cjs')], {
    cwd: context.source, encoding: 'utf8', env: { ...process.env, GITHUB_REF: ref }
  });
}

test('release gate accepts the matching version without requiring intermediate notes', t => {
  const context = fixture(t);
  assert.equal(check(context).status, 0);
});

test('release gate rejects missing, empty, unfinished and mismatched notes', t => {
  const context = fixture(t);
  for (const body of [null, '', ' \n', '# Bitfroest.fs 0.0.47\n', content.replace('0.0.47', '0.0.46'),
    `${content}\n**Draft.** Not ready.`, `${content}\n## Draft`, `${content}\nTODO: finish`,
    `${content}\nTBD`, `${content}\nFIXME`, `${content}\n<!-- TODO: complete -->`, `${content}\n[PLACEHOLDER]`]) {
    if (body === null) fs.unlinkSync(context.notes);
    else fs.writeFileSync(context.notes, body);
    const result = check(context);
    assert.notEqual(result.status, 0, String(body));
    assert.match(result.stderr, /Release notes/, String(body));
  }
});

test('development builds accept missing or draft notes but release tags must match the manifest and lock', t => {
  const context = fixture(t);
  fs.writeFileSync(context.notes, `${content}\n**Draft.** Not ready.`);
  assert.equal(check(context, 'refs/heads/main').status, 0);
  fs.unlinkSync(context.notes);
  assert.equal(check(context, 'refs/pull/12/merge').status, 0);
  assert.notEqual(check(context, 'refs/tags/v0.0.48').status, 0);
  fs.writeFileSync(path.join(context.source, 'package-lock.json'), JSON.stringify({ version: '0.0.46' }));
  assert.notEqual(check(context).status, 0);
});

function publication(t) {
  const context = fixture(t);
  context.directory = path.join(context.source, 'release');
  fs.mkdirSync(context.directory);
  for (const target of ['win32-x64', 'linux-x64']) {
    const filename = path.join(context.directory, `bitfroest-fs-0.0.47-${target}.vsix`);
    const bytes = Buffer.from(target);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(filename, bytes);
    fs.writeFileSync(`${filename}.json`, JSON.stringify({ target, version: '0.0.47', experimental: false, commit: context.commit, sha256 }));
    fs.writeFileSync(`${filename}.sha256`, `${sha256}  ${path.basename(filename)}\n`);
  }
  context.calls = [];
  context.spawn = (command, args) => {
    context.calls.push({ command, args });
    return { status: args[1] === 'view' ? 1 : 0 };
  };
  return context;
}

test('publication passes the exact version file to GitHub before uploading and publishing', t => {
  const context = publication(t);
  const { publishRelease } = require('../scripts/publish-release.cjs');
  publishRelease(context);
  assert.deepEqual(context.calls.map(call => call.args[1]), ['view', 'create', 'upload', 'edit']);
  const create = context.calls[1];
  assert.equal(create.command, 'gh');
  assert.equal(create.args[2], 'v0.0.47');
  assert.equal(create.args[create.args.indexOf('--notes-file') + 1], context.notes);
  assert.equal(fs.readFileSync(context.notes, 'utf8'), content);
  assert.ok(create.args.includes('--draft'));
  assert.ok(create.args.includes('--verify-tag'));
  assert.ok(create.args.includes('--prerelease'));
  assert.ok(create.args.includes('--latest=false'));
  assert.ok(context.calls[3].args.includes('--draft=false'));
  assert.equal(create.args.includes('--notes'), false);
});

test('publication rechecks notes and refuses invalid content before any GitHub call', t => {
  const { publishRelease } = require('../scripts/publish-release.cjs');
  for (const body of [null, '', `${content}\n**Draft.** Pending.`, content.replace('0.0.47', '0.0.46')]) {
    const context = publication(t);
    if (body === null) fs.unlinkSync(context.notes);
    else fs.writeFileSync(context.notes, body);
    assert.throws(() => publishRelease(context), /Release notes/);
    assert.equal(context.calls.length, 0);
  }
});

test('publication keeps existing releases intact and stops on upload errors', t => {
  const { publishRelease } = require('../scripts/publish-release.cjs');
  const existing = publication(t);
  existing.spawn = (_command, args) => { existing.calls.push(args); return { status: 0 }; };
  assert.throws(() => publishRelease(existing), /already exists/);
  assert.equal(existing.calls.length, 1);
  const failed = publication(t);
  const spawn = failed.spawn;
  failed.spawn = (command, args) => args[1] === 'upload' ? { status: 1 } : spawn(command, args);
  assert.throws(() => publishRelease(failed), /failed/);
  assert.equal(failed.calls.some(call => call.args[1] === 'edit'), false);
});

test('platform builds check release notes before dependencies and native builds and run these safeguards', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-vsix.yml'), 'utf8');
  const gate = workflow.indexOf('run: node scripts/check-release-notes.cjs');
  assert.ok(gate > workflow.indexOf('- uses: actions/setup-node@'));
  assert.ok(gate < workflow.indexOf('run: npm ci'));
  assert.ok(gate < workflow.indexOf('run: node scripts/ci-native-build.cjs'));
  assert.match(workflow, /node --test[^\n]*tests\/release-notes\.test\.js/);
});

test('platform packages expose the versioned release notes as the Marketplace changelog', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-vsix.yml'), 'utf8');
  const stage = workflow.indexOf('cp ".github/release-notes/$VERSION.md" CHANGELOG.md');
  assert.ok(stage > workflow.indexOf('VERSION=$(node'));
  assert.ok(stage < workflow.indexOf('vsce package --pre-release'));
  const verifier = fs.readFileSync(path.join(root, 'scripts/verify-vsix.cjs'), 'utf8');
  assert.match(verifier, /Microsoft\.VisualStudio\.Services\.Content\.Changelog/);
  assert.match(verifier, /extension\/changelog\.md/);
});
