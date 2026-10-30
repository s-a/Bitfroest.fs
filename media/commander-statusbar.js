(function (root) {
  'use strict';
  const { NotificationsModel, NotificationChangeType, Severity, StatusbarViewModel, StatusbarAlignment } = root.CommanderWorkbench;
  const icons = root.CommanderWorkbenchIcons;
  function create({ t, version, actions, focusList, onCancel, onLanguage }) {
    const bar = document.querySelector('#statusbar');
    bar.setAttribute('aria-label', t('Statusleiste'));
    bar.innerHTML = '<span id="status-message" role="status" aria-live="polite"></span><div id="status-progress-area" class="is-idle"><div id="status-progress-track" role="group"><span id="status-progress-overall" role="progressbar" aria-label=""></span><span id="status-progress-file" role="progressbar" aria-label=""></span></div></div><span class="status-cancel-slot"><button type="button" id="status-cancel" class="statusbar-item" hidden></button></span><nav id="functionbar" class="functionbar right-items items-container"></nav><button type="button" id="language-toggle" class="statusbar-item"></button><button type="button" id="notifications-toggle" class="statusbar-item" aria-controls="notifications-center" aria-expanded="false"></button>';
    const versionLabel = version ? `v${version}` : t('Vorschau');
    const functionbar = bar.querySelector('#functionbar'); functionbar.setAttribute('aria-label', t('Dateiaktionen'));
    for (const [key, label, command] of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'statusbar-item'; button.dataset.action = command;
      button.textContent = `${key} ${label}`;
      button.title = button.textContent; button.setAttribute('aria-label', button.textContent); functionbar.append(button);
    }
    const center = document.querySelector('#notifications-center'); center.setAttribute('aria-label', t('Benachrichtigungen'));
    center.innerHTML = '<div class="notifications-center-header"><span class="notifications-center-header-title"></span><div class="notifications-center-header-toolbar"><button type="button" id="notifications-clear"></button><button type="button" id="notifications-hide"></button></div></div><div id="notifications-list" class="notifications-list-container"></div><p id="notifications-empty"></p>';
    center.querySelector('.notifications-center-header-title').textContent = t('Benachrichtigungen');
    const empty = center.querySelector('#notifications-empty'); empty.textContent = t('Keine neuen Benachrichtigungen');
    const list = center.querySelector('#notifications-list'), toggle = bar.querySelector('#notifications-toggle');
    const clear = center.querySelector('#notifications-clear'), close = center.querySelector('#notifications-hide');
    function iconButton(button, icon, label) { button.innerHTML = icons[icon]; button.title = t(label); button.setAttribute('aria-label', t(label)); }
    iconButton(clear, 'clear-all', 'Alle Benachrichtigungen löschen'); iconButton(close, 'close', 'Benachrichtigungen schließen');
    const languageButton = bar.querySelector('#language-toggle');
    iconButton(languageButton, 'globe', 'Sprache wechseln'); languageButton.onclick = () => onLanguage?.();
    const model = new NotificationsModel(), rows = new Map(), unread = new Set();
    const storage = { get() {}, store() {}, remove() {}, onDidChangeValue: () => () => ({ dispose() {} }) };
    const navigation = new StatusbarViewModel(storage);
    const statusMessage = bar.querySelector('#status-message'), progressArea = bar.querySelector('#status-progress-area');
    const cancelButton = bar.querySelector('#status-cancel');
    cancelButton.textContent = t('Abbrechen'); cancelButton.title = t('Abbrechen'); cancelButton.setAttribute('aria-label', t('Abbrechen')); cancelButton.onclick = () => onCancel?.();
    const overallMeter = bar.querySelector('#status-progress-overall'), currentMeter = bar.querySelector('#status-progress-file'), progressTrack = bar.querySelector('#status-progress-track');
    let operation = null, disposed = false;
    const running = item => item.hasProgress && !item.progress.state.done;
    function updateProgressTrack(overall, file) {
      const overlap = Math.min(overall, file), extent = Math.max(overall, file);
      progressTrack.style.setProperty('--status-progress-overlap', `${overlap}%`);
      progressTrack.style.setProperty('--status-progress-extent', `${extent}%`);
      progressTrack.style.setProperty('--status-progress-unique', overall >= file
        ? 'var(--vscode-progressBar-background, var(--vscode-focusBorder))'
        : 'var(--vscode-charts-green, var(--vscode-charts-purple, var(--vscode-focusBorder)))');
    }
    function refresh() {
      empty.hidden = model.notifications.length > 0;
      clear.disabled = !model.notifications.some(item => !running(item));
      toggle.innerHTML = icons[unread.size ? 'bell-dot' : 'bell'];
      const label = t('Benachrichtigungen ({count})', { count: unread.size }); toggle.title = `${label} · ${versionLabel}`; toggle.setAttribute('aria-label', label);
      toggle.classList.toggle('has-unread', unread.size > 0);
    }
    function updateRow(item) {
      const row = rows.get(item); if (!row) return;
      row.querySelector('.notification-message').textContent = item.message.raw;
      row.dataset.severity = String(item.severity);
      row.querySelector('.notification-icon').innerHTML = icons[item.severity === Severity.Error ? 'error' : item.severity === Severity.Warning ? 'warning' : 'info'];
      row.querySelector('[data-notification-close]').hidden = running(item);
      row.classList.toggle('has-progress', running(item));
    }
    const subscription = model.onDidChangeNotification(event => {
      const { item, kind } = event;
      if (kind === NotificationChangeType.ADD) {
        const row = document.createElement('section'); row.className = 'notification-list-item'; row.tabIndex = 0;
        row.innerHTML = '<span class="notification-icon" aria-hidden="true"></span><div class="notification-content"><p class="notification-message"></p><div class="notification-details"></div></div><button type="button" data-notification-close></button>';
        const dismiss = row.querySelector('[data-notification-close]'); iconButton(dismiss, 'close', 'Benachrichtigung löschen');
        dismiss.onclick = () => { if (!running(item)) item.close(); };
        rows.set(item, row); list.prepend(row);
        if (center.hidden) unread.add(item); else item.updateVisibility(true);
      } else if (kind === NotificationChangeType.REMOVE) {
        const row = rows.get(item), hadFocus = row?.contains(document.activeElement);
        row?.remove(); rows.delete(item); unread.delete(item);
        if (hadFocus) (list.querySelector('section') || close).focus();
      }
      updateRow(item); refresh();
    });
    function show(focus = true) {
      center.hidden = false; center.classList.add('visible'); toggle.setAttribute('aria-expanded', 'true');
      unread.clear(); for (const item of model.notifications) item.updateVisibility(true); refresh();
      if (focus) (list.querySelector('section') || close).focus();
    }
    function hide(restoreFocus = true) {
      center.hidden = true; center.classList.remove('visible'); toggle.setAttribute('aria-expanded', 'false');
      for (const item of model.notifications) item.updateVisibility(false);
      if (restoreFocus) toggle.focus();
    }
    toggle.onclick = () => center.hidden ? show() : hide(); close.onclick = () => hide();
    clear.onclick = () => { for (const item of [...model.notifications]) if (!running(item)) item.close(); };
    const onCenterKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const items = [...list.children], current = items.findIndex(row => row.contains(document.activeElement));
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
        if (items[index]) { event.preventDefault(); items[index].focus(); }
      }
    };
    center.addEventListener('keydown', onCenterKey);
    const entries = [...bar.querySelectorAll('button')];
    for (const [index, button] of entries.entries()) navigation.add({ id: button.id || button.dataset.action, name: button.title, alignment: StatusbarAlignment.RIGHT, priority: { primary: entries.length - index, secondary: 0 }, container: button, labelContainer: button, hasCommand: true });
    const onBarKey = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); event.key === 'ArrowRight' ? navigation.focusNextEntry() : navigation.focusPreviousEntry(); }
      if (event.key === 'Escape') { event.preventDefault(); hide(false); focusList(); }
    };
    bar.addEventListener('keydown', onBarKey);
    function notify(message, severity = Severity.Info) {
      if (disposed || !message) return;
      const latest = model.notifications[0];
      if (latest && !running(latest) && latest.message.raw === String(message) && latest.severity === severity) return;
      const handle = model.addNotification({ message: String(message), severity });
      const stale = model.notifications.slice(100); for (const item of stale) if (!running(item)) item.close();
      return handle;
    }
    function setStatus(message) { statusMessage.textContent = message || ''; if (message) statusMessage.title = message; else statusMessage.removeAttribute('title'); }
    function setProgress({ id, title, statusPath, overallValueText, fileValueText, total, completed, fileTotal, fileCompleted, element, modal, cancelRequested, cancelAvailable = true }) {
      if (!operation || operation.id !== id) {
        if (!operation) {
          const handle = model.addNotification({ id, message: title, progress: { infinite: true } });
          operation = { id, handle, item: model.notifications[0], worked: 0 };
        } else { operation.id = id; operation.total = undefined; operation.worked = 0; operation.handle.progress.infinite(); }
      }
      operation.handle.updateMessage(title); setStatus(title); statusMessage.title = statusPath ? `${title}\n${statusPath}` : title;
      overallMeter.setAttribute('aria-label', t('Gesamtfortschritt')); currentMeter.setAttribute('aria-label', t('Fortschritt der aktuellen Datei'));
      overallMeter.setAttribute('aria-valuetext', overallValueText ? `${title}, ${overallValueText}` : title);
      currentMeter.setAttribute('aria-valuetext', fileValueText ? `${title}, ${fileValueText}` : title);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(completed)) {
        const worked = Math.max(0, Math.min(total, completed));
        if (operation.total !== total) { operation.total = total; operation.worked = 0; operation.handle.progress.total(total); }
        operation.handle.progress.worked(worked - operation.worked); operation.worked = worked;
        overallMeter.dataset.value = String(worked); overallMeter.dataset.maximum = String(total); overallMeter.style.width = `${worked / total * 100}%`;
        overallMeter.classList.remove('indeterminate');
        overallMeter.setAttribute('aria-valuenow', String(worked)); overallMeter.setAttribute('aria-valuemax', String(total));
      } else { operation.handle.progress.infinite(); overallMeter.style.width = '25%'; overallMeter.classList.add('indeterminate'); overallMeter.setAttribute('aria-valuetext', overallValueText ? `${title}, ${overallValueText}` : title); overallMeter.removeAttribute('aria-valuenow'); overallMeter.removeAttribute('aria-valuemax'); }
      if (Number.isFinite(fileTotal) && fileTotal > 0 && Number.isFinite(fileCompleted)) { const value = Math.min(fileCompleted, fileTotal); currentMeter.dataset.value = String(value); currentMeter.dataset.maximum = String(fileTotal); currentMeter.style.width = `${value / fileTotal * 100}%`; currentMeter.setAttribute('aria-valuenow', String(value)); currentMeter.setAttribute('aria-valuemax', String(fileTotal)); }
      else { currentMeter.style.width = '0%'; currentMeter.removeAttribute('aria-valuenow'); currentMeter.removeAttribute('aria-valuemax'); currentMeter.setAttribute('aria-valuetext', fileValueText ? `${title}, ${fileValueText}` : title); }
      updateProgressTrack(
        overallMeter.classList.contains('indeterminate') ? 0 : Number.parseFloat(overallMeter.style.width) || 0,
        Number.parseFloat(currentMeter.style.width) || 0
      );
      progressArea.classList.remove('is-idle');
      cancelButton.hidden = !cancelAvailable; cancelButton.disabled = Boolean(cancelRequested || !cancelAvailable);
      const row = rows.get(operation.item);
      if (!modal && element) { row.querySelector('.notification-details').append(element); row.classList.add('has-transfer'); }
    }
    function finishProgress({ message, severity = Severity.Info } = {}) {
      if (!operation) return;
      const current = operation; operation = null;
      current.handle.progress.done(); current.handle.updateSeverity(severity); current.handle.updateMessage(message || t('Dateioperation beendet'));
      setStatus(message || t('Dateioperation beendet'));
      rows.get(current.item)?.classList.remove('has-transfer');
      progressArea.classList.add('is-idle');
      cancelButton.hidden = true; cancelButton.disabled = false;
    }
    function reset() {
      operation = null; for (const item of [...model.notifications]) item.close();
      progressArea.classList.add('is-idle'); setStatus(''); hide(false); unread.clear(); refresh();
      cancelButton.hidden = true; cancelButton.disabled = false;
    }
    function dispose() {
      if (disposed) return; disposed = true; reset(); subscription.dispose(); model.dispose(); navigation.dispose();
      bar.removeEventListener('keydown', onBarKey); center.removeEventListener('keydown', onCenterKey);
    }
    const onPageHide = () => { dispose(); root.removeEventListener('pagehide', onPageHide); };
    root.addEventListener('pagehide', onPageHide, { once: true });
    refresh();
    return { notify, setProgress, setStatus, finishProgress, reset, dispose, error: message => notify(message, Severity.Error) };
  }
  root.CommanderStatusbar = { create };
})(window);
