const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { safeActions, safeListerActions } = require('./run.cjs');

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
  let sequence = 1;
  while (!fs.existsSync(path.join(run, 'stop'))) {
    const commandFile = path.join(run, `command-${sequence}.json`);
    if (fs.existsSync(commandFile)) {
      let reply = {};
      try {
        const { command, args = [] } = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
        if (command === 'bitfroest.lister-action' ? args.length !== 1 || !safeListerActions.includes(args[0]) : !safeActions.some(action => command === `bitfroest.${action}`) || args.length) throw new Error('Showcase command is not permitted.');
        await vscode.commands.executeCommand(command, ...args);
      } catch (error) { reply = { error: error.message }; }
      fs.writeFileSync(path.join(run, `reply-${sequence++}.json`), JSON.stringify(reply));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
