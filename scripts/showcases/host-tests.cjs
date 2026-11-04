const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async function () {
  const run = process.env.BFS_SHOWCASE_RUN;
  if (!run) throw new Error('Missing showcase run directory.');
  const extension = vscode.extensions.getExtension('bitfroest.bitfroest-fs-prototype');
  if (!extension) throw new Error('The product extension was not loaded.');
  await extension.activate();
  await vscode.commands.executeCommand('bitfroest.show');
  fs.writeFileSync(path.join(run, 'ready.json'), JSON.stringify({
    hostVersion: vscode.version, platform: process.platform,
    extension: extension.id, source: extension.extensionPath
  }));
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(run, 'stop'))) { clearInterval(timer); resolve(); }
    }, 200);
  });
};
