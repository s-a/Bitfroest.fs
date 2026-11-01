(function (root) {
  'use strict';
  const fonts = new Map(Object.entries(root.CommanderIconFontMetrics || {}));
  const vectors = new Map();
  const themeNames = new Set();
  function collectThemeNames(value) {
    if (typeof value === 'string' && /^[a-zA-Z\d_-]+$/.test(value)) themeNames.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectThemeNames);
  }
  try { collectThemeNames(JSON.parse(decodeURIComponent(document.body.dataset.iconTheme || '%7B%7D'))); } catch { /* Invalid associations do not authorize theme icons. */ }
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function attributes(values = {}) {
    return Object.entries(values).map(([name, value]) => {
      if (!/^(?:class|title|role|aria-[a-z-]+|data-[a-z-]+)$/.test(name) || name === 'data-icon-reviewed') throw new Error('Invalid icon attribute.');
      return ` ${name}="${escape(value)}"`;
    }).join('');
  }
  for (const [collection, registry] of [['workbench', root.CommanderWorkbenchIcons], ['status', root.CommanderStatusIcons]]) {
    for (const [name, source] of Object.entries(registry || {})) {
      const template = document.createElement('template'); template.innerHTML = source;
      const svg = template.content.firstElementChild;
      const tags = new Set(['svg', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'g']);
      if (template.content.children.length !== 1 || svg?.localName !== 'svg' || !svg.hasAttribute('viewBox') ||
        [...template.content.querySelectorAll('*')].some(node => !tags.has(node.localName) || [...node.attributes].some(attribute => /^(?:on|href|style)/i.test(attribute.name)))) {
        throw new Error(`Invalid icon resource: ${collection}:${name}.`);
      }
      const viewBox = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
      if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error(`Invalid icon viewBox: ${name}.`);
      svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('data-icon-reviewed', `${collection}:${name}`);
      vectors.set(`${collection}:${name}`, svg.outerHTML);
    }
  }
  function checkFont(name) {
    const fit = fonts.get(name);
    if (!fit || ![fit.fontScale, fit.left, fit.top].every(Number.isFinite) || fit.fontScale <= 0 || !Array.isArray(fit.classes) || !fit.classes.length ||
      !fit.classes.every(value => /^(?:codicon|icon-font)(?:-[a-z0-9-]+)?$/.test(value))) throw new Error(`Unknown or unmeasured icon font glyph: ${name}.`);
    return fit;
  }
  function font(name, values = {}, text = '') {
    const fit = checkFont(name);
    if (String(values.class || '').split(/\s+/).some(value => /^(?:codicon|icon-font)(?:-|$)/.test(value))) throw new Error('Icon font classes are controlled by the central renderer.');
    const classes = fit.classes.join(' ') + (values.class ? ` ${values.class}` : '');
    return `<span${attributes({ 'aria-hidden': 'true', ...values, class: classes })} data-icon-reviewed="font:${name}">${escape(text)}</span>`;
  }
  function element(name, values, text) {
    const template = document.createElement('template'); template.innerHTML = font(name, values, text);
    return template.content.firstElementChild;
  }
  function setFont(node, name, spinning = false) {
    const fit = checkFont(name);
    if (!node?.dataset.iconReviewed?.startsWith('font:')) throw new Error('Icon must be created by the central renderer.');
    const previous = checkFont(node.dataset.iconReviewed.slice(5));
    node.classList.remove(...previous.classes, 'codicon-modifier-spin');
    node.classList.add(...fit.classes);
    node.querySelector('[data-icon-reviewed="workbench:loading"]')?.remove();
    if (spinning) {
      node.classList.add('codicon-modifier-spin');
      const template = document.createElement('template'); template.innerHTML = svg('workbench', 'loading');
      template.content.firstElementChild.setAttribute('viewBox', '2 2 12 12');
      node.append(template.content);
    }
    node.dataset.iconReviewed = `font:${name}`;
  }
  function svg(collection, name) {
    const markup = vectors.get(`${collection}:${name}`);
    if (!markup) throw new Error(`Unknown icon resource: ${collection}:${name}.`);
    return markup;
  }
  function native(source, values = {}) {
    if (!/^data:image\/png;base64,[A-Za-z\d+/]+={0,2}$/.test(source)) throw new Error('Invalid native icon source.');
    return `<img${attributes({ class: 'fileicon native-icon', ...values })} data-icon-reviewed="native" width="16" height="16" src="${escape(source)}" alt="">`;
  }
  function theme(name) {
    if (!themeNames.has(name)) throw new Error('Unknown or invalid theme icon class.');
    return `<span aria-hidden="true" class="fileicon themed ${escape(name)}" data-icon-reviewed="theme"></span>`;
  }
  function folder() {
    return `<span aria-hidden="true" class="fileicon folder bootstrap-folder" data-icon-reviewed="folder">${svg('status', 'folder')}</span>`;
  }
  function fallback(type) {
    const types = { archive: 'file-zip', markdown: 'markdown', code: 'file-code', text: 'file' };
    const kind = Object.hasOwn(types, type) ? type : 'text';
    return font(types[kind], { class: `fileicon ${kind}` });
  }
  function location(kind = '') {
    if (!['', 'git', 'zip'].includes(kind)) throw new Error('Unknown location icon context.');
    const main = kind ? svg('workbench', kind === 'zip' ? 'file-zip' : 'git') : font('star-full');
    const badge = kind ? `<span class="location-favorite-badge" data-location-badge data-icon-reviewed="badge:favorites">${font('star-full')}</span>` : '';
    return `<span class="location-context-icon" data-location-icon="${kind}" data-icon-reviewed="location:${kind || 'favorites'}" aria-hidden="true" aria-label="${kind === 'zip' ? 'ZIP' : kind === 'git' ? 'Git' : 'Favorites'}">${main}${badge}</span>`;
  }
  let currentLayout;
  function configure(value) {
    currentLayout = root.CommanderIconLayout.resolve(value);
    const { size, gap, badge, control, row } = currentLayout;
    for (const [name, number] of Object.entries({ 'base-size': size, 'size': size, 'text-gap': gap, 'badge-size': badge, 'control-size': control, 'row-size': row })) {
      document.body.style.setProperty(`--icon-${name}`, `${number}px`);
    }
    return currentLayout;
  }
  function layout() { return currentLayout; }
  root.CommanderIcons = Object.freeze({ font, element, setFont, svg, native, theme, folder, fallback, location, configure, layout });
})(window);
