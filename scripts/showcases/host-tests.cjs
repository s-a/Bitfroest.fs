const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { safeActions, safeListerActions, profileSettings } = require('./run.cjs');

exports.run = async function () {
  const run = process.env.BFS_SHOWCASE_RUN;
  if (!run) throw new Error('Missing showcase run directory.');
  const launch = JSON.parse(fs.readFileSync(path.join(run, 'launch.json'), 'utf8'));
  const favorites = vscode.workspace.getConfiguration('bitfroest').inspect('favorites.items');
  if (vscode.workspace.workspaceFolders?.length || favorites.workspaceValue !== undefined ||
      JSON.stringify(favorites.globalValue) !== JSON.stringify(profileSettings(launch.demo)['bitfroest.favorites.items'])) {
    throw new Error('The showcase requires isolated demo favorites without workspace overrides.');
  }
  const extension = vscode.extensions.getExtension('bitfroest.bitfroest-fs-prototype');
  if (!extension) throw new Error('The product extension was not loaded.');
  await extension.activate();
  await vscode.commands.executeCommand('bitfroest.show');
  fs.writeFileSync(path.join(run, 'ready.json'), JSON.stringify({
    hostVersion: vscode.version, platform: process.platform,
    extension: extension.id, source: extension.extensionPath, isolatedDemoFavorites: true
  }));
  let sequence = 1;
  while (!fs.existsSync(path.join(run, 'stop'))) {
    const commandFile = path.join(run, `command-${sequence}.json`);
    if (fs.existsSync(commandFile)) {
      let reply = {};
      try {
        const { command, args = [] } = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
        if (command === 'showcase.focus-main') await vscode.commands.executeCommand('bitfroest.show');
        else if (command === 'showcase.prepare-editor') {
          await vscode.commands.executeCommand('workbench.action.closeSidebar');
          await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
          await vscode.commands.executeCommand('workbench.action.closePanel');
        }
        else if (command === 'showcase.screencast') await vscode.commands.executeCommand('workbench.action.toggleScreencastMode');
        else if (command === 'showcase.prepare-repository') {
          if (args.length !== 1 || !path.isAbsolute(args[0]) || !fs.existsSync(path.join(args[0], '.git'))) throw new Error('An existing demo repository is required.');
          const api = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
          await api.openRepository(vscode.Uri.file(args[0]));
        }
        else if (command === 'showcase.inspect-editor') {
          const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          const diff = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff);
          const input = diff?.input || active;
          reply = { diff: Boolean(diff), viewType: input?.viewType, original: input?.original?.toString(), modified: input?.modified?.toString() };
        } else if (command === 'showcase.clipboard-check') {
          if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('A clipboard expectation is required.');
          const value = await vscode.env.clipboard.readText();
          reply = { matched: value === args[0] };
        } else if (['bitfroest.gitHistory', 'bitfroest.gitDiff'].includes(command)) {
          const selection = args[0];
          if (args.length !== 1 || !selection?.gitHistory || !Array.isArray(selection.ids) || selection.ids.length !== 1) throw new Error('An actual Git selection is required.');
          const api = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
          await api.openRepository(vscode.Uri.file(selection.directory));
          await vscode.commands.executeCommand(command, selection);
        } else if (['bitfroest.configureSettings', 'bitfroest.configureFavorites', 'bitfroest.configureColumns', 'bitfroest.configureShortcuts', 'bitfroest.licenses', 'bitfroest.showLocalBranches', 'bitfroest.chooseLanguage', 'bitfroest.chooseTabMode'].includes(command) && !args.length) {
          await vscode.commands.executeCommand(command);
        } else {
          if (command === 'bitfroest.lister-action' ? args.length !== 1 || !safeListerActions.includes(args[0]) : !safeActions.some(action => command === `bitfroest.${action}`) || args.length) throw new Error('Showcase command is not permitted.');
          await vscode.commands.executeCommand(command, ...args);
        }
      } catch (error) { reply = { error: error.message }; }
      fs.writeFileSync(path.join(run, `reply-${sequence++}.json`), JSON.stringify(reply));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
