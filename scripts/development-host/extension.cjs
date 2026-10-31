const fs = require('node:fs');
const path = require('node:path');

function startWatcher(root, { reload, onError, watch = fs.watch, delay = 750 }) {
  const watchers = [];
  let timer, disposed = false, reloading = false;
  function changed(directory, filename) {
    if (disposed || reloading) return;
    const name = filename == null ? null : filename.toString().replaceAll('\\', '/');
    if (name !== null) {
      if (!directory && (!/^[^/]+\.(?:js|json)$/.test(name) || ['package-lock.json', 'eslint.config.js'].includes(name))) return;
      if (directory && !/\.(?:js|cjs|json|css|html|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|ps1|py|cs|dll|exe|txt|md)$/.test(name)) return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed) return;
      reloading = true;
      Promise.resolve().then(reload).catch(error => {
        reloading = false;
        onError(error);
      });
    }, delay);
  }
  for (const directory of ['', 'media', 'native', 'licenses', 'scripts/development-host']) {
    const target = path.join(root, directory);
    if (!fs.existsSync(target)) continue;
    try {
      const watcher = watch(target, { recursive: Boolean(directory) }, (_event, filename) => changed(directory, filename));
      watcher.on('error', onError);
      watchers.push(watcher);
    } catch (error) { onError(error); }
  }
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    }
  };
}

function activate(context) {
  const vscode = require('vscode');
  context.subscriptions.push(startWatcher(path.resolve(__dirname, '../..'), {
    reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
    onError: error => {
      console.error('Development reload:', error);
      vscode.window.showWarningMessage(`Automatisches Neuladen fehlgeschlagen: ${error.message}`);
    }
  }));
}

module.exports = { activate, startWatcher };
