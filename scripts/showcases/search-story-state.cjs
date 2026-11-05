/* global document */
function searchSnapshot(action, root = document) {
  const dialog = root.querySelector('dialog[data-file-search][open]');
  const lister = root.querySelector('.lister'), viewerPath = lister?.querySelector('.lister-heading span')?.textContent;
  if (action === 'start') {
    const field = name => dialog?.querySelector(`[name="${name}"]`);
    const control = dialog?.querySelector('[data-search-start]');
    return { ready: Boolean(control && !control.disabled && !control.hidden), name: field('name')?.value, searchIn: field('searchIn')?.value,
      archives: field('archives')?.checked, nameRegex: field('nameRegex')?.checked, selectedOnly: field('selectedOnly')?.checked };
  }
  if (action === 'view') {
    const list = dialog?.querySelector('[data-search-results]'), button = dialog?.querySelector('[data-search-view]');
    return { ready: Boolean(button && !button.disabled && !button.hidden), paths: list ? [...list.options].map(item => item.textContent) : [], selectedPath: list?.selectedOptions[0]?.textContent };
  }
  if (action === 'find') {
    const modal = root.querySelector('dialog[open]#modal'), button = modal?.querySelector('#modal-confirm');
    return { ready: Boolean(button && !button.disabled && !button.hidden && modal?.querySelector('[data-lister-search],#lister-query')),
      query: modal?.querySelector('#lister-query')?.value, viewerPath,
      optionsChecked: Boolean(modal?.querySelector('[data-search-option]:checked')) };
  }
  throw new Error('Invalid search story snapshot.');
}
function viewerMatch(root = document) {
  const lister = root.querySelector('.lister'), area = lister?.querySelector('textarea'), rect = area?.getBoundingClientRect();
  return { path: lister?.querySelector('.lister-heading span')?.textContent, visible: Boolean(rect?.width && rect?.height && !area.hidden),
    selection: area?.value.slice(area.selectionStart, area.selectionEnd) };
}

function searchIsolation(action, root = document) {
  const state = root.defaultView.CommanderHost?.getState?.();
  const searches = root.querySelectorAll('dialog[data-file-search]'), openSearches = root.querySelectorAll('dialog[data-file-search][open]');
  const viewers = root.querySelectorAll('.lister'), modal = root.querySelector('dialog[open]#modal');
  const idle = root.querySelector('#status-progress-area')?.classList.contains('is-idle') && root.querySelector('#status-activity')?.hidden &&
    !root.querySelector('#panes')?.inert && !root.querySelector('#functionbar')?.inert;
  if (!state?.realFilesystem || !idle || searches.length !== 1) return false;
  if (action === 'start' || action === 'view') return openSearches.length === 1 && viewers.length === 0 && !modal && !searches[0].querySelector('[data-search-start]')?.disabled;
  return action === 'find' && openSearches.length === 0 && viewers.length === 1 && Boolean(modal?.querySelector('[data-lister-search]'));
}

function installSearchObservation(root = document) {
  const host = root.defaultView, events = [];
  if (host.__showcaseSearchObservation) throw new Error('A search observation is already active.');
  const listener = event => { if (['search-progress', 'search-complete', 'search-error', 'lister-result'].includes(event.data?.type)) events.push(event.data); };
  host.addEventListener('message', listener);
  host.__showcaseSearchObservation = { events, dispose() { host.removeEventListener('message', listener); delete host.__showcaseSearchObservation; } };
}

function inspectSearchObservation(root = document) {
  if (!root.defaultView.__showcaseSearchObservation) throw new Error('Search observation is unavailable.');
  return root.defaultView.__showcaseSearchObservation.events;
}
function searchCompletedVisible(root = document) {
  const dialog = root.querySelector('dialog[data-file-search][open]'), list = dialog?.querySelector('[data-search-results]');
  const rect = list?.getBoundingClientRect(), style = list && root.defaultView.getComputedStyle(list);
  return Boolean(rect?.width && rect.height && !list.closest('[hidden]') && style?.display !== 'none' && style?.visibility !== 'hidden' &&
    /^Search completed\s*·\s*1$/.test(dialog.querySelector('[data-search-status]')?.textContent.trim() || ''));
}
function searchViewGeometry(root = document) {
  const dialog = root.querySelector('dialog[data-file-search][open]'), button = dialog?.querySelector('[data-search-view]');
  const outer = dialog?.getBoundingClientRect(), rect = button?.getBoundingClientRect(), view = root.defaultView;
  if (!outer?.width || !outer.height || !rect?.width || !rect.height || button.disabled || button.hidden) return { visible: false };
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const visible = x > Math.max(0, outer.left) && x < Math.min(view.innerWidth, outer.right) && y > Math.max(0, outer.top) && y < Math.min(view.innerHeight, outer.bottom) && root.elementFromPoint(x, y)?.closest('[data-search-view]') === button;
  const scroll = { x: Math.max(0, outer.left) + 8, y: (Math.max(0, outer.top) + Math.min(view.innerHeight, outer.bottom)) / 2 };
  const hit = root.elementFromPoint(scroll.x, scroll.y);
  return { visible, scroll: hit?.closest('dialog[data-file-search][open]') === dialog && !hit.closest('select,input,textarea') ? scroll : null };
}
module.exports = { searchSnapshot, viewerMatch, searchIsolation, installSearchObservation, inspectSearchObservation, searchCompletedVisible, searchViewGeometry };
