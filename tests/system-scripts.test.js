const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createScriptHistory, findScripts, inspectParameters, rankHistory, runScriptPicker } = require('../system-scripts');

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
  assert.equal(inspectParameters('Write-Output $args').manual, true);
  assert.equal(inspectParameters('Write-Output "hello"').manual, false);
});

test('history sorts by count then last handoff', () => {
  const history = [['a', 1, 10], ['b', 2, 5], ['c', 2, 8]];
  assert.deepEqual(rankHistory(history), ['c', 'b', 'a']);
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
  await fs.writeFile(file, "param([Parameter(Mandatory)][string] $Path, [switch] $Force)");
  let accept, hide, shown = false;
  const picker = {
    onDidAccept(fn) { accept = fn; return { dispose() {} }; },
    onDidHide(fn) { hide = fn; return { dispose() {} }; },
    show() { shown = true; }, hide() { hide(); }, dispose() {},
    set items(items) {
      assert.ok(shown);
      assert.equal(items.length, 1);
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
      showQuickPick(items) { return items.find(item => item.value === true); },
    },
    translate: value => value, directory: root, platform: 'win32', pathValue: root,
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
