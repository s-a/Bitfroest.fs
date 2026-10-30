(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderTabs = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  let sequence = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  const viewFields = ['selected', 'cursor', 'filter', 'sort', 'descending', 'scrollTop'];
  const defaults = () => ({ selected: [], cursor: null, filter: '', sort: 'name', descending: false, scrollTop: 0 });
  const validIndex = (pane, index) => Number.isInteger(index) && index >= 0 && index < pane.tabs.length;
  const createId = () => `tab-${Date.now().toString(36)}-${(++sequence).toString(36)}`;

  function capture(pane) {
    const view = defaults();
    for (const field of viewFields) if (pane[field] !== undefined) view[field] = copy(pane[field]);
    return view;
  }

  function restore(pane, view) {
    const next = { ...defaults(), ...copy(view || {}) };
    for (const field of viewFields) pane[field] = next[field];
  }

  function createState(path, view) {
    return {
      id: createId(), path,
      view: copy(view || defaults()),
      history: [path], historyIndex: 0,
      directoryStates: {}
    };
  }

  function ensure(pane) {
    if (!pane || !Array.isArray(pane.tabs) || !pane.tabs.length || pane.tabs.some(path => typeof path !== 'string' || !path)) {
      throw new TypeError('Eine Dateiliste benötigt mindestens einen gültigen Ordner-Tab.');
    }
    pane.tab = validIndex(pane, pane.tab) ? pane.tab : 0;
    const existing = Array.isArray(pane.tabStates) ? pane.tabStates : [];
    pane.tabStates = pane.tabs.map((path, index) => {
      const state = existing[index];
      if (!state || typeof state !== 'object') {
        const view = index === pane.tab ? capture(pane) : { ...defaults(), sort: pane.sort || 'name', descending: Boolean(pane.descending) };
        return createState(path, view);
      }
      state.id ||= createId();
      state.path = path;
      state.view = { ...defaults(), ...(state.view || {}) };
      if (!Array.isArray(state.history) || !state.history.length) state.history = [path];
      state.historyIndex = Number.isInteger(state.historyIndex) ? Math.max(0, Math.min(state.history.length - 1, state.historyIndex)) : state.history.length - 1;
      state.directoryStates ||= {};
      return state;
    });
    return pane;
  }

  function remember(pane) {
    ensure(pane);
    const state = pane.tabStates[pane.tab];
    state.path = pane.tabs[pane.tab];
    state.view = capture(pane);
    state.directoryStates[state.path] = copy(state.view);
    return state;
  }

  function activate(pane, index) {
    ensure(pane);
    if (!validIndex(pane, index)) return false;
    remember(pane);
    pane.tab = index;
    restore(pane, pane.tabStates[index].view);
    return true;
  }

  function openPath(pane, path, options = {}) {
    ensure(pane);
    if (typeof path !== 'string' || !path) return false;
    remember(pane);
    const insertion = Number.isInteger(options.index) ? Math.max(0, Math.min(pane.tabs.length, options.index)) : pane.tab + 1;
    const state = createState(path, {
      ...defaults(), sort: pane.sort || 'name', descending: Boolean(pane.descending)
    });
    pane.tabs.splice(insertion, 0, path);
    pane.tabStates.splice(insertion, 0, state);
    if (options.background) {
      if (insertion <= pane.tab) pane.tab++;
    } else {
      pane.tab = insertion;
      restore(pane, state.view);
    }
    return insertion;
  }

  function duplicate(pane, options = {}) {
    ensure(pane);
    const source = copy(remember(pane));
    const insertion = pane.tab + 1;
    source.id = createId();
    pane.tabs.splice(insertion, 0, source.path);
    pane.tabStates.splice(insertion, 0, source);
    if (!options.background) {
      pane.tab = insertion;
      restore(pane, source.view);
    }
    return insertion;
  }

  function navigate(pane, path, options = {}) {
    ensure(pane);
    if (typeof path !== 'string' || !path) return false;
    const state = remember(pane);
    if (path === state.path) return true;
    if (options.recordHistory !== false) {
      state.history.splice(state.historyIndex + 1);
      state.history.push(path);
      state.historyIndex = state.history.length - 1;
    }
    pane.tabs[pane.tab] = path;
    state.path = path;
    const view = state.directoryStates[path] || { ...defaults(), sort: pane.sort || 'name', descending: Boolean(pane.descending) };
    state.view = copy(view);
    restore(pane, view);
    return true;
  }

  function travel(pane, delta) {
    ensure(pane);
    const state = remember(pane);
    const target = state.historyIndex + delta;
    if (target < 0 || target >= state.history.length) return false;
    state.historyIndex = target;
    return navigate(pane, state.history[target], { recordHistory: false });
  }

  function close(pane, index = pane.tab) {
    ensure(pane);
    if (!validIndex(pane, index) || pane.tabs.length === 1) return false;
    remember(pane);
    const activeId = pane.tabStates[pane.tab].id;
    const closingActive = pane.tab === index;
    pane.tabs.splice(index, 1);
    pane.tabStates.splice(index, 1);
    pane.tab = closingActive ? Math.min(index, pane.tabs.length - 1) : pane.tabStates.findIndex(state => state.id === activeId);
    restore(pane, pane.tabStates[pane.tab].view);
    return true;
  }

  function step(pane, delta) {
    ensure(pane);
    if (!Number.isInteger(delta)) return false;
    const index = ((pane.tab + delta) % pane.tabs.length + pane.tabs.length) % pane.tabs.length;
    return activate(pane, index);
  }

  function move(sourcePane, index, targetPane, insertionIndex, options = {}) {
    ensure(sourcePane);
    ensure(targetPane);
    if (!validIndex(sourcePane, index)) return false;
    remember(sourcePane);
    if (sourcePane !== targetPane) remember(targetPane);
    const sourceActiveId = sourcePane.tabStates[sourcePane.tab].id;
    const targetActiveId = targetPane.tabStates[targetPane.tab].id;
    const copied = Boolean(options.copy) || (sourcePane !== targetPane && sourcePane.tabs.length === 1);
    const state = copied ? copy(sourcePane.tabStates[index]) : sourcePane.tabStates[index];
    if (copied) state.id = createId();
    const requested = Number.isInteger(insertionIndex) ? insertionIndex : targetPane.tabs.length;
    let insertion = Math.max(0, Math.min(targetPane.tabs.length, requested));
    if (!copied) {
      sourcePane.tabs.splice(index, 1);
      sourcePane.tabStates.splice(index, 1);
      if (sourcePane === targetPane && index < insertion) insertion--;
    }
    targetPane.tabs.splice(insertion, 0, state.path);
    targetPane.tabStates.splice(insertion, 0, state);
    if (sourcePane === targetPane) {
      sourcePane.tab = copied && !options.background ? insertion : sourcePane.tabStates.findIndex(item => item.id === sourceActiveId);
      restore(sourcePane, sourcePane.tabStates[sourcePane.tab].view);
    } else {
      const sourceIndex = sourcePane.tabStates.findIndex(item => item.id === sourceActiveId);
      sourcePane.tab = sourceIndex >= 0 ? sourceIndex : Math.min(index, sourcePane.tabs.length - 1);
      restore(sourcePane, sourcePane.tabStates[sourcePane.tab].view);
      targetPane.tab = options.background ? targetPane.tabStates.findIndex(item => item.id === targetActiveId) : insertion;
      restore(targetPane, targetPane.tabStates[targetPane.tab].view);
    }
    return { index: insertion, copied };
  }

  return Object.freeze({ ensure, remember, activate, duplicate, openPath, navigate, back: pane => travel(pane, -1), forward: pane => travel(pane, 1), close, step, move });
});
