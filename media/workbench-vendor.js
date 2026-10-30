/* Copyright (c) Microsoft Corporation. All rights reserved.
 * Adapted from Visual Studio Code 1.100.0. Licensed under the MIT License.
 * See WORKBENCH-NOTICES.txt.
 */
(function (root) {
  'use strict';
  class Disposable {
    _store = new Set();
    _register(item) { this._store.add(item); return item; }
    dispose() { for (const item of this._store) item.dispose(); this._store.clear(); }
  }
  class Emitter {
    listeners = new Set();
    event = (listener, thisArg, disposables) => {
      const bound = thisArg ? listener.bind(thisArg) : listener;
      this.listeners.add(bound);
      const disposable = { dispose: () => this.listeners.delete(bound) };
      if (disposables?.add) disposables.add(disposable);
      return disposable;
    };
    fire(value) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const Event = {
    None: () => ({ dispose() {} }),
    once: event => listener => { const subscription = event(value => { subscription.dispose(); listener(value); }); return subscription; }
  };
  class RunOnceScheduler {
    constructor(runner, delay) { this.runner = runner; this.delay = delay; }
    schedule(delay = this.delay) { this.cancel(); this.timer = setTimeout(this.runner, delay); }
    cancel() { clearTimeout(this.timer); }
    dispose() { this.cancel(); }
  }
  class MutableDisposable {
    set value(item) { this.clear(); this.current = item; }
    clear() { this.current?.dispose(); this.current = undefined; }
    dispose() { this.clear(); }
  }
  const hide = element => { element.style.display = 'none'; };
  const show = element => { element.style.display = ''; };
  const isNumber = value => typeof value === 'number';
  const getProgressAcccessibilitySignalScheduler = () => ({ dispose() {} });
  const Severity = { Ignore: 0, Info: 1, Warning: 2, Error: 3 };
  const NotificationPriority = { DEFAULT: 0, OPTIONAL: 1, SILENT: 2, URGENT: 3 };
  const NotificationsFilter = { OFF: 0, ERROR: 1 };
  const isNotificationSource = value => value && typeof value.id === 'string' && typeof value.label === 'string';
  const isCancellationError = error => error?.name === 'Canceled' || error?.name === 'CancellationError';
  const toErrorMessage = error => error?.message || String(error);
  const isErrorWithActions = error => error instanceof Error && Array.isArray(error.actions);
  const equals = (a, b, compare) => a.length === b.length && a.every((value, index) => compare(value, b[index]));
  const mapsStrictEqualIgnoreOrder = (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
  class NoOpNotification {
    progress = { infinite() {}, total() {}, worked() {}, done() {} };
    onDidClose = Event.None;
    onDidChangeVisibility = Event.None;
    updateSeverity() {}
    updateMessage() {}
    updateActions() {}
    close() {}
  }
  const StorageScope = { PROFILE: 0 }, StorageTarget = { USER: 0 };
  const StatusbarAlignment = { LEFT: 0, RIGHT: 1 };
  const isStatusbarEntryLocation = value => !!value && typeof value === 'object' && !!value.location;
  const isAncestorOfActiveElement = element => element.contains(element.ownerDocument.activeElement);
class LinkedText {
    nodes;
    constructor(nodes){
        this.nodes = nodes;
    }
    toString() {
        return this.nodes.map((node)=>typeof node === 'string' ? node : node.label).join('');
    }
}
const LINK_REGEX = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
function parseLinkedText(text) {
    const result = [];
    let index = 0;
    let match;
    while((match = LINK_REGEX.exec(text))){
        if (match.index - index > 0) {
            result.push(text.substring(index, match.index));
        }
        const [, label, href, , title] = match;
        if (title) {
            result.push({
                label,
                href,
                title
            });
        } else {
            result.push({
                label,
                href
            });
        }
        index = match.index + match[0].length;
    }
    if (index < text.length) {
        result.push(text.substring(index));
    }
    return new LinkedText(result);
}

var NotificationChangeType = /*#__PURE__*/ function(NotificationChangeType) {
    NotificationChangeType[NotificationChangeType["ADD"] = 0] = "ADD";
    NotificationChangeType[NotificationChangeType["CHANGE"] = 1] = "CHANGE";
    NotificationChangeType[NotificationChangeType["EXPAND_COLLAPSE"] = 2] = "EXPAND_COLLAPSE";
    NotificationChangeType[NotificationChangeType["REMOVE"] = 3] = "REMOVE";
    return NotificationChangeType;
}({});
class NotificationHandle extends Disposable {
    item;
    onClose;
    _onDidClose = this._register(new Emitter());
    onDidClose = this._onDidClose.event;
    _onDidChangeVisibility = this._register(new Emitter());
    onDidChangeVisibility = this._onDidChangeVisibility.event;
    constructor(item, onClose){
        super(), this.item = item, this.onClose = onClose;
        this.registerListeners();
    }
    registerListeners() {
        this._register(this.item.onDidChangeVisibility((visible)=>this._onDidChangeVisibility.fire(visible)));
        Event.once(this.item.onDidClose)(()=>{
            this._onDidClose.fire();
            this.dispose();
        });
    }
    get progress() {
        return this.item.progress;
    }
    updateSeverity(severity) {
        this.item.updateSeverity(severity);
    }
    updateMessage(message) {
        this.item.updateMessage(message);
    }
    updateActions(actions) {
        this.item.updateActions(actions);
    }
    close() {
        this.onClose(this.item);
        this.dispose();
    }
}
class NotificationsModel extends Disposable {
    static NO_OP_NOTIFICATION = new NoOpNotification();
    _onDidChangeNotification = this._register(new Emitter());
    onDidChangeNotification = this._onDidChangeNotification.event;
    _onDidChangeStatusMessage = this._register(new Emitter());
    onDidChangeStatusMessage = this._onDidChangeStatusMessage.event;
    _onDidChangeFilter = this._register(new Emitter());
    onDidChangeFilter = this._onDidChangeFilter.event;
    _notifications = [];
    get notifications() {
        return this._notifications;
    }
    _statusMessage;
    get statusMessage() {
        return this._statusMessage;
    }
    filter = {
        global: NotificationsFilter.OFF,
        sources: new Map()
    };
    setFilter(filter) {
        let globalChanged = false;
        if (typeof filter.global === 'number') {
            globalChanged = this.filter.global !== filter.global;
            this.filter.global = filter.global;
        }
        let sourcesChanged = false;
        if (filter.sources) {
            sourcesChanged = !mapsStrictEqualIgnoreOrder(this.filter.sources, filter.sources);
            this.filter.sources = filter.sources;
        }
        if (globalChanged || sourcesChanged) {
            this._onDidChangeFilter.fire({
                global: globalChanged ? filter.global : undefined,
                sources: sourcesChanged ? filter.sources : undefined
            });
        }
    }
    addNotification(notification) {
        const item = this.createViewItem(notification);
        if (!item) {
            return NotificationsModel.NO_OP_NOTIFICATION;
        }
        const duplicate = this.findNotification(item);
        duplicate?.close();
        this._notifications.splice(0, 0, item);
        this._onDidChangeNotification.fire({
            item,
            index: 0,
            kind: 0
        });
        return new NotificationHandle(item, (item)=>this.onClose(item));
    }
    onClose(item) {
        const liveItem = this.findNotification(item);
        if (liveItem && liveItem !== item) {
            liveItem.close();
        } else {
            item.close();
        }
    }
    findNotification(item) {
        return this._notifications.find((notification)=>notification.equals(item));
    }
    createViewItem(notification) {
        const item = NotificationViewItem.create(notification, this.filter);
        if (!item) {
            return undefined;
        }
        const fireNotificationChangeEvent = (kind, detail)=>{
            const index = this._notifications.indexOf(item);
            if (index >= 0) {
                this._onDidChangeNotification.fire({
                    item,
                    index,
                    kind,
                    detail
                });
            }
        };
        const itemExpansionChangeListener = item.onDidChangeExpansion(()=>fireNotificationChangeEvent(2));
        const itemContentChangeListener = item.onDidChangeContent((e)=>fireNotificationChangeEvent(1, e.kind));
        Event.once(item.onDidClose)(()=>{
            itemExpansionChangeListener.dispose();
            itemContentChangeListener.dispose();
            const index = this._notifications.indexOf(item);
            if (index >= 0) {
                this._notifications.splice(index, 1);
                this._onDidChangeNotification.fire({
                    item,
                    index,
                    kind: 3
                });
            }
        });
        return item;
    }
    showStatusMessage(message, options) {
        const item = StatusMessageViewItem.create(message, options);
        if (!item) {
            return {
                close: ()=>{}
            };
        }
        this._statusMessage = item;
        this._onDidChangeStatusMessage.fire({
            kind: 0,
            item
        });
        return {
            close: ()=>{
                if (this._statusMessage === item) {
                    this._statusMessage = undefined;
                    this._onDidChangeStatusMessage.fire({
                        kind: 1,
                        item
                    });
                }
            }
        };
    }
}
class NotificationViewItemProgress extends Disposable {
    _state;
    _onDidChange = this._register(new Emitter());
    onDidChange = this._onDidChange.event;
    constructor(){
        super();
        this._state = Object.create(null);
    }
    get state() {
        return this._state;
    }
    infinite() {
        if (this._state.infinite) {
            return;
        }
        this._state.infinite = true;
        this._state.total = undefined;
        this._state.worked = undefined;
        this._state.done = undefined;
        this._onDidChange.fire();
    }
    done() {
        if (this._state.done) {
            return;
        }
        this._state.done = true;
        this._state.infinite = undefined;
        this._state.total = undefined;
        this._state.worked = undefined;
        this._onDidChange.fire();
    }
    total(value) {
        if (this._state.total === value) {
            return;
        }
        this._state.total = value;
        this._state.infinite = undefined;
        this._state.done = undefined;
        this._onDidChange.fire();
    }
    worked(value) {
        if (typeof this._state.worked === 'number') {
            this._state.worked += value;
        } else {
            this._state.worked = value;
        }
        this._state.infinite = undefined;
        this._state.done = undefined;
        this._onDidChange.fire();
    }
}
class NotificationViewItem extends Disposable {
    id;
    _severity;
    _sticky;
    _priority;
    _message;
    _source;
    static MAX_MESSAGE_LENGTH = 1000;
    _expanded;
    _visible = false;
    _actions;
    _progress;
    _onDidChangeExpansion = this._register(new Emitter());
    onDidChangeExpansion = this._onDidChangeExpansion.event;
    _onDidClose = this._register(new Emitter());
    onDidClose = this._onDidClose.event;
    _onDidChangeContent = this._register(new Emitter());
    onDidChangeContent = this._onDidChangeContent.event;
    _onDidChangeVisibility = this._register(new Emitter());
    onDidChangeVisibility = this._onDidChangeVisibility.event;
    static create(notification, filter) {
        if (!notification || !notification.message || isCancellationError(notification.message)) {
            return undefined;
        }
        let severity;
        if (typeof notification.severity === 'number') {
            severity = notification.severity;
        } else {
            severity = Severity.Info;
        }
        const message = NotificationViewItem.parseNotificationMessage(notification.message);
        if (!message) {
            return undefined;
        }
        let actions;
        if (notification.actions) {
            actions = notification.actions;
        } else if (isErrorWithActions(notification.message)) {
            actions = {
                primary: notification.message.actions
            };
        }
        let priority = notification.priority ?? NotificationPriority.DEFAULT;
        if ((priority === NotificationPriority.DEFAULT || priority === NotificationPriority.OPTIONAL) && severity !== Severity.Error) {
            if (filter.global === NotificationsFilter.ERROR) {
                priority = NotificationPriority.SILENT;
            } else if (isNotificationSource(notification.source) && filter.sources.get(notification.source.id) === NotificationsFilter.ERROR) {
                priority = NotificationPriority.SILENT;
            }
        }
        return new NotificationViewItem(notification.id, severity, notification.sticky, priority, message, notification.source, notification.progress, actions);
    }
    static parseNotificationMessage(input) {
        let message;
        if (input instanceof Error) {
            message = toErrorMessage(input, false);
        } else if (typeof input === 'string') {
            message = input;
        }
        if (!message) {
            return undefined;
        }
        const raw = message;
        if (message.length > NotificationViewItem.MAX_MESSAGE_LENGTH) {
            message = `${message.substr(0, NotificationViewItem.MAX_MESSAGE_LENGTH)}...`;
        }
        message = message.replace(/(\r\n|\n|\r)/gm, ' ').trim();
        const linkedText = parseLinkedText(message);
        return {
            raw,
            linkedText,
            original: input
        };
    }
    constructor(id, _severity, _sticky, _priority, _message, _source, progress, actions){
        super(), this.id = id, this._severity = _severity, this._sticky = _sticky, this._priority = _priority, this._message = _message, this._source = _source;
        if (progress) {
            this.setProgress(progress);
        }
        this.setActions(actions);
    }
    setProgress(progress) {
        if (progress.infinite) {
            this.progress.infinite();
        } else if (progress.total) {
            this.progress.total(progress.total);
            if (progress.worked) {
                this.progress.worked(progress.worked);
            }
        }
    }
    setActions(actions = {
        primary: [],
        secondary: []
    }) {
        this._actions = {
            primary: Array.isArray(actions.primary) ? actions.primary : [],
            secondary: Array.isArray(actions.secondary) ? actions.secondary : []
        };
        this._expanded = actions.primary && actions.primary.length > 0;
    }
    get canCollapse() {
        return !this.hasActions;
    }
    get expanded() {
        return !!this._expanded;
    }
    get severity() {
        return this._severity;
    }
    get sticky() {
        if (this._sticky) {
            return true;
        }
        const hasActions = this.hasActions;
        if (hasActions && this._severity === Severity.Error || !hasActions && this._expanded || this._progress && !this._progress.state.done) {
            return true;
        }
        return false;
    }
    get priority() {
        return this._priority;
    }
    get hasActions() {
        if (!this._actions) {
            return false;
        }
        if (!this._actions.primary) {
            return false;
        }
        return this._actions.primary.length > 0;
    }
    get hasProgress() {
        return !!this._progress;
    }
    get progress() {
        if (!this._progress) {
            this._progress = this._register(new NotificationViewItemProgress());
            this._register(this._progress.onDidChange(()=>this._onDidChangeContent.fire({
                    kind: 3
                })));
        }
        return this._progress;
    }
    get message() {
        return this._message;
    }
    get source() {
        return typeof this._source === 'string' ? this._source : this._source ? this._source.label : undefined;
    }
    get sourceId() {
        return this._source && typeof this._source !== 'string' && 'id' in this._source ? this._source.id : undefined;
    }
    get actions() {
        return this._actions;
    }
    get visible() {
        return this._visible;
    }
    updateSeverity(severity) {
        if (severity === this._severity) {
            return;
        }
        this._severity = severity;
        this._onDidChangeContent.fire({
            kind: 0
        });
    }
    updateMessage(input) {
        const message = NotificationViewItem.parseNotificationMessage(input);
        if (!message || message.raw === this._message.raw) {
            return;
        }
        this._message = message;
        this._onDidChangeContent.fire({
            kind: 1
        });
    }
    updateActions(actions) {
        this.setActions(actions);
        this._onDidChangeContent.fire({
            kind: 2
        });
    }
    updateVisibility(visible) {
        if (this._visible !== visible) {
            this._visible = visible;
            this._onDidChangeVisibility.fire(visible);
        }
    }
    expand() {
        if (this._expanded || !this.canCollapse) {
            return;
        }
        this._expanded = true;
        this._onDidChangeExpansion.fire();
    }
    collapse(skipEvents) {
        if (!this._expanded || !this.canCollapse) {
            return;
        }
        this._expanded = false;
        if (!skipEvents) {
            this._onDidChangeExpansion.fire();
        }
    }
    toggle() {
        if (this._expanded) {
            this.collapse();
        } else {
            this.expand();
        }
    }
    close() {
        this._onDidClose.fire();
        this.dispose();
    }
    equals(other) {
        if (this.hasProgress || other.hasProgress) {
            return false;
        }
        if (typeof this.id === 'string' || typeof other.id === 'string') {
            return this.id === other.id;
        }
        if (typeof this._source === 'object') {
            if (this._source.label !== other.source || this._source.id !== other.sourceId) {
                return false;
            }
        } else if (this._source !== other.source) {
            return false;
        }
        if (this._message.raw !== other.message.raw) {
            return false;
        }
        const primaryActions = this._actions && this._actions.primary || [];
        const otherPrimaryActions = other.actions && other.actions.primary || [];
        return equals(primaryActions, otherPrimaryActions, (action, otherAction)=>action.id + action.label === otherAction.id + otherAction.label);
    }
}
class StatusMessageViewItem {
    static create(notification, options) {
        if (!notification || isCancellationError(notification)) {
            return undefined;
        }
        let message;
        if (notification instanceof Error) {
            message = toErrorMessage(notification, false);
        } else if (typeof notification === 'string') {
            message = notification;
        }
        if (!message) {
            return undefined;
        }
        return {
            message,
            options
        };
    }
}

class StatusbarViewModel extends Disposable {
    storageService;
    static HIDDEN_ENTRIES_KEY = 'workbench.statusbar.hidden';
    _onDidChangeEntryVisibility = this._register(new Emitter());
    onDidChangeEntryVisibility = this._onDidChangeEntryVisibility.event;
    _entries = [];
    get entries() {
        return this._entries.slice(0);
    }
    _lastFocusedEntry;
    get lastFocusedEntry() {
        return this._lastFocusedEntry && !this.isHidden(this._lastFocusedEntry.id) ? this._lastFocusedEntry : undefined;
    }
    hidden = new Set();
    constructor(storageService){
        super(), this.storageService = storageService;
        this.restoreState();
        this.registerListeners();
    }
    restoreState() {
        const hiddenRaw = this.storageService.get(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);
        if (hiddenRaw) {
            try {
                this.hidden = new Set(JSON.parse(hiddenRaw));
            } catch { /* Ignore invalid persisted visibility state. */ }
        }
    }
    registerListeners() {
        this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, StatusbarViewModel.HIDDEN_ENTRIES_KEY, this._store)(()=>this.onDidStorageValueChange()));
    }
    onDidStorageValueChange() {
        const currentlyHidden = new Set(this.hidden);
        this.hidden.clear();
        this.restoreState();
        const changed = new Set();
        for (const id of currentlyHidden){
            if (!this.hidden.has(id)) {
                changed.add(id);
            }
        }
        for (const id of this.hidden){
            if (!currentlyHidden.has(id)) {
                changed.add(id);
            }
        }
        if (changed.size > 0) {
            for (const entry of this._entries){
                if (changed.has(entry.id)) {
                    this.updateVisibility(entry.id, true);
                    changed.delete(entry.id);
                }
            }
        }
    }
    add(entry) {
        this._entries.push(entry);
        this.updateVisibility(entry, false);
        this.sort();
        this.markFirstLastVisibleEntry();
    }
    remove(entry) {
        const index = this._entries.indexOf(entry);
        if (index >= 0) {
            this._entries.splice(index, 1);
            if (this._entries.some((otherEntry)=>isStatusbarEntryLocation(otherEntry.priority.primary) && otherEntry.priority.primary.location.id === entry.id)) {
                this.sort();
            }
            this.markFirstLastVisibleEntry();
        }
    }
    isHidden(id) {
        return this.hidden.has(id);
    }
    hide(id) {
        if (!this.hidden.has(id)) {
            this.hidden.add(id);
            this.updateVisibility(id, true);
            this.saveState();
        }
    }
    show(id) {
        if (this.hidden.has(id)) {
            this.hidden.delete(id);
            this.updateVisibility(id, true);
            this.saveState();
        }
    }
    findEntry(container) {
        return this._entries.find((entry)=>entry.container === container);
    }
    getEntries(alignment) {
        return this._entries.filter((entry)=>entry.alignment === alignment);
    }
    focusNextEntry() {
        this.focusEntry(+1, 0);
    }
    focusPreviousEntry() {
        this.focusEntry(-1, this.entries.length - 1);
    }
    isEntryFocused() {
        return !!this.getFocusedEntry();
    }
    getFocusedEntry() {
        return this._entries.find((entry)=>isAncestorOfActiveElement(entry.container));
    }
    focusEntry(delta, restartPosition) {
        const getVisibleEntry = (start)=>{
            let indexToFocus = start;
            let entry = indexToFocus >= 0 && indexToFocus < this._entries.length ? this._entries[indexToFocus] : undefined;
            while(entry && this.isHidden(entry.id)){
                indexToFocus += delta;
                entry = indexToFocus >= 0 && indexToFocus < this._entries.length ? this._entries[indexToFocus] : undefined;
            }
            return entry;
        };
        const focused = this.getFocusedEntry();
        if (focused) {
            const entry = getVisibleEntry(this._entries.indexOf(focused) + delta);
            if (entry) {
                this._lastFocusedEntry = entry;
                entry.labelContainer.focus();
                return;
            }
        }
        const entry = getVisibleEntry(restartPosition);
        if (entry) {
            this._lastFocusedEntry = entry;
            entry.labelContainer.focus();
        }
    }
    updateVisibility(arg1, trigger) {
        if (typeof arg1 === 'string') {
            const id = arg1;
            for (const entry of this._entries){
                if (entry.id === id) {
                    this.updateVisibility(entry, trigger);
                }
            }
        } else {
            const entry = arg1;
            const isHidden = this.isHidden(entry.id);
            if (isHidden) {
                hide(entry.container);
            } else {
                show(entry.container);
            }
            if (trigger) {
                this._onDidChangeEntryVisibility.fire({
                    id: entry.id,
                    visible: !isHidden
                });
            }
            this.markFirstLastVisibleEntry();
        }
    }
    saveState() {
        if (this.hidden.size > 0) {
            this.storageService.store(StatusbarViewModel.HIDDEN_ENTRIES_KEY, JSON.stringify(Array.from(this.hidden.values())), StorageScope.PROFILE, StorageTarget.USER);
        } else {
            this.storageService.remove(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);
        }
    }
    sort() {
        const allEntryIds = new Set(this._entries.map((entry)=>entry.id));
        const mapEntryWithNumberedPriorityToIndex = new Map();
        const mapEntryWithRelativePriority = new Map();
        for(let i = 0; i < this._entries.length; i++){
            const entry = this._entries[i];
            if (typeof entry.priority.primary === 'number' || !allEntryIds.has(entry.priority.primary.location.id)) {
                mapEntryWithNumberedPriorityToIndex.set(entry, i);
            } else {
                const referenceEntryId = entry.priority.primary.location.id;
                let entries = mapEntryWithRelativePriority.get(referenceEntryId);
                if (!entries) {
                    for (const relativeEntries of mapEntryWithRelativePriority.values()){
                        if (relativeEntries.has(referenceEntryId)) {
                            entries = relativeEntries;
                            break;
                        }
                    }
                    if (!entries) {
                        entries = new Map();
                        mapEntryWithRelativePriority.set(referenceEntryId, entries);
                    }
                }
                entries.set(entry.id, entry);
            }
        }
        const sortedEntriesWithNumberedPriority = Array.from(mapEntryWithNumberedPriorityToIndex.keys());
        sortedEntriesWithNumberedPriority.sort((entryA, entryB)=>{
            if (entryA.alignment === entryB.alignment) {
                const entryAPrimaryPriority = typeof entryA.priority.primary === 'number' ? entryA.priority.primary : entryA.priority.primary.location.priority;
                const entryBPrimaryPriority = typeof entryB.priority.primary === 'number' ? entryB.priority.primary : entryB.priority.primary.location.priority;
                if (entryAPrimaryPriority !== entryBPrimaryPriority) {
                    return entryBPrimaryPriority - entryAPrimaryPriority;
                }
                if (entryA.priority.secondary !== entryB.priority.secondary) {
                    return entryB.priority.secondary - entryA.priority.secondary;
                }
                return mapEntryWithNumberedPriorityToIndex.get(entryA) - mapEntryWithNumberedPriorityToIndex.get(entryB);
            }
            if (entryA.alignment === StatusbarAlignment.LEFT) {
                return -1;
            }
            if (entryB.alignment === StatusbarAlignment.LEFT) {
                return 1;
            }
            return 0;
        });
        let sortedEntries;
        if (mapEntryWithRelativePriority.size > 0) {
            sortedEntries = [];
            for (const entry of sortedEntriesWithNumberedPriority){
                const relativeEntriesMap = mapEntryWithRelativePriority.get(entry.id);
                const relativeEntries = relativeEntriesMap ? Array.from(relativeEntriesMap.values()) : undefined;
                if (relativeEntries) {
                    sortedEntries.push(...relativeEntries.filter((entry)=>isStatusbarEntryLocation(entry.priority.primary) && entry.priority.primary.alignment === StatusbarAlignment.LEFT).sort((entryA, entryB)=>entryB.priority.secondary - entryA.priority.secondary));
                }
                sortedEntries.push(entry);
                if (relativeEntries) {
                    sortedEntries.push(...relativeEntries.filter((entry)=>isStatusbarEntryLocation(entry.priority.primary) && entry.priority.primary.alignment === StatusbarAlignment.RIGHT).sort((entryA, entryB)=>entryB.priority.secondary - entryA.priority.secondary));
                }
                mapEntryWithRelativePriority.delete(entry.id);
            }
            for (const [, entries] of mapEntryWithRelativePriority){
                sortedEntries.push(...Array.from(entries.values()).sort((entryA, entryB)=>entryB.priority.secondary - entryA.priority.secondary));
            }
        } else {
            sortedEntries = sortedEntriesWithNumberedPriority;
        }
        this._entries = sortedEntries;
    }
    markFirstLastVisibleEntry() {
        this.doMarkFirstLastVisibleStatusbarItem(this.getEntries(StatusbarAlignment.LEFT));
        this.doMarkFirstLastVisibleStatusbarItem(this.getEntries(StatusbarAlignment.RIGHT));
    }
    doMarkFirstLastVisibleStatusbarItem(entries) {
        let firstVisibleItem;
        let lastVisibleItem;
        for (const entry of entries){
            entry.container.classList.remove('first-visible-item', 'last-visible-item');
            const isVisible = !this.isHidden(entry.id);
            if (isVisible) {
                if (!firstVisibleItem) {
                    firstVisibleItem = entry;
                }
                lastVisibleItem = entry;
            }
        }
        firstVisibleItem?.container.classList.add('first-visible-item');
        lastVisibleItem?.container.classList.add('last-visible-item');
    }
}

const CSS_DONE = 'done';
const CSS_ACTIVE = 'active';
const CSS_INFINITE = 'infinite';
const CSS_INFINITE_LONG_RUNNING = 'infinite-long-running';
const CSS_DISCRETE = 'discrete';
class ProgressBar extends Disposable {
    static LONG_RUNNING_INFINITE_THRESHOLD = 10000;
    static PROGRESS_SIGNAL_DEFAULT_DELAY = 3000;
    workedVal;
    element;
    bit;
    totalWork;
    showDelayedScheduler;
    longRunningScheduler;
    progressSignal = this._register(new MutableDisposable());
    constructor(container, options){
        super();
        this.workedVal = 0;
        this.showDelayedScheduler = this._register(new RunOnceScheduler(()=>show(this.element), 0));
        this.longRunningScheduler = this._register(new RunOnceScheduler(()=>this.infiniteLongRunning(), ProgressBar.LONG_RUNNING_INFINITE_THRESHOLD));
        this.create(container, options);
    }
    create(container, options) {
        this.element = document.createElement('div');
        this.element.classList.add('monaco-progress-container');
        this.element.setAttribute('role', 'progressbar');
        this.element.setAttribute('aria-valuemin', '0');
        container.appendChild(this.element);
        this.bit = document.createElement('div');
        this.bit.classList.add('progress-bit');
        this.bit.style.backgroundColor = options?.progressBarBackground || '#0E70C0';
        this.element.appendChild(this.bit);
    }
    off() {
        this.bit.style.width = 'inherit';
        this.bit.style.opacity = '1';
        this.element.classList.remove(CSS_ACTIVE, CSS_INFINITE, CSS_INFINITE_LONG_RUNNING, CSS_DISCRETE);
        this.workedVal = 0;
        this.totalWork = undefined;
        this.longRunningScheduler.cancel();
        this.progressSignal.clear();
    }
    done() {
        return this.doDone(true);
    }
    stop() {
        return this.doDone(false);
    }
    doDone(delayed) {
        this.element.classList.add(CSS_DONE);
        if (!this.element.classList.contains(CSS_INFINITE)) {
            this.bit.style.width = 'inherit';
            if (delayed) {
                setTimeout(()=>this.off(), 200);
            } else {
                this.off();
            }
        } else {
            this.bit.style.opacity = '0';
            if (delayed) {
                setTimeout(()=>this.off(), 200);
            } else {
                this.off();
            }
        }
        return this;
    }
    infinite() {
        this.bit.style.width = '2%';
        this.bit.style.opacity = '1';
        this.element.classList.remove(CSS_DISCRETE, CSS_DONE, CSS_INFINITE_LONG_RUNNING);
        this.element.classList.add(CSS_ACTIVE, CSS_INFINITE);
        this.longRunningScheduler.schedule();
        return this;
    }
    infiniteLongRunning() {
        this.element.classList.add(CSS_INFINITE_LONG_RUNNING);
    }
    total(value) {
        this.workedVal = 0;
        this.totalWork = value;
        this.element.setAttribute('aria-valuemax', value.toString());
        return this;
    }
    hasTotal() {
        return isNumber(this.totalWork);
    }
    worked(value) {
        value = Math.max(0, Number(value));
        return this.doSetWorked(this.workedVal + value);
    }
    setWorked(value) {
        value = Math.max(0, Number(value));
        return this.doSetWorked(value);
    }
    doSetWorked(value) {
        const totalWork = this.totalWork || 100;
        this.workedVal = value;
        this.workedVal = Math.min(totalWork, this.workedVal);
        this.element.classList.remove(CSS_INFINITE, CSS_INFINITE_LONG_RUNNING, CSS_DONE);
        this.element.classList.add(CSS_ACTIVE, CSS_DISCRETE);
        this.element.setAttribute('aria-valuenow', value.toString());
        this.bit.style.width = 100 * (this.workedVal / totalWork) + '%';
        return this;
    }
    getContainer() {
        return this.element;
    }
    show(delay) {
        this.showDelayedScheduler.cancel();
        this.progressSignal.value = getProgressAcccessibilitySignalScheduler(ProgressBar.PROGRESS_SIGNAL_DEFAULT_DELAY);
        if (typeof delay === 'number') {
            this.showDelayedScheduler.schedule(delay);
        } else {
            show(this.element);
        }
    }
    hide() {
        hide(this.element);
        this.showDelayedScheduler.cancel();
        this.progressSignal.clear();
    }
}

root.CommanderWorkbench = { NotificationsModel, NotificationChangeType, Severity, StatusbarViewModel, StatusbarAlignment, ProgressBar };
})(globalThis);
