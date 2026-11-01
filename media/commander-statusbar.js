(function (root) {
  'use strict';
  const { NotificationsModel, NotificationChangeType, Severity, StatusbarViewModel, StatusbarAlignment } = root.CommanderWorkbench;
  const icons = name => root.CommanderIcons.svg('workbench', name);
  function create({ t, version, actions, focusList, onCancel, onLanguage, onCopyLog, getLogContext }) {
    /** @type {typeof import('./commander-progress')} */
    const Progress = root.CommanderProgress;
    const bar = document.querySelector('#statusbar');
    bar.setAttribute('aria-label', t('Statusleiste'));
    bar.innerHTML = '<div id="status-progress-region"><div id="status-progress-area" class="is-idle"><div id="status-progress-track" role="group" aria-hidden="true"><span id="status-progress-overall" role="progressbar" aria-label=""></span><span id="status-progress-file" role="progressbar" aria-label=""></span></div></div><div id="status-text-region"><span id="status-activity" role="status" aria-live="polite" hidden></span><span id="status-message" role="status" aria-live="polite"></span></div><div id="status-metrics" hidden><span id="status-percent"></span><span id="status-times"><span id="status-eta"></span><span aria-hidden="true">/</span><span id="status-elapsed"></span></span></div></div><span class="status-cancel-slot"><button type="button" id="status-cancel" class="statusbar-item" hidden></button></span>';
    const headerActions = document.querySelector('#header-actions');
    headerActions.setAttribute('aria-label', t('Dateiaktionen'));
    headerActions.innerHTML = '<nav id="functionbar" class="functionbar"></nav><div class="header-utilities"><button type="button" id="language-toggle" class="statusbar-item"></button><button type="button" id="notifications-toggle" class="statusbar-item" aria-controls="notifications-center" aria-expanded="false"></button></div>';
    const suppressContext = event => { event.preventDefault(); event.stopPropagation(); };
    bar.addEventListener('contextmenu', suppressContext);
    headerActions.dataset.vscodeContext = JSON.stringify({ webviewSection: 'fileActions', preventDefaultContextMenuItems: true });
    headerActions.addEventListener('contextmenu', suppressContext);
    const versionLabel = version ? `v${version}` : t('Vorschau');
    const functionbar = headerActions.querySelector('#functionbar'); functionbar.setAttribute('aria-label', t('Dateiaktionen'));
    for (const [key, label, command] of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'statusbar-item'; button.dataset.action = command;
      button.textContent = `${key} ${label}`;
      button.title = button.textContent; button.setAttribute('aria-label', button.textContent); functionbar.append(button);
    }
    const center = document.querySelector('#notifications-center'); center.setAttribute('aria-label', t('Benachrichtigungen'));
    center.innerHTML = '<div class="notifications-center-header"><span class="notifications-center-header-title"></span><div class="notifications-center-header-toolbar"><button type="button" id="notifications-clear"></button><button type="button" id="notifications-hide"></button></div></div><div id="notifications-list" class="notifications-list-container"></div><p id="notifications-empty"></p>';
    center.querySelector('.notifications-center-header-title').textContent = t('Benachrichtigungen');
    const empty = center.querySelector('#notifications-empty'); empty.textContent = t('Keine neuen Benachrichtigungen');
    const list = center.querySelector('#notifications-list'), toggle = headerActions.querySelector('#notifications-toggle');
    const clear = center.querySelector('#notifications-clear'), close = center.querySelector('#notifications-hide');
    function iconButton(button, icon, label) { button.innerHTML = icons(icon); button.title = t(label); button.setAttribute('aria-label', t(label)); }
    iconButton(clear, 'clear-all', 'Alle Benachrichtigungen löschen'); iconButton(close, 'close', 'Benachrichtigungen schließen');
    const languageButton = headerActions.querySelector('#language-toggle');
    iconButton(languageButton, 'globe', 'Sprache wechseln'); languageButton.onclick = () => onLanguage?.();
    const model = new NotificationsModel(), rows = new Map(), unread = new Set();
    const storage = { get() {}, store() {}, remove() {}, onDidChangeValue: () => () => ({ dispose() {} }) };
    const navigation = new StatusbarViewModel(storage);
    const statusMessage = bar.querySelector('#status-message'), progressArea = bar.querySelector('#status-progress-area');
    const cancelButton = bar.querySelector('#status-cancel');
    iconButton(cancelButton, 'close', 'Abbrechen'); cancelButton.onclick = () => onCancel?.();
    const overallMeter = bar.querySelector('#status-progress-overall'), currentMeter = bar.querySelector('#status-progress-file'), progressTrack = bar.querySelector('#status-progress-track');
    const metrics = bar.querySelector('#status-metrics'), percent = bar.querySelector('#status-percent');
    const eta = bar.querySelector('#status-eta'), elapsed = bar.querySelector('#status-elapsed');
    let operation = null, background = null, activityProgress = null, disposed = false, statusVersion = 0, activityText = '', clockTimer = null;
    const reports = new Map(), messages = []; let omittedMessages = 0, omittedOperations = 0, copyTimer = null, copyState = '', copyError = '';
    function rememberMessage(message, outcome) {
      if (!message || messages.at(-1)?.message === message && messages.at(-1)?.outcome === outcome) return;
      messages.push({ timestamp: new Date().toISOString(), message: String(message), outcome });
      if (messages.length > 128) { messages.shift(); omittedMessages++; }
    }
    function rememberProgress(progress) {
      if (!progress) return;
      reports.delete(progress.id); reports.set(progress.id, progress);
      if (reports.size > 8) { reports.delete(reports.keys().next().value); omittedOperations++; }
    }
    function copyAppearance(button) {
      const label = copyState === 'copied' ? 'Meldung und Protokoll kopiert.' : copyState === 'error' ? 'Protokoll konnte nicht kopiert werden.' : copyState === 'pending' ? 'Protokoll wird kopiert…' : 'Meldung und Arbeitsprotokoll kopieren';
      button.dataset.copyState = copyState; button.dataset.copyLabel = copyState === 'copied' ? t('Kopiert') : copyState === 'error' ? t('Kopieren fehlgeschlagen') : '';
      button.disabled = copyState === 'pending' || !onCopyLog;
      button.title = t(label) + (copyError ? ` ${copyError}` : ''); button.setAttribute('aria-label', button.title);
    }
    function showCopyState(value, error = '') {
      copyState = value; copyError = error;
      for (const button of bar.querySelectorAll('[data-status-icon]')) copyAppearance(button);
    }
    async function copyLog(target) {
      if (disposed || copyState === 'pending' || !onCopyLog) return;
      if (copyTimer !== null) { root.clearTimeout(copyTimer); copyTimer = null; }
      const currentMessage = target.querySelector('[data-status-text]')?.textContent || '';
      showCopyState('pending');
      try {
        const report = { formatVersion: 1, capturedAt: new Date().toISOString(), extensionVersion: version, currentMessage, context: getLogContext?.() || {}, messages: [...messages], omittedMessages, omittedOperations,
          operations: [...reports.values()].map(progress => {
            const details = Progress.statusReport(progress);
            return { id: progress.id, startedAt: progress.startedAt, elapsedMs: details.plan.state === 'running' ? Math.max(0, root.performance.now() - progress.startedAt) : details.events.at(-1)?.elapsedMs, lastDisplayedSnapshot: progress, ...details };
          }) };
        await onCopyLog(JSON.stringify(report, null, 2)); if (!disposed) showCopyState('copied');
      }
      catch (error) { if (!disposed) showCopyState('error', String(error.message || error)); }
      if (!disposed) copyTimer = root.setTimeout(() => { copyTimer = null; showCopyState(''); }, 2500);
    }
    function updateColors() {
      if (!operation && !background) return;
      const style = root.getComputedStyle(bar);
      const colors = root.CommanderContrast.progressColors(style.color, style.backgroundColor, style.getPropertyValue('--vscode-progressBar-background').trim() || '#007fd4');
      for (const [property, value] of [['--status-progress-fill', colors?.fill], ['--status-progress-foreground', colors?.foreground]]) {
        if (value) bar.style.setProperty(property, value); else bar.style.removeProperty(property);
      }
    }
    const themeObserver = new root.MutationObserver(updateColors);
    for (const target of [document.documentElement, document.body]) themeObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id', 'data-vscode-theme-kind'] });
    function duration(seconds) {
      const value = Math.max(0, Math.floor(seconds)), hours = Math.floor(value / 3600);
      const minutes = String(Math.floor(value / 60) % 60).padStart(2, '0'), remainder = String(value % 60).padStart(2, '0');
      return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
    }
    function renderClock() {
      const active = operation || background;
      if (!active) return;
      const now = root.performance.now();
      elapsed.textContent = duration((now - active.started) / 1000);
      const remaining = active.estimate === undefined ? undefined : Math.ceil((active.estimate - now) / 1000);
      eta.textContent = remaining !== undefined && remaining >= 0 ? duration(remaining) : '—';
      eta.title = t('Geschätzte Restdauer'); elapsed.title = t('Bisherige Laufzeit');
      eta.setAttribute('aria-label', `${eta.title}: ${eta.textContent}`); elapsed.setAttribute('aria-label', `${elapsed.title}: ${elapsed.textContent}`);
    }
    function stopClock() { if (clockTimer !== null) root.clearInterval(clockTimer); clockTimer = null; metrics.hidden = true; }
    function updateEstimate(total, completed, phase, cancelRequested, active = operation) {
      const now = root.performance.now(), valid = Number.isFinite(total) && total > 0 && Number.isFinite(completed);
      const value = valid ? Math.max(0, Math.min(total, completed)) : undefined;
      const sample = active.sample;
      if (!valid || cancelRequested) { active.sample = undefined; active.estimate = undefined; }
      else if (!sample || sample.total !== total || sample.phase !== phase || value < sample.latest) {
        active.sample = { total, completed: value, phase, started: now, latest: value }; active.estimate = undefined;
      } else if (value !== sample.latest) {
        sample.latest = value;
        const worked = value - sample.completed, seconds = (now - sample.started) / 1000;
        active.estimate = worked > 0 && seconds > 0 ? now + (total - value) / (worked / seconds) * 1000 : undefined;
      }
      renderClock();
    }
    const activity = bar.querySelector('#status-activity');
    function setActivity(message, progress = null) {
      if (disposed) return;
      if (message) Progress.readStatus(progress);
      if (message) rememberProgress(progress);
      activityText = message || '';
      activityProgress = progress;
      if (activity.textContent !== activityText) { renderStatus(activity, activityText, 'info'); }
      activity.hidden = !activityText || Boolean(operation);
      if (operation) return;
      if (!activityText || !progress) {
        background = null; stopClock(); bar.dataset.statusProgressOwner = 'idle'; progressArea.classList.add('is-idle'); progressTrack.setAttribute('aria-hidden', 'true'); return;
      }
      const event = Progress.readStatus(progress);
      bar.dataset.statusProgressOwner = 'background';
      const identity = event.plan.id;
      const newActivity = !background || background.id !== identity;
      if (newActivity) background = { id: identity, started: event.startedAt };
      if (clockTimer === null) clockTimer = root.setInterval(renderClock, 1000);
      const parts = [];
      const descriptions = [];
      for (const [meter, measurement, percentage] of [[overallMeter, event.overall, event.display.overallPercent], [currentMeter, event.current, event.display.currentPercent]]) {
        const known = measurement.kind === 'determinate';
        const value = percentage === null ? undefined : percentage;
        meter.style.width = value === undefined ? '0%' : `${value}%`;
        meter.classList.toggle('indeterminate', !known && meter === overallMeter);
        meter.setAttribute('aria-valuemin', '0');
        meter.setAttribute('aria-label', t(meter === overallMeter ? 'Gesamtfortschritt' : 'Fortschritt des aktuellen Schritts'));
        const units = { bytes: 'Bytes', items: 'Einträge', requests: 'Bestätigte Aufträge', steps: 'Programmschritte' };
        const reasons = { enumerating: 'Gesamtmenge wird ermittelt', 'stream-size-unknown': 'Streamgröße unbekannt', 'native-operation': 'Betriebssystemvorgang ohne Mengenangabe', 'awaiting-confirmation': 'Hostbestätigung' };
        const description = `${measurement.completed}${known ? ` / ${measurement.total}` : ''} ${t(units[measurement.unit])}${known ? '' : ` · ${t(reasons[measurement.reason])}`}`;
        meter.setAttribute('aria-valuetext', description); descriptions.push(description);
        if (known) { meter.setAttribute('aria-valuenow', String(measurement.completed)); meter.setAttribute('aria-valuemax', String(measurement.total)); }
        else { meter.removeAttribute('aria-valuenow'); meter.removeAttribute('aria-valuemax'); }
        parts.push(value === undefined ? '—' : `${Math.floor(value)}%`);
      }
      percent.textContent = parts.join('/'); percent.title = descriptions.join(' · ');
      metrics.hidden = false; progressArea.classList.remove('is-idle'); progressTrack.removeAttribute('aria-hidden');
      updateEstimate(event.overall.kind === 'determinate' ? event.overall.total : undefined, event.overall.completed, event.phase, false, background);
      if (newActivity) updateColors();
    }
    const running = item => item.hasProgress && !item.progress.state.done;
    function refresh() {
      empty.hidden = model.notifications.length > 0;
      clear.disabled = !model.notifications.some(item => !running(item));
      toggle.innerHTML = icons(unread.size ? 'bell-dot' : 'bell');
      const label = t('Benachrichtigungen ({count})', { count: unread.size }); toggle.title = `${label} · ${versionLabel}`; toggle.setAttribute('aria-label', label);
      toggle.classList.toggle('has-unread', unread.size > 0);
    }
    function updateRow(item) {
      const row = rows.get(item); if (!row) return;
      row.querySelector('.notification-message').textContent = item.message.raw;
      row.dataset.severity = String(item.severity);
      row.querySelector('.notification-icon').innerHTML = icons(item.severity === Severity.Error ? 'error' : item.severity === Severity.Warning ? 'warning' : 'info');
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
    function placeCenter() {
      if (!center.hidden) {
        const top = `${document.querySelector('.commander-header').getBoundingClientRect().bottom}px`;
        center.style.top = top; center.style.setProperty('--notification-top', top);
      }
    }
    root.addEventListener('resize', placeCenter);
    function show(focus = true) {
      center.hidden = false; center.classList.add('visible'); toggle.setAttribute('aria-expanded', 'true');
      placeCenter();
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
    const entries = [...headerActions.querySelectorAll('button')];
    for (const [index, button] of entries.entries()) navigation.add({ id: button.id || button.dataset.action, name: button.title, alignment: StatusbarAlignment.RIGHT, priority: { primary: entries.length - index, secondary: 0 }, container: button, labelContainer: button, hasCommand: true });
    const onBarKey = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (['Enter', ' '].includes(event.key) && event.target.closest('button')) { event.preventDefault(); event.stopPropagation(); event.target.closest('button').click(); return; }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); event.key === 'ArrowRight' ? navigation.focusNextEntry() : navigation.focusPreviousEntry(); }
      if (event.key === 'Escape') { event.preventDefault(); hide(false); focusList(); }
    };
    headerActions.addEventListener('keydown', onBarKey);
    bar.addEventListener('keydown', onBarKey);
    function notify(message, severity = Severity.Info, id) {
      if (disposed || !message) return;
      rememberMessage(message, `notification:${severity}`);
      const latest = model.notifications[0];
      if (!id && latest && !running(latest) && latest.message.raw === String(message) && latest.severity === severity) return;
      const handle = model.addNotification({ id, message: String(message), severity });
      const stale = model.notifications.slice(100); for (const item of stale) if (!running(item)) item.close();
      return handle;
    }
    function renderStatus(target, message, outcome = 'info') {
      rememberMessage(message, outcome);
      const level = ['info', 'success', 'warning', 'error', 'cancelled'].includes(outcome) ? outcome : 'info';
      target.dataset.outcome = level;
      target.replaceChildren();
      if (message) {
        const icon = document.createElement('button'); icon.type = 'button'; icon.dataset.statusIcon = ''; copyAppearance(icon);
        icon.innerHTML = (level === 'success' ? root.CommanderIcons.svg('status', 'clean') : icons({ info: 'info', warning: 'warning', error: 'error', cancelled: 'close' }[level])).replace(/>\s+</g, '><');
        icon.querySelector('svg')?.setAttribute('aria-hidden', 'true');
        icon.onclick = event => { event.stopPropagation(); void copyLog(target); };
        target.append(icon);
      }
      const text = document.createElement('span'); text.dataset.statusText = ''; text.textContent = message || ''; target.append(text);
      if (message) {
        target.title = message;
        const labels = { info: 'Information: {message}', success: 'Erfolgreich: {message}', warning: 'Warnung: {message}', error: 'Fehler: {message}', cancelled: 'Abgebrochen: {message}' };
        target.setAttribute('aria-label', t(labels[level], { message }));
      } else { target.removeAttribute('title'); target.removeAttribute('aria-label'); }
    }
    function setStatus(message, outcome = 'info') {
      statusVersion++;
      renderStatus(statusMessage, message, outcome);
    }
    function setProgress(input) {
      const { quiet = false, title, statusTitle = title, progress, statusPath, overallValueText, fileValueText, element, modal, cancelRequested, cancelAvailable = true } = input;
      if (disposed) return;
      const event = Progress.readStatus(progress);
      rememberProgress(event);
      if (['id', 'phase', 'total', 'completed', 'fileTotal', 'fileCompleted'].some(field => Object.hasOwn(input, field))) throw new TypeError('Independent status counters and identities are not allowed');
      const id = event.plan.id, phase = event.phase;
      const total = event.overall.kind === 'determinate' ? event.overall.total : undefined, completed = event.overall.completed;
      const fileTotal = event.current.kind === 'determinate' ? event.current.total : undefined, fileCompleted = event.current.completed;
      bar.dataset.statusProgressOwner = 'transfer';
      if (!operation || operation.id !== id) {
        if (!operation) {
          const noop = () => {};
          const handle = quiet ? { progress: { infinite: noop, total: noop, worked: noop, done: noop }, updateMessage: noop, updateSeverity: noop, close: noop } : model.addNotification({ id, message: title, progress: { infinite: true } });
          operation = { id, quiet, handle, item: quiet ? null : model.notifications[0], worked: 0, started: event.startedAt };
          if (clockTimer === null) clockTimer = root.setInterval(renderClock, 1000);
        } else { operation.id = id; operation.total = undefined; operation.worked = 0; operation.sample = undefined; operation.estimate = undefined; operation.handle.progress.infinite(); }
      }
      setActivity(activityText, activityProgress);
      operation.handle.updateMessage(title); setStatus(statusPath ? `${statusTitle} · ${statusPath}` : title); statusMessage.title = statusPath ? `${title}\n${statusPath}` : title;
      if (statusPath) {
        const text = statusMessage.querySelector('[data-status-text]'), split = Math.max(statusPath.lastIndexOf('/'), statusPath.lastIndexOf('\\')) + 1;
        text.replaceChildren();
        for (const [part, value] of [['operation', `${statusTitle} · `], ['directory', statusPath.slice(0, split)], ['name', statusPath.slice(split)]]) {
          const span = document.createElement('span'); span.dataset[`progress${part[0].toUpperCase()}${part.slice(1)}`] = ''; span.textContent = value; text.append(span);
        }
      }
      metrics.hidden = false;
      percent.title = `${t('Gesamtfortschritt')} / ${t('Fortschritt des aktuellen Schritts')}`;
      percent.setAttribute('aria-label', percent.title);
      eta.title = t('Geschätzte Restdauer'); elapsed.title = t('Bisherige Laufzeit');
      updateEstimate(total, completed, phase, cancelRequested);
      overallMeter.setAttribute('aria-label', t('Gesamtfortschritt')); currentMeter.setAttribute('aria-label', t('Fortschritt des aktuellen Schritts'));
      overallMeter.setAttribute('aria-valuetext', overallValueText ? `${title}, ${overallValueText}` : title);
      currentMeter.setAttribute('aria-valuetext', fileValueText ? `${title}, ${fileValueText}` : title);
      if (Number.isFinite(total) && total >= 0 && Number.isFinite(completed)) {
        const worked = completed;
        if (operation.total !== total) { operation.total = total; operation.worked = 0; operation.handle.progress.total(total); }
        operation.handle.progress.worked(worked - operation.worked); operation.worked = worked;
        overallMeter.dataset.value = String(worked); overallMeter.dataset.maximum = String(total); overallMeter.style.width = `${event.display.overallPercent}%`;
        overallMeter.classList.remove('indeterminate');
        overallMeter.setAttribute('aria-valuenow', String(worked)); overallMeter.setAttribute('aria-valuemax', String(total));
      } else { operation.handle.progress.infinite(); overallMeter.style.width = '0%'; overallMeter.classList.add('indeterminate'); overallMeter.setAttribute('aria-valuetext', overallValueText ? `${title}, ${overallValueText}` : title); overallMeter.removeAttribute('aria-valuenow'); overallMeter.removeAttribute('aria-valuemax'); }
      if (Number.isFinite(fileTotal) && fileTotal >= 0 && Number.isFinite(fileCompleted)) { const value = fileCompleted; currentMeter.dataset.value = String(value); currentMeter.dataset.maximum = String(fileTotal); currentMeter.style.width = `${event.display.currentPercent}%`; currentMeter.setAttribute('aria-valuenow', String(value)); currentMeter.setAttribute('aria-valuemax', String(fileTotal)); }
      else { currentMeter.style.width = '0%'; currentMeter.removeAttribute('aria-valuenow'); currentMeter.removeAttribute('aria-valuemax'); currentMeter.setAttribute('aria-valuetext', fileValueText ? `${title}, ${fileValueText}` : title); }
      const percentage = value => value === null ? '—' : `${Math.floor(value)}%`;
      percent.textContent = `${percentage(event.display.overallPercent)}/${percentage(event.display.currentPercent)}`;
      overallMeter.setAttribute('aria-valuemin', '0'); currentMeter.setAttribute('aria-valuemin', '0');
      if (progressArea.classList.contains('is-idle')) updateColors();
      progressArea.classList.remove('is-idle'); progressTrack.removeAttribute('aria-hidden');
      cancelButton.hidden = !cancelAvailable; cancelButton.disabled = Boolean(cancelRequested || !cancelAvailable);
      const row = rows.get(operation.item);
      if (row && !modal && element) { row.querySelector('.notification-details').append(element); row.classList.add('has-transfer'); }
    }
    function finishProgress({ message, severity = Severity.Info, outcome = 'info', progress } = {}) {
      if (!operation) return;
      const snapshot = Progress.readFinishedStatus(progress);
      rememberProgress(snapshot);
      if (snapshot.plan.id !== operation.id) throw new TypeError('Status plan does not match the active operation');
      const current = operation; operation = null; stopClock();
      current.handle.progress.done(); current.handle.updateSeverity(severity); current.handle.updateMessage(message || t('Dateioperation beendet'));
      setStatus(message || t('Dateioperation beendet'), severity === Severity.Error ? 'error' : outcome);
      rows.get(current.item)?.classList.remove('has-transfer');
      progressArea.classList.add('is-idle'); progressTrack.setAttribute('aria-hidden', 'true');
      cancelButton.hidden = true; cancelButton.disabled = false;
      setActivity(activityText, activityProgress);
    }
    function reset() {
      operation = null; background = null; activityProgress = null; stopClock();
      bar.dataset.statusProgressOwner = 'idle';
      activityText = ''; activity.hidden = true; activity.textContent = '';
      for (const item of [...model.notifications]) item.close();
      progressArea.classList.add('is-idle'); progressTrack.setAttribute('aria-hidden', 'true'); setStatus(''); hide(false); unread.clear(); refresh();
      cancelButton.hidden = true; cancelButton.disabled = false;
    }
    function dispose() {
      if (disposed) return; disposed = true; reset(); themeObserver.disconnect(); subscription.dispose(); model.dispose(); navigation.dispose();
      if (copyTimer !== null) root.clearTimeout(copyTimer);
      reports.clear(); messages.length = 0;
      root.removeEventListener('resize', placeCenter); bar.removeEventListener('contextmenu', suppressContext); headerActions.removeEventListener('contextmenu', suppressContext); headerActions.removeEventListener('keydown', onBarKey);
      bar.removeEventListener('keydown', onBarKey); center.removeEventListener('keydown', onCenterKey);
    }
    const onPageHide = () => { dispose(); root.removeEventListener('pagehide', onPageHide); };
    root.addEventListener('pagehide', onPageHide, { once: true });
    setStatus(''); refresh();
    return { notify, setProgress, setStatus, setActivity, finishProgress, reset, dispose, get version() { return statusVersion; },
      success: message => setStatus(message, 'success'),
      error: message => { setStatus(message, 'error'); return notify(message, Severity.Error); } };
  }
  root.CommanderStatusbar = { create };
})(window);
