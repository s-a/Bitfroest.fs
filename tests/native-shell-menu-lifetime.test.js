const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

test('a helper whose input was already closed exits when its owning host disappears', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-shell-watch-'));
  const helperSource = path.join(__dirname, '../native/file-context-menu.ps1');
  let host, helperPid;
  t.after(async () => { host?.kill(); if (helperPid) { try { process.kill(helperPid); } catch { /* The helper has already exited. */ } } await fs.rm(root, { recursive: true, force: true }); });
  const watch = path.join(root, 'watch.ps1'), owner = path.join(root, 'owner.cjs');
  await fs.writeFile(watch, `$ErrorActionPreference='Stop'\n$request=[Console]::In.ReadToEnd() | ConvertFrom-Json\n$source=Get-Content -LiteralPath $request.source -Raw\n$definition=[regex]::Match($source, "(?s)-TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@").Groups[1].Value\nAdd-Type -ReferencedAssemblies System.dll,System.Windows.Forms.dll -TypeDefinition $definition\n[FileShellMenu]::WatchHost([int]$request.host)\n[Console]::Out.WriteLine('watch-ready')\n[Console]::Out.Flush()\n[System.Threading.Thread]::Sleep(60000)\n`);
  await fs.writeFile(owner, `const{spawn}=require('node:child_process');const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Sta','-File',${JSON.stringify(watch)}],{windowsHide:true});let output='',errors='';child.stdin.end(JSON.stringify({host:process.pid,source:${JSON.stringify(helperSource)}}));child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('watch-ready'))process.stdout.write(JSON.stringify({helperPid:child.pid})+'\\n');});child.stderr.on('data',chunk=>errors+=chunk);child.on('exit',code=>{if(!output.includes('watch-ready')){process.stderr.write(errors);process.exit(code||1);}});setInterval(()=>{},1000);`);
  host = spawn(process.execPath, [owner], { windowsHide: true });
  const ready = await new Promise((resolve, reject) => {
    let text = '', errors = ''; const timer = setTimeout(() => reject(new Error('Helper lifetime watcher did not become ready.')), 10000);
    host.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); } });
    host.stderr.on('data', chunk => errors += chunk); host.on('exit', code => { clearTimeout(timer); reject(new Error(`Owner exited before readiness (${code}): ${errors}`)); });
  });
  helperPid = ready.helperPid; assert.ok(Number.isInteger(helperPid) && helperPid > 0);
  host.kill();
  const deadline = Date.now() + 5000; let alive = true;
  while (alive && Date.now() < deadline) { try { process.kill(helperPid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { alive = false; } }
  assert.equal(alive, false, 'closed stdin does not leave an orphaned native helper after host death');
  helperPid = undefined;
});
