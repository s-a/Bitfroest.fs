const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFolderLocks } = require('./folder-locks');

function createLockInspector(vscode, context, options) {
  const sessions = new Set();
  function open(folder) {
    const english = !String(options.language()).toLowerCase().startsWith('de');
    const text = (de, en) => english ? en : de;
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('bitfroestFolderLocks', text('Ordnersperren untersuchen', 'Inspect folder locks'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const provider = (options.createProvider || (() => createFolderLocks({ get roots() { return options.roots; }, trash: file => vscode.workspace.fs.delete(vscode.Uri.file(file), { recursive: true, useTrash: true }) })))();
    const session = { panel, provider }; sessions.add(session);
    let closed = false, busy = false, ready = false, scanned = false, rows = [], scanVersion = 0;
    const send = data => { if (!closed) return panel.webview.postMessage(data); };
    const nonce = crypto.randomBytes(18).toString('base64');
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'lock-inspector.html').fsPath, 'utf8');
    html = html.replace('<!--POLICY-->', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">`);
    for (const name of ['lock-inspector.css', 'lock-inspector.js']) html = html.replaceAll(`"${name}"`, `"${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name))}"`);
    panel.webview.html = html.replace('<script ', `<script nonce="${nonce}" `);
    panel.onDidDispose(() => { closed = true; scanVersion++; provider.dispose(); sessions.delete(session); });
    async function scan() {
      const version = ++scanVersion; rows = []; scanned = false;
      const result = await provider.scan(folder);
      if (closed || version !== scanVersion) return;
      rows = result.rows; scanned = true;
      await send({ type: 'locks-state', ...result, english });
    }
    const pick = ids => {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !rows.some(row => row.id === id))) throw new Error(text('Die Prozessauswahl ist veraltet. Bitte aktualisieren.', 'The process selection is stale. Refresh the list.'));
      return ids.length ? rows.filter(row => ids.includes(row.id)) : [...rows];
    };
    async function confirm(action, selected) {
      const names = [...new Set(selected.map(row => `${row.name} (PID ${row.pid})`))].join('\n');
      const messages = {
        unlock: text('Die ausgewählten Dateihandles werden geschlossen und die ausgewählten DLLs entladen. Ungespeicherte Daten der betroffenen Prozesse können verloren gehen.', 'Selected file handles will be closed and selected DLLs unloaded. Unsaved data in the affected processes may be lost.'),
        terminate: text('Die ausgewählten Prozesse werden zwangsweise beendet. Ungespeicherte Daten können verloren gehen.', 'Selected processes will be forcibly terminated. Unsaved data may be lost.'),
        delete: text('Der untersuchte Ordner wird entsperrt und einschließlich Inhalt in den Papierkorb verschoben.', 'The inspected folder will be unlocked and moved to the Recycle Bin with its contents.'),
        copy: text('Der untersuchte Ordner wird entsperrt und kopiert. Das Freigeben kann ungespeicherte Daten betroffener Prozesse verwerfen.', 'The inspected folder will be unlocked and copied. Releasing locks may discard unsaved data in affected processes.'),
        rename: text('Der untersuchte Ordner wird entsperrt und umbenannt. Das Freigeben kann ungespeicherte Daten betroffener Prozesse verwerfen.', 'The inspected folder will be unlocked and renamed. Releasing locks may discard unsaved data in affected processes.'),
        'delete-processes': text('Die ausgewählten Prozesse werden beendet und ihre Programmdateien in den Papierkorb verschoben.', 'Selected processes will be terminated and their executable files moved to the Recycle Bin.'),
        schedule: text('Der Ordner einschließlich Inhalt wird für das Löschen beim nächsten Windows-Neustart vorgemerkt. Dies ändert HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\PendingFileRenameOperations. Der vorhandene Wert wird vorher gesichert und danach geprüft. Es wird kein Neustart ausgelöst.', 'The folder and its contents will be scheduled for deletion on the next Windows restart. This changes HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\PendingFileRenameOperations. The existing value will be backed up first and verified afterwards. No restart will be triggered.')
      };
      const yes = text('Ausführen', 'Run');
      return await vscode.window.showWarningMessage(messages[action], { modal: true, detail: `${folder}\n\n${names}` }, yes) === yes;
    }
    panel.webview.onDidReceiveMessage(async message => {
      if (closed || !panel.visible || !message || typeof message.type !== 'string') return;
      if (message.type === 'locks-close') { panel.dispose(); return; }
      if (busy) return;
      busy = true;
      try {
        if (message.type === 'locks-ready') {
          if (ready) return; ready = true;
          await send({ type: 'locks-init', path: folder, english });
          await send({ type: 'locks-busy', busy: true }); await scan(); return;
        }
        if (!ready) return;
        if (message.type === 'locks-refresh') { await send({ type: 'locks-busy', busy: true }); await scan(); return; }
        if (message.type !== 'locks-action') return;
        if (!scanned) throw new Error(text('Die Untersuchung muss zuerst erfolgreich abgeschlossen werden.', 'Complete an inspection before running actions.'));
        const selected = pick(message.ids), version = scanVersion;
        let action = message.action;
        if (action === 'other' || action === 'context') {
          const choices = action === 'context' ? [
            ['unlock', text('Ausgewählte Prozesse freigeben', 'Unlock selected processes')],
            ['terminate', text('Ausgewählte Prozesse beenden', 'Terminate selected processes')],
            ['copy-info', text('Prozessinformationen kopieren', 'Copy process information')],
            ['delete-processes', text('Ausgewählte Prozessdateien löschen', 'Delete selected executable files')]
          ] : [
            ['copy', text('Entsperren und kopieren…', 'Unlock and copy…')], ['rename', text('Entsperren und umbenennen…', 'Unlock and rename…')],
            ['terminate', text('Sperrende Prozesse beenden', 'Terminate locking processes')], ['delete-processes', text('Sperrende Prozessdateien löschen', 'Delete locking executable files')],
            ['schedule', text('Beim nächsten Windows-Neustart löschen…', 'Delete on next Windows restart…')], ['copy-info', text('Prozessinformationen kopieren', 'Copy process information')]
          ];
          action = (await vscode.window.showQuickPick(choices.map(([id, label]) => ({ id, label })), { title: text('Ordnersperren', 'Folder locks') }))?.id;
          if (!action || closed || version !== scanVersion) return;
        }
        if (action === 'copy-info') {
          await vscode.env.clipboard.writeText(selected.map(row => `${row.name}\tPID ${row.pid}\t${row.executable}\t${row.kind}\t${row.file}\t${row.started}\t${row.commandLine || ''}`).join('\n')); return;
        }
        if (!['unlock', 'terminate', 'copy', 'rename', 'delete', 'delete-processes', 'schedule'].includes(action)) return;
        if (['unlock', 'terminate', 'delete-processes'].includes(action) && !selected.length) throw new Error(text('Keine Prozesse ausgewählt.', 'No processes selected.'));
        let destination;
        if (action === 'copy' || action === 'rename') {
          const value = await vscode.window.showInputBox({ title: text('Vollständiger Zielpfad', 'Full destination path'), value: folder, ignoreFocusOut: true });
          if (!value || closed) return; destination = value;
        }
        if (!await confirm(action, selected) || closed || version !== scanVersion) return;
        await send({ type: 'locks-busy', busy: true });
        try {
          if (action === 'schedule') {
            const backup = path.join(context.globalStorageUri.fsPath, 'restart-delete-backups', `${Date.now()}-${crypto.randomUUID()}.reg`);
            const result = await provider.schedule(backup);
            await send({ type: 'locks-notice', message: text('Neustartlöschung vorgemerkt. Sicherung: ', 'Deletion scheduled. Backup: ') + result.backup });
          } else if (action === 'unlock' || action === 'terminate') await provider.act(action, selected.map(row => row.id));
          else await provider.fileAction(action, selected.map(row => row.id), destination);
          if (action === 'delete' || action === 'rename') { rows = []; await send({ type: 'locks-state', path: folder, rows: [], inaccessible: 0, english, finished: true }); options.changed?.(); }
          else { await scan(); if (action === 'copy' || action === 'delete-processes') options.changed?.(); }
        } catch (error) {
          try { await scan(); } catch { /* The original operation error remains available. */ }
          throw error;
        }
      } catch (error) { await send({ type: 'locks-error', error: error.message }); }
      finally { busy = false; await send({ type: 'locks-busy', busy: false }); }
    });
    return panel;
  }
  const controller = { open, dispose() { for (const { panel } of [...sessions]) panel.dispose(); } };
  context.subscriptions.push(controller); return controller;
}
module.exports = { createLockInspector };
