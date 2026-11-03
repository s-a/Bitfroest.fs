(function (root) {
  'use strict';

  const instances = new Map();
  const parentId = '\u0000parent';

  function create(options) {
    const library = root.agGrid;
    if (!library?.createGrid) throw new Error('The file grid could not be loaded.');

    function marks(record) { record.selected = new Set(record.p.selected); record.spaces = new Set(options.spaceMarks(record.p)); }

    function updateAddress(record, preserveFocus = true) {
      const template = document.createElement('template');
      template.innerHTML = options.address(record.p);
      const focused = record.address?.contains(document.activeElement) ? document.activeElement : null;
      const samePath = record.address?.querySelector('input').getAttribute('value') === template.content.querySelector('input').getAttribute('value');
      if (preserveFocus && samePath && record.address?.querySelector('.path-address.is-editing') && focused) template.content.querySelector('.path-address').classList.add('is-editing');
      if (preserveFocus && samePath && focused) queueMicrotask(() => {
        if (focused.isConnected && (document.activeElement === document.body || document.activeElement?.closest('.location-header')?.contains(record.address))) focused.focus({ preventScroll: true });
      });
      if (record.address) options.patch(record.address, template.content.firstElementChild);
      else record.address = template.content.firstElementChild;
      return record.address;
    }

    function groupedDefinitions(record) {
      return [{
        groupId: 'location',
        headerName: '',
        headerClass: 'location-header',
        suppressHeaderKeyboardEvent: () => true,
        headerGroupComponent: class {
          init() {
            this.element = updateAddress(record);
            this.stopDrag = event => event.stopPropagation();
            for (const type of ['pointerdown', 'mousedown', 'touchstart']) this.element.addEventListener(type, this.stopDrag);
          }
          getGui() { return this.element; }
          refresh() { updateAddress(record); return true; }
          destroy() { for (const type of ['pointerdown', 'mousedown', 'touchstart']) this.element.removeEventListener(type, this.stopDrag); }
        },
        children: definitions(record)
      }];
    }

    function definitions(record) {
      const p = record.p;
      const filename = p.columns.find(column => column.visible !== false && options.isFilename(column));
      return p.columns.map(column => ({
        colId: column.key,
        headerName: options.translate(column.label),
        headerTooltip: options.translate(column.label),
        hide: column.visible === false,
        width: column.width,
        minWidth: column.minWidth,
        maxWidth: column.maxWidth,
        flex: column === filename && !record.manual.has(column.key) ? 1 : null,
        sortable: true,
        resizable: true,
        sortingOrder: ['asc', 'desc'],
        sort: p.sort === column.key ? p.descending ? 'desc' : 'asc' : null,
        suppressKeyboardEvent: () => true,
        suppressHeaderKeyboardEvent: params => Boolean(params.event.target.closest('[data-history]')),
        valueGetter: params => params.data?.id === parentId ? column === filename ? '..' : '' : options.value(params.data, column),
        comparator: (_a, _b, a, b, descending) => {
          const groups = options.results(record.p)?.groups;
          const group = groups ? (groups[a.data?.fsSource] ?? -1) - (groups[b.data?.fsSource] ?? -1) : 0;
          const order = a.id === parentId ? -1 : b.id === parentId ? 1 : group || options.compare(a.data, b.data, column, descending);
          return descending ? -order : order;
        },
        cellRenderer: class {
          init(params) {
            this.element = document.createElement('div');
            this.element.className = `file-cell column-align-${column.align || 'left'}`;
            this.element.dataset.cell = column.key;
            this.refresh(params);
          }
          getGui() { return this.element; }
          refresh(params) {
            if (this.element.querySelector('.inline-rename')) return true;
            const parent = params.data.id === parentId;
            const content = parent ? column === filename ? '<span class="filename"><span>…</span></span>' : '' : options.cell(params.data, column, record.p);
            if (!parent) this.element.title = params.data.name;
            if (this.content !== content) {
              const next = this.element.cloneNode(false);
              next.innerHTML = content;
              options.patch(this.element, next);
              this.content = content;
            }
            return true;
          }
        },
        headerComponentParams: {
          innerHeaderComponent: class {
            init(params) {
              this.element = document.createElement('span');
              this.element.className = `column-heading ${options.isFilename(column) ? 'filename-column' : ''}`;
              params.eGridHeader.dataset.column = column.key;
              this.column = params.column;
              this.sortChanged = () => { const sort = this.column.getSort(); if (!record.updating && sort) options.sorted(record.p, column.key, sort === 'desc'); };
              this.column.addEventListener('sortChanged', this.sortChanged);
              this.element.dataset.sort = column.key;
              params.eGridHeader.dataset.vscodeContext = JSON.stringify({ webviewSection: 'columns', preventDefaultContextMenuItems: true });
              this.element.dataset.vscodeContext = JSON.stringify({ webviewSection: 'columns', preventDefaultContextMenuItems: true });
              this.element.innerHTML = `${column.key === 'name' ? options.history(record.p) : ''}<span class="column-caption"></span>`;
              this.element.querySelector('.column-caption').textContent = params.displayName;
            }
            getGui() { return this.element; }
            destroy() { this.column.removeEventListener('sortChanged', this.sortChanged); }
            refresh(params) {
              this.element.querySelector('.column-caption').textContent = params.displayName;
              const history = this.element.querySelector('.history-controls');
              if (history) {
                const next = this.element.cloneNode(false);
                next.innerHTML = options.history(record.p);
                options.patch(history, next.firstElementChild);
              }
              return true;
            }
          }
        }
      }));
    }

    function rowCreated(record, params) {
      const row = params.eRow;
      row.dataset.fileRow = '';
      if (params.node.id === parentId) {
        row.dataset.parent = '';
        row.classList.add('parent-row');
        row.setAttribute('aria-label', options.translate('Übergeordnetes Verzeichnis'));
      } else {
        row.dataset.id = params.node.data.id;
        row.draggable = !options.results(record.p);
      }

    }

    function rememberColumns(record, event) {
      if (record.updating || event.finished === false) return;
      if (event.type === 'columnResized') {
        if (event.source === 'uiColumnResized') for (const column of event.columns || []) record.manual.add(column.getColId());
        return;
      }
      if (event.type !== 'columnMoved' || !['uiColumnMoved', 'api'].includes(event.source)) return;
      const byId = new Map(record.p.columns.map(column => [column.key, column]));
      record.p.columns = record.api.getColumnState().map(saved => byId.get(saved.colId)).filter(Boolean);
      record.signature = signature(record.p);
      options.columnsChanged(record.p);
    }

    function signature(p) { return JSON.stringify(p.columns.map(({ key, label, field, visible, align }) => ({ key, label, field, visible, align }))); }

    function mount(section, p, rows) {
      const container = section.querySelector('[data-file-grid]');
      if (!container) return;
      let record = instances.get(container);
      if (record && record.view !== options.view(p)) { record.api.destroy(); instances.delete(container); record = undefined; }
      const source = options.source(p);
      const currentSignature = signature(p);
      const changed = !record || record.signature !== currentSignature;
      const ready = options.ready(p);
      if (record) {
        const focused = record.address?.contains(document.activeElement) ? document.activeElement : null;
        const selection = focused?.matches('input') ? [focused.selectionStart, focused.selectionEnd] : null;
        const navigated = record.path !== options.path(p);
        const holdWidths = record.ready && !ready;
        if (changed || navigated || record.count !== rows.length || record.source !== source) record.measurePending = true;
        record.ready = ready; record.count = rows.length; record.source = source;
        record.path = options.path(p);
        record.p = p; record.signature = currentSignature; marks(record);
        record.updating = true;
        try {
          if (holdWidths) record.api.applyColumnState({ state: record.api.getColumnState().map(({ colId, width }) => ({ colId, width, flex: null })) });
          updateAddress(record, false);
          if (changed) { record.manual.clear(); record.api.setGridOption('columnDefs', groupedDefinitions(record)); }
          record.api.setGridOption('rowData', [{ id: parentId }, ...rows]);
          record.api.refreshCells({ force: true });
          record.api.applyColumnState({ state: p.columns.map(column => ({ colId: column.key, sort: column.key === p.sort ? p.descending ? 'desc' : 'asc' : null })) });
          if (navigated) { record.api.refreshHeader(); record.api.ensureIndexVisible(0, 'top'); }
          if (focused?.isConnected) {
            focused.focus({ preventScroll: true });
            if (selection) focused.setSelectionRange(...selection);
          }
        } finally { record.updating = false; }
        sync(section, p);
        options.decorate(section, p);
        measureWhenReady(record);
        return;
      }
      record = { section, p, path: options.path(p), view: options.view(p), manual: new Set(), updating: true, ready, measurePending: true };
      record.source = source; record.font = font(container);
      record.count = rows.length; record.signature = currentSignature; marks(record);
      const nonce = document.querySelector('script[nonce]')?.nonce;
      record.api = library.createGrid(container, {
        gridId: `files-${section.dataset.pane}`,
        theme: library.themeQuartz.withParams({
          fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
          fontSize: 'var(--vscode-font-size, 13px)',
          headerFontSize: 12,
          iconSize: 'var(--icon-base-size)',
          backgroundColor: 'var(--bg)',
          foregroundColor: 'var(--text)',
          headerBackgroundColor: 'var(--bg)',
          headerTextColor: 'var(--muted)',
          borderColor: 'var(--line)',
          borderRadius: 0,
          wrapperBorder: false,
          wrapperBorderRadius: 0,
          rowBorder: false,
          rowHoverColor: 'var(--hover)',
          selectedRowBackgroundColor: 'var(--vscode-list-inactiveSelectionBackground, #37373d)',
          cellHorizontalPadding: 'var(--file-cell-padding)',
          headerColumnBorder: false,
          headerColumnResizeHandleWidth: 1,
          headerColumnResizeHandleHeight: '60%'
        }),
        rowBuffer: ready ? rows.length + 1 : 10,
        suppressMaxRenderedRowRestriction: true,
        defaultColDef: { cellDataType: false },
        onFirstDataRendered: () => { record.rendered = true; measureWhenReady(record); },
        getRowClass: params => {
          if (params.data.id === parentId) return ['parent-row'];
          const groups = options.results(record.p)?.groups, previous = params.api.getDisplayedRowAtIndex(params.rowIndex - 1)?.data;
          return [record.selected.has(params.data.id) ? 'selected' : '', record.p.cursor === params.data.id ? 'focused' : '', record.spaces.has(params.data.id) ? 'space-marked' : '', groups && previous?.id !== parentId && groups[previous?.fsSource] !== groups[params.data.fsSource] ? 'search-group-start' : ''].filter(Boolean);
        },
        styleNonce: nonce,
        columnDefs: groupedDefinitions(record),
        rowData: [{ id: parentId }, ...rows],
        getRowId: params => String(params.data.id),
        rowHeight: options.rowHeight(),
        headerHeight: options.rowHeight(),
        groupHeaderHeight: Math.max(26, options.controlHeight() + 3),
        scrollbarWidth: 12,
        animateRows: false,
        ensureDomOrder: true,
        suppressCellFocus: true,
        suppressScrollOnNewData: true,
        suppressMovableColumns: false,
        suppressDragLeaveHidesColumns: true,
        suppressColumnVirtualisation: true,
        rowSelection: { mode: 'multiRow', checkboxes: false, headerCheckbox: false, enableClickSelection: false, isRowSelectable: node => node.id !== parentId },
        processRowPostCreate: params => rowCreated(record, params),
        onColumnMoved: event => rememberColumns(record, event),
        onSortChanged: () => { if (!record.updating && record.p.filter && record.p.cursor) ensure(record.section, record.p.cursor); },
        onColumnResized: event => {
          if (event.source === 'autosizeColumns' && event.finished && record.measuring) {
            record.measuring = false;
            record.api.setGridOption('rowBuffer', 10);
            const filename = record.p.columns.find(column => column.visible !== false && options.isFilename(column));
            if (filename && !record.manual.has(filename.key)) record.api.applyColumnState({ state: [{ colId: filename.key, flex: 1 }] });
          }
          rememberColumns(record, event);
        },
        onViewportChanged: () => options.decorate(record.section, record.p),
        overlayNoRowsTemplate: '<span></span>'
      });
      record.updating = false;
      instances.set(container, record);
      sync(section, p);
      options.decorate(record.section, record.p);
    }

    function api(section) { return instances.get(section?.querySelector('[data-file-grid]'))?.api; }
    function sync(section, _p) {
      const grid = api(section);
      if (!grid) return;
      const record = instances.get(section.querySelector('[data-file-grid]')); marks(record);
      const selected = record.selected;
      grid.forEachNode(node => {
        const value = selected.has(node.id);
        if (node.isSelected() !== value) node.setSelected(value);
      });
    }
    function ensure(section, id) {
      const grid = api(section), node = grid?.getRowNode(String(id));
      if (node?.rowIndex !== null && node?.rowIndex !== undefined) grid.ensureIndexVisible(node.rowIndex);
    }
    function measureAll(record, key) {
      const keys = record.api.getAllDisplayedColumns().map(column => column.getColId()).filter(id => key === undefined ? !record.manual.has(id) : id === key);
      if (!keys.length) { record.api.setGridOption('rowBuffer', 10); return; }
      record.measuring = true;
      record.api.setGridOption('rowBuffer', record.api.getDisplayedRowCount());
      record.api.autoSizeColumns(keys);
    }
    function measureWhenReady(record) {
      if (!record.rendered || !record.ready || !record.measurePending) return;
      record.measurePending = false;
      measureAll(record);
    }
    function font(container) { const style = getComputedStyle(container); return [style.fontFamily, style.fontSize, style.fontWeight].join('|'); }
    function remeasure(section, force = false) {
      const record = instances.get(section?.querySelector('[data-file-grid]'));
      if (!record) return;
      const current = font(section.querySelector('[data-file-grid]'));
      if (force || record.font !== current) { record.font = current; record.measurePending = true; measureWhenReady(record); }
    }
    function prepareAutosize(section, key) {
      const record = instances.get(section?.querySelector('[data-file-grid]'));
      if (!record) return;
      record.manual.add(key); record.measuring = true;
      record.api.setGridOption('rowBuffer', record.api.getDisplayedRowCount());
    }
    function prune() {
      for (const [container, record] of instances) {
        if (!container.isConnected) { record.api.destroy(); instances.delete(container); }
      }
    }
    function dispose() { for (const record of instances.values()) record.api.destroy(); instances.clear(); }
    root.addEventListener('pagehide', dispose, { once: true });
    return { mount, sync, ensure, prepareAutosize, remeasure, prune, dispose, api };
  }
  root.CommanderGrid = { create };
})(typeof globalThis === 'object' ? globalThis : this);
