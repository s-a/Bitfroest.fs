const fs = require('node:fs');
const crypto = require('node:crypto');
const { validateFavorites, validateColumns } = require('./media/configuration-model');
const { localizedCatalog, catalog } = require('./shortcut-settings');
const { validate: validateShortcuts } = require('./media/commander-shortcuts');

function createConfigurationEditor(vscode, context, options) {
  let panel, section = 'favorites', scope = 'user', saving = false;
  const revision = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const sendState = async () => {
    if (!panel) return;
    const data = options.read(scope);
    await panel.webview.postMessage({ type: 'configuration-state', section, scope, data, revision: revision(data), language: options.language(), workspace: options.workspace(), shortcutCatalog: localizedCatalog(options.language()), shortcutBase: options.shortcutBase?.(scope) || {}, platform: process.platform, settings: options.settings?.() || [] });
  };
  function open(requested) {
    section = ['columns', 'shortcuts', 'settings'].includes(requested) ? requested : 'favorites';
    if (panel) { panel.reveal(); panel.webview.postMessage({ type: 'configuration-section', section }); return; }
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel = vscode.window.createWebviewPanel('bitfroestConfiguration', options.t('Dateiverwaltung konfigurieren'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const current = panel;
    const nonce = crypto.randomBytes(18).toString('base64');
    const uri = name => current.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'configuration.html').fsPath, 'utf8');
    html = html.replace('<!--POLICY-->', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';">`);
    for (const name of ['configuration.css', 'commander-paths.js', 'commander-i18n.js', 'commander-column-settings.js', 'commander-shortcuts.js', 'shortcut-configuration.js', 'configuration-model.js', 'configuration-view.js']) html = html.replaceAll(`"${name}"`, `"${uri(name)}"`);
    html = html.replaceAll('<script ', `<script nonce="${nonce}" `);
    current.webview.html = html;
    current.onDidDispose(() => { if (panel === current) panel = undefined; });
    current.webview.onDidReceiveMessage(async message => {
      if (panel !== current) return;
      try {
        if (message?.type === 'configuration-open-setting' && typeof message.key === 'string') { await options.openSetting?.(message.key); return; }
        if (message?.type === 'configuration-ready' || message?.type === 'configuration-reload') { if (!saving) await sendState(); return; }
        if (message?.type === 'configuration-scope') {
          if (saving) return;
          if (!['user', 'workspace'].includes(message.scope) || message.scope === 'workspace' && !options.workspace()) throw new Error(options.t('Kein Arbeitsbereich geöffnet.'));
          scope = message.scope; await sendState(); return;
        }
        if (message?.type === 'configuration-browse') {
          if (saving || typeof message.id !== 'string' || typeof message.requestId !== 'string' || !['path', 'target'].includes(message.field)) return;
          const requestedScope = scope, requestedRevision = revision(options.read(scope));
          const value = await options.browse();
          if (panel === current && value && scope === requestedScope && revision(options.read(scope)) === requestedRevision) await current.webview.postMessage({ type: 'configuration-browsed', requestId: message.requestId, scope: requestedScope, id: message.id, field: message.field, value });
          return;
        }
        if (message?.type === 'configuration-save') {
          if (saving) return;
          if (message.scope !== scope || message.revision !== revision(options.read(scope))) throw new Error(options.t('Die Konfiguration wurde außerhalb dieses Editors geändert. Bitte neu laden.'));
          const data = { favorites: validateFavorites(message.data?.favorites), columns: validateColumns(message.data?.columns) };
          data.shortcuts = validateShortcuts(catalog, message.data?.shortcuts || {}, process.platform);
          saving = true;
          try { await options.write(data, scope); } finally { saving = false; }
          if (panel === current) await current.webview.postMessage({ type: 'configuration-saved', revision: revision(options.read(scope)), data: options.read(scope) });
          else if (panel) await sendState();
        }
      } catch (error) {
        if (panel && panel !== current) await sendState();
        if (panel) await panel.webview.postMessage({ type: 'configuration-error', error: options.t(error.message) });
      }
    });
  }
  const controller = { open, changed() { if (panel && !saving) panel.webview.postMessage({ type: 'configuration-changed' }); }, dispose() { panel?.dispose(); } };
  context.subscriptions.push(controller);
  return controller;
}
module.exports = { createConfigurationEditor };
