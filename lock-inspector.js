const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFolderLocks } = require('./folder-locks');
const { displayPath, normalizePath } = require('./media/commander-paths');

function createLockInspector(vscode, context, options) {
  const sessions = new Set();
  function open(folder) {
    const english = !String(options.language()).toLowerCase().startsWith('de');
    const text = (de, en) => english ? en : de;
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'lock-inspector.html').fsPath, 'utf8');
    for (const name of ['lock-inspector.css', 'commander-paths.js', 'lock-inspector.js']) fs.readFileSync(vscode.Uri.joinPath(media, name).fsPath);
    const panel = vscode.window.createWebviewPanel('bitfroestFolderLocks', text('Ordnersperren untersuchen', 'Inspect folder locks'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const provider = (options.createProvider || (() => createFolderLocks({ get roots() { return options.roots; }, trash: file => vscode.workspace.fs.delete(vscode.Uri.file(file), { recursive: true, useTrash: true }) })))();
    const session = { panel, provider }; sessions.add(session);
    let closed = false, busy = false, ready = false, scanned = false, rows = [], scanVersion = 0, supported;
    const reasons = {
      'foreign-handles': text('Fremde Dateideskriptoren und geladene Module können hier nicht sicher freigegeben werden.', 'Foreign file descriptors and loaded modules cannot be safely released here.'),
      'restart-delete': text('Eine Löschung beim Systemneustart wird auf dieser Plattform nicht angeboten.', 'Deletion on system restart is unavailable on this platform.'),
      'helper-missing': text('In den unterstützten Installationspfaden wurde kein geeigneter Python-3-Interpreter gefunden. Es wird nichts automatisch installiert.', 'No suitable Python 3 interpreter was found in the supported installation paths. Nothing will be installed automatically.'),
      'pidfd-missing': text('Die erforderliche sichere Prozessschnittstelle ist nicht verfügbar.', 'The required safe process interface is unavailable.'),
      'rename-missing': text('Atomisches Umbenennen ohne Überschreiben wird hier nicht unterstützt.', 'Atomic renaming without replacing a destination is unsupported here.'),
      'lsof-missing': text('Das benötigte Werkzeug lsof ist nicht verfügbar.', 'The required lsof tool is unavailable.'),
      'identity-unverified': text('Die Prozessidentität konnte nicht sicher bestätigt werden. Dieser Eintrag ist nur lesend verfügbar.', 'The process identity could not be verified safely. This entry is read-only.')
    };
    const actionNames = () => ({ scan: text('Untersuchen', 'Inspect'), 'copy-info': text('Prozessinformationen kopieren', 'Copy process information'), unlock: text('Freigeben', 'Unlock'), terminate: text('Prozesse beenden', 'Terminate processes'), copy: supported?.referencesOnly ? text('Kopieren…', 'Copy…') : text('Entsperren und kopieren…', 'Unlock and copy…'), rename: supported?.referencesOnly ? text('Umbenennen…', 'Rename…') : text('Entsperren und umbenennen…', 'Unlock and rename…'), delete: text('Löschen…', 'Delete…'), 'delete-processes': text('Prozessdateien löschen', 'Delete executable files'), schedule: text('Beim nächsten Systemneustart löschen…', 'Delete on next system restart…') });
    const unavailable = action => supported?.actions[action]?.available === false;
    const send = data => { if (!closed) return panel.webview.postMessage(data); };
    const nonce = crypto.randomBytes(18).toString('base64');
    html = html.replace('<!--POLICY-->', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">`);
    for (const name of ['lock-inspector.css', 'commander-paths.js', 'lock-inspector.js']) html = html.replaceAll(`"${name}"`, `"${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name))}"`);
    panel.webview.html = html.replaceAll('<script ', `<script nonce="${nonce}" `);
    panel.onDidDispose(() => { closed = true; scanVersion++; provider.dispose(); sessions.delete(session); });
    async function scan() {
      const version = ++scanVersion; rows = []; scanned = false;
      const result = await provider.scan(folder);
      if (closed || version !== scanVersion) return;
      rows = result.rows; scanned = true;
      await send({ type: 'locks-state', ...result, capabilities: supported, referencesOnly: supported.referencesOnly, english });
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
      if (supported.referencesOnly) Object.assign(messages, {
        copy: text('Der untersuchte Ordner wird kopiert. Offene Dateien werden dabei nicht freigegeben.', 'The inspected folder will be copied. Open file references will not be released.'),
        rename: text('Der untersuchte Ordner wird umbenannt. Offene Dateireferenzen bleiben bestehen.', 'The inspected folder will be renamed. Open file references remain in place.'),
        delete: text('Der untersuchte Ordner wird einschließlich Inhalt in den Papierkorb verschoben. Offene Dateireferenzen werden dabei nicht freigegeben.', 'The inspected folder and its contents will be moved to the Recycle Bin. Open file references will not be released.')
      });
      const yes = text('Ausführen', 'Run');
      return await vscode.window.showWarningMessage(messages[action], { modal: true, detail: `${displayPath(folder)}\n\n${names}` }, yes) === yes;
    }
    panel.webview.onDidReceiveMessage(async message => {
      if (closed || !panel.visible || !message || typeof message.type !== 'string') return;
      if (message.type === 'locks-close') { panel.dispose(); return; }
      if (busy) return;
      busy = true;
      try {
        if (message.type === 'locks-ready') {
          if (ready) return; ready = true;
          supported = provider.capabilities ? await provider.capabilities() : { platform: process.platform, referencesOnly: false, actions: Object.fromEntries(['scan', 'copy-info', 'unlock', 'terminate', 'copy', 'rename', 'delete', 'delete-processes', 'schedule'].map(action => [action, { available: true }])) };
          if (closed) return;
          supported = { ...supported, actions: Object.fromEntries(Object.entries(supported.actions).map(([id, data]) => [id, { ...data, label: actionNames()[id], description: data.available ? '' : reasons[data.reason] || text('Auf dieser Plattform nicht verfügbar.', 'Unavailable on this platform.') }])) };
          await send({ type: 'locks-init', path: folder, english, capabilities: supported });
          await send({ type: 'locks-busy', busy: true }); await scan(); return;
        }
        if (!ready) return;
        if (message.type === 'locks-refresh') { await send({ type: 'locks-busy', busy: true }); await scan(); return; }
        if (message.type !== 'locks-action') return;
        if (!scanned) throw new Error(text('Die Untersuchung muss zuerst erfolgreich abgeschlossen werden.', 'Complete an inspection before running actions.'));
        const selected = pick(message.ids), version = scanVersion;
        const selectionUnavailable = action => unavailable(action) || ['terminate', 'delete-processes'].includes(action) && selected.some(row => row.canTerminate === false);
        const selectionDescription = action => !unavailable(action) && ['terminate', 'delete-processes'].includes(action) && selected.some(row => row.canTerminate === false) ? reasons['identity-unverified'] : supported.actions[action]?.description || '';
        let action = message.action;
        if (action === 'other' || action === 'context') {
          const choices = action === 'context' ? [
            ['unlock', text('Ausgewählte Prozesse freigeben', 'Unlock selected processes')],
            ['terminate', text('Ausgewählte Prozesse beenden', 'Terminate selected processes')],
            ['copy-info', text('Prozessinformationen kopieren', 'Copy process information')],
            ['delete-processes', text('Ausgewählte Prozessdateien löschen', 'Delete selected executable files')]
          ] : [
            ['copy', actionNames().copy], ['rename', actionNames().rename],
            ['terminate', text('Sperrende Prozesse beenden', 'Terminate locking processes')], ['delete-processes', text('Sperrende Prozessdateien löschen', 'Delete locking executable files')],
            ['schedule', text('Beim nächsten Windows-Neustart löschen…', 'Delete on next Windows restart…')], ['copy-info', text('Prozessinformationen kopieren', 'Copy process information')]
          ];
          action = (await vscode.window.showQuickPick(choices.map(([id, label]) => ({ id, label: selectionUnavailable(id) ? `${label} — ${text('Nicht verfügbar', 'Unavailable')}` : label, description: selectionDescription(id) })), { title: text('Ordnersperren', 'Folder locks') }))?.id;
          if (!action || closed || version !== scanVersion) return;
        }
        if (selectionUnavailable(action)) { await send({ type: 'locks-notice', message: `${text('Nicht verfügbar', 'Unavailable')}: ${selectionDescription(action)}` }); return; }
        if (action === 'copy-info') {
          await vscode.env.clipboard.writeText(selected.map(row => `${row.name}\tPID ${row.pid}\t${displayPath(row.executable)}\t${row.kind}\t${displayPath(row.file)}\t${row.started}\t${row.commandLine || ''}`).join('\n')); return;
        }
        if (!['unlock', 'terminate', 'copy', 'rename', 'delete', 'delete-processes', 'schedule'].includes(action)) return;
        if (['unlock', 'terminate', 'delete-processes'].includes(action) && !selected.length) throw new Error(text('Keine Prozesse ausgewählt.', 'No processes selected.'));
        let destination;
        if (action === 'copy' || action === 'rename') {
          const value = await vscode.window.showInputBox({ title: text('Vollständiger Zielpfad', 'Full destination path'), value: displayPath(folder), ignoreFocusOut: true });
          if (!value || closed) return; destination = normalizePath(value, { base: folder, input: true, platform: process.platform });
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
