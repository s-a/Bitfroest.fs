(function (root) {
  'use strict';
  const icons = {
    'clipboard-copy': 'copy', 'clipboard-cut': 'arrow-right', 'clipboard-paste': 'clippy',
    'copy-path': 'link', 'close-tab': 'close', 'new-tab': 'add',
    'configure-columns': 'settings-gear', 'inspect-folder-locks': 'lock', git: 'git-compare', 'git-diff': 'git-compare',
    pack: 'file-zip', unpack: 'file-zip', 'test-archives': 'check-all', rename: 'edit', 'rename-one': 'edit',
    'select-group': 'checklist', 'unselect-group': 'checklist', 'select-all': 'check-all', clear: 'remove', invert: 'selection',
    'select-extension': 'symbol-key', 'save-selection': 'save', 'restore-selection': 'history',
    'save-selection-file': 'save', 'load-selection-file': 'folder-opened',
    'copy-names': 'copy', 'copy-full-names': 'copy', 'copy-details': 'copy', 'copy-full-details': 'copy',
    search: 'search', 'search-separate': 'search', back: 'arrow-left', swap: 'arrow-swap', 'swap-paths': 'arrow-swap',
    'sort:name': 'sort-precedence', 'sort:type': 'symbol-key', 'sort:date': 'calendar', 'sort:size': 'symbol-numeric',
    refresh: 'refresh', settings: 'settings-gear', licenses: 'law',
    Dateien: 'files', Markierung: 'check-all', Befehle: 'terminal', Ansicht: 'layout', Konfigurieren: 'settings-gear', Hilfe: 'question',
    Bearbeiten: 'edit', Optionen: 'settings-gear', Codierung: 'symbol-string',
    copy: 'copy', 'copy-hex': 'copy', find: 'search', next: 'search', cursor: 'edit', wrap: 'word-wrap', variable: 'text-size', manual: 'symbol-string'
  };
  let sequence = 0;
  function decorate(item, action, icon = icons[action], focusOnHover = true) {
    if (item.dataset.menuDecorated) return;
    item.dataset.menuDecorated = 'true';
    if (item.firstChild?.nodeType === 3) {
      const text = item.firstChild, label = document.createElement('span'); label.className = 'menu-label';
      item.replaceChild(label, text); label.append(text);
    }
    if (!icon && /^(encoding|charset):/.test(action)) icon = 'symbol-string';
    if (!icon && action.startsWith('mode:')) icon = action === 'mode:hex' ? 'file-binary' : 'files';
    const glyph = icon ? root.CommanderIcons.element(icon, { class: 'menu-icon', 'data-menu-icon': '' }) : document.createElement('span');
    if (!icon) { glyph.className = 'menu-icon'; glyph.dataset.menuIcon = ''; glyph.setAttribute('aria-hidden', 'true'); }
    item.append(glyph);
    if (focusOnHover) item.addEventListener('mouseenter', () => { if (!item.disabled && !item.hidden && item.getAttribute('aria-disabled') !== 'true') item.focus({ preventScroll: true }); });
  }
  function place(menu, { anchor, x, y, submenu = false } = {}) {
    const margin = 4, widthLimit = Math.max(1, root.innerWidth - margin * 2), heightLimit = Math.max(1, root.innerHeight - margin * 2);
    menu.style.position = 'fixed'; menu.style.maxWidth = `${widthLimit}px`; menu.style.maxHeight = `${heightLimit}px`;
    const bounds = menu.getBoundingClientRect(), owner = anchor?.getBoundingClientRect();
    const width = Math.min(bounds.width || menu.offsetWidth || 240, widthLimit), height = Math.min(bounds.height || menu.offsetHeight || 24, heightLimit);
    let left = x ?? owner?.left ?? margin, top = y ?? owner?.bottom ?? margin;
    menu.dataset.vertical = 'down';
    if (submenu && owner) {
      left = owner.right - 1; top = owner.top; menu.dataset.direction = 'right';
      if (left + width > root.innerWidth - margin) { left = owner.left - width + 1; menu.dataset.direction = 'left'; }
    }
    if (top + height > root.innerHeight - margin) {
      const above = y !== undefined ? y - height : !submenu && owner ? owner.top - height : root.innerHeight - margin - height;
      top = Math.max(margin, above); menu.dataset.vertical = 'up';
    }
    left = Math.max(margin, Math.min(left, root.innerWidth - margin - width));
    top = Math.max(margin, Math.min(top, root.innerHeight - margin - height));
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    return menu;
  }
  function create({ items, label, decorateKeys, onAction, onClose, emptyLabel = '' }) {
    function build(entries, parent = null, owner = null) {
      const menu = document.createElement('div'); menu.className = 'menu-surface'; menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', owner?.querySelector('.menu-label')?.textContent || label); menu.tabIndex = -1;
      const record = { menu, parent, owner, child: null };
      function closeChild() {
        if (!record.child) return;
        record.child.owner.setAttribute('aria-expanded', 'false'); record.child.owner.removeAttribute('aria-controls');
        delete record.child.owner.dataset.openDirection; record.child.menu.remove(); record.child = null;
      }
      const enabled = () => [...menu.children].filter(item => item.matches('button:not(:disabled)'));
      for (const entry of entries) {
        const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem');
        item.textContent = entry.label; item.disabled = Boolean(entry.disabled);
        for (const [key, value] of Object.entries(entry.attrs || {})) item.setAttribute(key, value);
        if (entry.keys?.length) decorateKeys?.(item, entry.keys);
        decorate(item, entry.id || '', entry.icon);
        if (entry.children) {
          item.setAttribute('aria-haspopup', 'menu'); item.setAttribute('aria-expanded', 'false');
          item.append(root.CommanderIcons.element('chevron-right', { 'data-submenu-arrow': '' }));
        }
        function open(focus) {
          if (item.disabled) return;
          if (!record.child || record.child.owner !== item) {
            closeChild();
            const child = build(entry.children, record, item); record.child = child;
            child.menu.id = `commander-submenu-${++sequence}`; item.setAttribute('aria-controls', child.menu.id);
            child.menu.dataset.menuSubmenu = ''; menu.append(child.menu);
            place(child.menu, { anchor: item, submenu: true }); item.setAttribute('aria-expanded', 'true');
            item.dataset.openDirection = child.menu.dataset.direction;
          }
          if (focus) (record.child.menu.querySelector('button:not(:disabled)') || record.child.menu).focus();
        }
        item.addEventListener('mouseenter', () => { if (entry.children) open(false); else closeChild(); });
        item.onclick = () => { if (item.disabled) return; if (entry.children) open(true); else onAction(entry); };
        item.addEventListener('keydown', event => {
          if (event.key === 'ArrowRight' && entry.children) { event.preventDefault(); event.stopPropagation(); open(true); }
        });
        menu.append(item);
      }
      if (!entries.length && emptyLabel) { const text = document.createElement('span'); text.className = 'menu-empty'; text.setAttribute('role', 'status'); text.textContent = emptyLabel; menu.append(text); }
      menu.addEventListener('scroll', event => { if (event.target === menu) closeChild(); });
      menu.addEventListener('keydown', event => {
        event.stopPropagation();
        const current = document.activeElement;
        if (event.key === 'Escape' || event.key === 'ArrowLeft' && parent) {
          event.preventDefault();
          if (parent) { owner.setAttribute('aria-expanded', 'false'); owner.removeAttribute('aria-controls'); delete owner.dataset.openDirection; menu.remove(); parent.child = null; owner.focus(); }
          else onClose(true);
        } else if (event.key === 'Tab') onClose(false);
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); closeChild(); const buttons = enabled(), index = buttons.indexOf(current);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
          buttons[next]?.focus();
        } else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); current?.closest('button')?.click(); }
      });
      return record;
    }
    return build(items).menu;
  }
  root.CommanderMenus = { create, decorate, place };
})(window);
