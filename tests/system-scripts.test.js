const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createScriptHistory, findScripts, inspectParameters, listHistoryScripts, rankHistory, runScriptPicker } = require('../system-scripts');

test('search keeps distinct scripts with identical names and requires executable shell scripts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'system-scripts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dirs = [path.join(root, 'one'), path.join(root, 'two')];
  for (const dir of dirs) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'backup.sh'), '');
    await fs.writeFile(path.join(dir, 'backup.ps1'), '');
  }
  const windows = await findScripts(dirs.join(';'), 'win32');
  assert.deepEqual(windows.map(item => item.path), dirs.map(dir => path.join(dir, 'backup.ps1')));
  if (process.platform !== 'win32') {
    await fs.chmod(path.join(dirs[0], 'backup.sh'), 0o700);
    assert.deepEqual((await findScripts(dirs.join(':'), 'linux')).map(item => item.path), [path.join(dirs[0], 'backup.sh')]);
  }
});

test('static PowerShell parameters preserve mandatory sets, switches and literal choices', () => {
  const result = inspectParameters(`# comment
    [CmdletBinding(DefaultParameterSetName='Copy')]
    param([Parameter(Mandatory=$true, ParameterSetName='Copy')]
      [ValidateSet('one', "two")] [string] $Mode, [switch] $Force)
    Write-Output $Mode`);
  assert.equal(result.defaultSet, 'Copy');
  assert.deepEqual(result.parameters[0].sets, [{ name: 'Copy', mandatory: true }]);
  assert.deepEqual(result.parameters[0].choices, ['one', 'two']);
  assert.equal(result.parameters[1].switch, true);
  assert.deepEqual(inspectParameters('Write-Output $args').parameters, []);
  assert.deepEqual(inspectParameters('Write-Output "hello"').parameters, []);
});

test('history sorts by count then last handoff', () => {
  const history = [['a', 1, 10], ['b', 2, 5], ['c', 2, 8]];
  assert.deepEqual(rankHistory(history), ['c', 'b', 'a']);
  assert.deepEqual(rankHistory(history, true), ['a', 'c', 'b']);
});

test('frequently used only lists scripts still present, ranked by launch count', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-history-list-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [first, second, deleted] = ['first.ps1', 'second.ps1', 'deleted.ps1'].map(name => path.join(root, name));
  await Promise.all([first, second, deleted].map(file => fs.writeFile(file, '')));
  const history = [[first, 1, 20], [second, 2, 10], [deleted, 4, 30]];
  assert.equal((await listHistoryScripts(history, 'win32'))[0].path, deleted);
  await fs.unlink(deleted);
  assert.deepEqual((await listHistoryScripts(history, 'win32')).map(item => item.path), [second, first]);
});

test('PowerShell starts with no arguments on the first option and skips the menu for parameterless scripts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.ps1');
  await fs.writeFile(file, 'param($Name)');
  const options = {
    window: { showQuickPick(items) { assert.equal(items[0].label, 'Ohne Parameter starten'); return items[0]; } },
    translate: value => value, directory: root, platform: 'win32', selected: { path: file },
    launch: (directory, script) => assert.deepEqual([directory, script], [root, { path: file, args: [] }]),
    record() {},
  };
  assert.equal(await runScriptPicker(options), true);
  await fs.writeFile(file, 'Write-Output $args');
  options.window.showQuickPick = () => assert.fail('unexpected parameter menu');
  assert.equal(await runScriptPicker(options), true);
});

test('closing the picker does not hand a command to the terminal', async () => {
  let dispose;
  const picker = { onDidAccept() { return { dispose() {} }; },
    onDidHide(fn) { dispose = fn; return { dispose() {} }; },
    show() { dispose(); }, dispose() {} };
  await runScriptPicker({ window: { createQuickPick: () => picker }, translate: text => text,
    launch: () => assert.fail('unexpected launch'), directory: '/tmp', platform: 'linux', pathValue: '' });
});

test('picker loads after opening, binds required fields and records only a handed-off script', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-picker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.ps1');
  const older = path.join(root, 'alphabetically-first.ps1');
  await fs.writeFile(file, "using namespace System.IO\nparam([Parameter(Mandatory)][string] $Path, [switch] $Force)");
  await fs.writeFile(older, '');
  let accept, hide, shown = false;
  const picker = {
    onDidAccept(fn) { accept = fn; return { dispose() {} }; },
    onDidHide(fn) { hide = fn; return { dispose() {} }; },
    show() { shown = true; }, hide() { hide(); }, dispose() {},
    set items(items) {
      assert.ok(shown);
      assert.deepEqual(items.map(item => item.path), [file, older]);
      this.selectedItems = items;
      accept();
    },
  };
  const events = [];
  const options = {
    window: {
      createQuickPick: () => picker,
      showInputBox({ validateInput }) {
        assert.equal(validateInput(''), 'Pflichtfeld');
        assert.equal(validateInput('a b'), undefined);
        return 'a b';
      },
      showQuickPick(items) {
        if (items[0].label === 'Ohne Parameter starten') {
          assert.deepEqual(items.map(item => item.label), ['Ohne Parameter starten', 'Deklarierte Parameter']);
          return items[1];
        }
        return items.find(item => item.value === true);
      },
    },
    translate: value => value, directory: root, platform: 'win32', pathValue: root,
    history: [[older, 5, 10], [file, 1, 20]],
    launch: (directory, script) => events.push([directory, script]),
    record: script => events.push(script),
  };
  assert.equal(await runScriptPicker(options), true);
  assert.deepEqual(events, [[root, { path: file, args: [{ name: 'Path', value: 'a b' }, { name: 'Force', value: true }] }], file]);

  options.window.showInputBox = async () => { await fs.unlink(file); return 'a b'; };
  await assert.rejects(runScriptPicker(options), /nicht mehr verfügbar/);
  assert.equal(events.length, 2);
});

test('usage updates from separate extension hosts retain both counts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = createScriptHistory(root);
  const second = createScriptHistory(root);
  assert.deepEqual(await first.read(), []);
  await Promise.all([first.record('one'), first.record('one'), second.record('one'), second.record('two')]);
  const counts = (await second.read()).map(([file, count]) => [file, count]).sort();
  assert.deepEqual(counts, [['one', 3], ['two', 1]]);
});
