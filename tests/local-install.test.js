const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

function expand(name) {
  assert.equal(typeof manifest.scripts[name], 'string', `Missing script: ${name}`);
  return manifest.scripts[name].split(' && ').flatMap(command => {
    const nested = /^npm run ([\w:-]+)$/.exec(command);
    return nested ? expand(nested[1]) : [command];
  });
}

test('syntax checks and packaging gates retain all checks without repeated commands', () => {
  const commands = [...expand('check:syntax'), ...expand('vscode:prepublish')];
  assert.equal(new Set(commands).size, commands.length);
  assert.deepEqual(new Set(commands), new Set([...expand('check'), ...expand('vscode:prepublish')]));
});

test('local installation runs each check once and installs only after successful packaging', {
  skip: process.platform !== 'win32' || !fs.existsSync(path.join(root, 'Install-Local.ps1'))
}, () => {
  const script = path.join(root, 'Install-Local.ps1').replaceAll("'", "''");
  for (const failure of ['', 'check', 'package']) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $calls = [System.Collections.Generic.List[string]]::new()
      $global:testPackagePath = $null
      $failure = '${failure}'
      function npm.cmd {
        $calls.Add('npm:' + ($args -join ' '))
        $global:LASTEXITCODE = [int]($failure -eq 'check')
      }
      function npx.cmd {
        $calls.Add('package')
        $outIndex = [Array]::IndexOf($args, '--out')
        $global:testPackagePath = $args[$outIndex + 1]
        & npm.cmd run 'vscode:prepublish'
        if ($global:LASTEXITCODE -ne 0) { return }
        $global:LASTEXITCODE = [int]($failure -eq 'package')
        if ($global:LASTEXITCODE -eq 0) {
          New-Item -ItemType File -Path $args[$outIndex + 1] | Out-Null
        }
      }
      function code.cmd {
        $calls.Add('code:' + $args[0])
        $global:LASTEXITCODE = 0
        if ($args[0] -eq '--list-extensions') { 'bitfroest.bitfroest-fs-prototype@${manifest.version}' }
      }
      try { & '${script}' } catch { $calls.Add('failed'); [Console]::Error.WriteLine($_.Exception.Message) }
      finally {
        if ($global:testPackagePath) {
          Remove-Item -LiteralPath $global:testPackagePath -ErrorAction SilentlyContinue
          Remove-Item -LiteralPath (Split-Path -Parent $global:testPackagePath)
        }
      }
      'CALLS:' + (ConvertTo-Json -InputObject $calls.ToArray() -Compress)
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const calls = JSON.parse(result.stdout.match(/^CALLS:(.+)$/m)[1]);
    if (failure) {
      assert.ok(calls.includes('failed'));
      assert.ok(!calls.some(call => call.startsWith('code:')), 'Failed checks or packaging must prevent installation');
      continue;
    }
    assert.deepEqual(calls.slice(-2), ['code:--install-extension', 'code:--list-extensions'], result.stderr);
    const commands = calls.filter(call => call.startsWith('npm:run ')).flatMap(call => expand(call.slice(8)));
    assert.equal(new Set(commands).size, commands.length, 'Local installation repeats checks or tests');
    const required = new Set([...expand('check'), ...expand('vscode:prepublish')]);
    assert.deepEqual(new Set(commands), required, 'Local installation must retain every existing check');
  }
});
