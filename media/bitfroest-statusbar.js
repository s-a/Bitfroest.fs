(function (root) {
  'use strict';
  const { Severity, StatusbarViewModel, StatusbarAlignment } = root.BitfroestWorkbench;
  const icons = name => root.BitfroestIcons.svg('workbench', name);
  function create({ t, version, actions, focusList, onCancel, onLanguage, onCopyLog, getLogContext }) {
    /** @type {typeof import('./bitfroest-progress')} */
    const Progress = root.BitfroestProgress;
    const bar = document.querySelector('#statusbar');
    bar.setAttribute('aria-label', t('Statusleiste'));
    bar.innerHTML = '<div id="status-progress-region"><div id="status-progress-area" class="is-idle"><div id="status-progress-track" role="group" aria-hidden="true"><span id="status-progress-overall" role="progressbar" aria-label=""></span><span id="status-progress-file" role="progressbar" aria-label=""></span></div></div><div id="status-text-region"><span id="status-activity" role="status" aria-live="polite" hidden><span data-status-text></span></span><span id="status-message" role="status" aria-live="polite" hidden></span></div><div id="status-metrics" hidden><span id="status-percent"></span><span id="status-times"><span id="status-eta"></span><span aria-hidden="true">/</span><span id="status-elapsed"></span></span></div></div><span class="status-cancel-slot"><button type="button" id="status-cancel" class="statusbar-item" hidden></button></span>';
    const headerActions = document.querySelector('#header-actions');
    headerActions.setAttribute('aria-label', t('Dateiaktionen'));
    headerActions.innerHTML = '<nav id="functionbar" class="functionbar"></nav><div class="header-utilities"><button type="button" id="language-toggle" class="statusbar-item"></button><button type="button" id="activity-log-copy" class="statusbar-item"></button></div>';
    const suppressContext = event => { event.preventDefault(); event.stopPropagation(); };
    bar.addEventListener('contextmenu', suppressContext);
    headerActions.dataset.vscodeContext = JSON.stringify({ webviewSection: 'fileActions', preventDefaultContextMenuItems: true });
    headerActions.addEventListener('contextmenu', suppressContext);
    const functionbar = headerActions.querySelector('#functionbar'); functionbar.setAttribute('aria-label', t('Dateiaktionen'));
    for (const [key, label, command] of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'statusbar-item'; button.dataset.action = command;
      button.textContent = `${key} ${label}`;
      button.title = button.textContent; button.setAttribute('aria-label', button.textContent); functionbar.append(button);
    }
    const copyButton = headerActions.querySelector('#activity-log-copy');
    function iconButton(button, icon, label) { button.innerHTML = icons(icon); button.title = t(label); button.setAttribute('aria-label', t(label)); }
    iconButton(copyButton, 'bell', 'Aktivitätsprotokoll kopieren');
    copyButton.onclick = () => void copyLog();
    const languageButton = headerActions.querySelector('#language-toggle');
    iconButton(languageButton, 'globe', 'Sprache wechseln'); languageButton.onclick = () => onLanguage?.();
    const storage = { get() {}, store() {}, remove() {}, onDidChangeValue: () => () => ({ dispose() {} }) };
    const navigation = new StatusbarViewModel(storage);
    const statusMessage = bar.querySelector('#status-message'), progressArea = bar.querySelector('#status-progress-area');
    const cancelButton = bar.querySelector('#status-cancel');
    iconButton(cancelButton, 'close', 'Abbrechen'); cancelButton.onclick = () => onCancel?.();
    const overallMeter = bar.querySelector('#status-progress-overall'), currentMeter = bar.querySelector('#status-progress-file'), progressTrack = bar.querySelector('#status-progress-track');
    const metrics = bar.querySelector('#status-metrics'), percent = bar.querySelector('#status-percent');
    const eta = bar.querySelector('#status-eta'), elapsed = bar.querySelector('#status-elapsed');
    let operation = null, background = null, activityProgress = null, disposed = false, statusVersion = 0, activityText = '', clockTimer = null;
    const reports = new Map(), messages = []; let omittedMessages = 0, omittedOperations = 0, copyTimer = null, copyState = '', currentMessage = '';
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
    function showCopyState(value, error = '') {
      copyState = value;
      const label = value === 'copied' ? 'Aktivitätsprotokoll kopiert.' : value === 'error' ? 'Protokoll konnte nicht kopiert werden.' : value === 'pending' ? 'Protokoll wird kopiert…' : 'Aktivitätsprotokoll kopieren';
      copyButton.dataset.copyState = value;
      copyButton.setAttribute('aria-disabled', String(value === 'pending' || !onCopyLog));
      iconButton(copyButton, value === 'error' ? 'error' : 'bell', label);
      if (value === 'copied') copyButton.innerHTML = root.BitfroestIcons.svg('status', 'clean');
      if (error) copyButton.title += ' ' + error;
    }
    async function copyLog() {
      if (disposed || copyState === 'pending' || !onCopyLog) return;
      if (copyTimer !== null) { root.clearTimeout(copyTimer); copyTimer = null; }
      showCopyState('pending');
      try {
        const report = { formatVersion: 1, capturedAt: new Date().toISOString(), extensionVersion: version, currentMessage: currentMessage || statusMessage.textContent || activityText, context: getLogContext?.() || {}, messages: [...messages], omittedMessages, omittedOperations,
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
      const colors = root.BitfroestContrast.progressColors(style.color, style.backgroundColor, style.getPropertyValue('--vscode-progressBar-background').trim() || '#007fd4');
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
    const activityLabel = activity.querySelector('[data-status-text]');
    function measurementText(measurement) {
      const units = { bytes: 'Bytes', items: 'Einträge', requests: 'Bestätigte Aufträge', steps: 'Programmschritte' };
      const reasons = { enumerating: 'Gesamtmenge wird ermittelt', 'stream-size-unknown': 'Streamgröße unbekannt', 'native-operation': 'Betriebssystemvorgang ohne Mengenangabe', 'awaiting-confirmation': 'Hostbestätigung', 'remaining-work-unknown': 'Gesamtmenge der weiteren Arbeitsschritte unbekannt' };
      const known = measurement.kind === 'determinate';
      return `${measurement.completed}${known ? ` / ${measurement.total}` : ''} ${t(units[measurement.unit])}${known ? '' : ` · ${t(reasons[measurement.reason])}`}`;
    }
    function setActivity(message, progress = null) {
      if (disposed) return;
      if (message) Progress.readStatus(progress);
      if (message) rememberProgress(progress);
      activityText = message || '';
      activityProgress = progress;
      if (activityLabel.textContent !== activityText) { activityLabel.textContent = activityText; rememberMessage(activityText, 'info'); }
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
        const description = measurementText(measurement);
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
    const entries = [...headerActions.querySelectorAll('button')];
    for (const [index, button] of entries.entries()) navigation.add({ id: button.id || button.dataset.action, name: button.title, alignment: StatusbarAlignment.RIGHT, priority: { primary: entries.length - index, secondary: 0 }, container: button, labelContainer: button, hasCommand: true });
    const onBarKey = event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (['Enter', ' '].includes(event.key) && event.target.closest('button')) { event.preventDefault(); event.stopPropagation(); event.target.closest('button').click(); return; }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); event.key === 'ArrowRight' ? navigation.focusNextEntry() : navigation.focusPreviousEntry(); }
      if (event.key === 'Escape') { event.preventDefault(); focusList(); }
    };
    headerActions.addEventListener('keydown', onBarKey);
    bar.addEventListener('keydown', onBarKey);
    function setStatus(message, outcome = 'info') {
      statusVersion++;
      currentMessage = message || '';
      rememberMessage(message, outcome);
    }
    function setProgress(input) {
      const { title, statusTitle = title, progress, statusPath, overallValueText, fileValueText, cancelRequested, cancelAvailable = true } = input;
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
          operation = { id, started: event.startedAt };
          if (clockTimer === null) clockTimer = root.setInterval(renderClock, 1000);
        } else { operation.id = id; operation.sample = undefined; operation.estimate = undefined; }
      }
      setActivity(activityText, activityProgress);
      setStatus(statusPath ? `${statusTitle} · ${statusPath}` : title);
      statusMessage.hidden = false;
      statusMessage.title = statusPath ? `${title}\n${statusPath}` : title;
      const text = document.createElement('span'); text.dataset.statusText = '';
      statusMessage.replaceChildren(text);
      if (statusPath) {
        const split = Math.max(statusPath.lastIndexOf('/'), statusPath.lastIndexOf('\\')) + 1;
        for (const [part, value] of [['operation', `${statusTitle} · `], ['directory', statusPath.slice(0, split)], ['name', statusPath.slice(split)]]) {
          const span = document.createElement('span'); span.dataset[`progress${part[0].toUpperCase()}${part.slice(1)}`] = ''; span.textContent = value; text.append(span);
        }
      } else text.textContent = title;
      metrics.hidden = false;
      percent.title = `${t('Gesamtfortschritt')} / ${t('Fortschritt des aktuellen Schritts')}`;
      percent.setAttribute('aria-label', percent.title);
      eta.title = t('Geschätzte Restdauer'); elapsed.title = t('Bisherige Laufzeit');
      updateEstimate(total, completed, phase, cancelRequested);
      overallMeter.setAttribute('aria-label', t('Gesamtfortschritt')); currentMeter.setAttribute('aria-label', t('Fortschritt des aktuellen Schritts'));
      const valueText = (measurement, supplied) => measurement.kind === 'indeterminate' ? `${title}, ${measurementText(measurement)}` : supplied ? `${title}, ${supplied}` : title;
      overallMeter.setAttribute('aria-valuetext', valueText(event.overall, overallValueText));
      currentMeter.setAttribute('aria-valuetext', valueText(event.current, fileValueText));
      if (Number.isFinite(total) && total >= 0 && Number.isFinite(completed)) {
        const worked = completed;
        overallMeter.dataset.value = String(worked); overallMeter.dataset.maximum = String(total); overallMeter.style.width = `${event.display.overallPercent}%`;
        overallMeter.classList.remove('indeterminate');
        overallMeter.setAttribute('aria-valuenow', String(worked)); overallMeter.setAttribute('aria-valuemax', String(total));
      } else { overallMeter.style.width = '0%'; overallMeter.classList.add('indeterminate'); overallMeter.removeAttribute('aria-valuenow'); overallMeter.removeAttribute('aria-valuemax'); }
      if (Number.isFinite(fileTotal) && fileTotal >= 0 && Number.isFinite(fileCompleted)) { const value = fileCompleted; currentMeter.dataset.value = String(value); currentMeter.dataset.maximum = String(fileTotal); currentMeter.style.width = `${event.display.currentPercent}%`; currentMeter.setAttribute('aria-valuenow', String(value)); currentMeter.setAttribute('aria-valuemax', String(fileTotal)); }
      else { currentMeter.style.width = '0%'; currentMeter.removeAttribute('aria-valuenow'); currentMeter.removeAttribute('aria-valuemax'); }
      const percentage = value => value === null ? '—' : `${Math.floor(value)}%`;
      percent.textContent = `${percentage(event.display.overallPercent)}/${percentage(event.display.currentPercent)}`;
      overallMeter.setAttribute('aria-valuemin', '0'); currentMeter.setAttribute('aria-valuemin', '0');
      if (progressArea.classList.contains('is-idle')) updateColors();
      progressArea.classList.remove('is-idle'); progressTrack.removeAttribute('aria-hidden');
      cancelButton.hidden = !cancelAvailable; cancelButton.disabled = Boolean(cancelRequested || !cancelAvailable);
    }
    function finishProgress({ message, severity = Severity.Info, outcome = 'info', progress } = {}) {
      if (!operation) return;
      const snapshot = Progress.readFinishedStatus(progress);
      rememberProgress(snapshot);
      if (snapshot.plan.id !== operation.id) throw new TypeError('Status plan does not match the active operation');
      operation = null; stopClock();
      statusMessage.hidden = true; statusMessage.replaceChildren(); statusMessage.removeAttribute('title');
      setStatus(message || t('Dateioperation beendet'), severity === Severity.Error ? 'error' : outcome);
      progressArea.classList.add('is-idle'); progressTrack.setAttribute('aria-hidden', 'true');
      cancelButton.hidden = true; cancelButton.disabled = false;
      setActivity(activityText, activityProgress);
    }
    function reset() {
      operation = null; background = null; activityProgress = null; stopClock();
      bar.dataset.statusProgressOwner = 'idle';
      activityText = ''; activity.hidden = true; activityLabel.textContent = '';
      statusMessage.hidden = true; statusMessage.replaceChildren(); statusMessage.removeAttribute('title');
      progressArea.classList.add('is-idle'); progressTrack.setAttribute('aria-hidden', 'true'); setStatus('');
      cancelButton.hidden = true; cancelButton.disabled = false;
    }
    function dispose() {
      if (disposed) return; disposed = true; reset(); themeObserver.disconnect(); navigation.dispose();
      if (copyTimer !== null) root.clearTimeout(copyTimer);
      reports.clear(); messages.length = 0;
      bar.removeEventListener('contextmenu', suppressContext); headerActions.removeEventListener('contextmenu', suppressContext); headerActions.removeEventListener('keydown', onBarKey);
      bar.removeEventListener('keydown', onBarKey);
    }
    const onPageHide = () => { dispose(); root.removeEventListener('pagehide', onPageHide); };
    root.addEventListener('pagehide', onPageHide, { once: true });
    setStatus(''); showCopyState('');
    return { record: rememberMessage, setProgress, setStatus, setActivity, finishProgress, reset, dispose, get version() { return statusVersion; },
      success: message => setStatus(message, 'success'),
      error: message => setStatus(message, 'error') };
  }
  root.BitfroestStatusbar = { create };
})(window);
