(function (root) {
  'use strict';

  const segmenter = new Intl.Segmenter();
  function middleEllipsis(value, width, measure) {
    if (measure(value) <= width) return value;
    if (measure('…') > width) return '';
    const characters = Array.from(segmenter.segment(value), part => part.segment);
    let lower = 0, upper = characters.length - 1, result = '…';
    while (lower <= upper) {
      const size = Math.floor((lower + upper) / 2);
      const start = Math.ceil(size / 2), end = Math.floor(size / 2);
      const candidate = characters.slice(0, start).join('') + '…' + characters.slice(characters.length - end).join('');
      if (measure(candidate) <= width) { result = candidate; lower = size + 1; }
      else upper = size - 1;
    }
    return result;
  }

  let context;
  const observer = root.ResizeObserver ? new ResizeObserver(entries => {
    for (const { target } of entries) target.refresh();
  }) : null;
  class PathField extends HTMLElement {
    static observedAttributes = ['value'];

    connectedCallback() {
      if (!this.display) {
        this.input = this.querySelector('input');
        this.display = this.querySelector(':scope > .path-field-display');
        if (!this.display) {
          this.display = document.createElement(this.input ? 'button' : 'span');
          this.display.className = 'path-field-display';
          this.prepend(this.display);
        }
        if (this.input) {
          this.input.classList.add('path-field-input');
          this.input.dataset.vscodeContext = JSON.stringify({ webviewSection: 'textInput', preventDefaultContextMenuItems: false });
          this.input.hidden = true;
          this.display.hidden = false;
          this.display.type = 'button';
          this.display.addEventListener('click', () => this.edit());
          this.input.addEventListener('invalid', () => this.edit());
          this.input.addEventListener('keydown', event => {
            if (!['Enter', 'Escape'].includes(event.key) || event.isComposing) return;
            if (event.key === 'Enter' && this.hasAttribute('submit-on-enter')) return;
            event.preventDefault();
            event.stopPropagation();
            const commit = event.key === 'Enter';
            if (!commit && this.input.value !== this.beforeEdit) {
              this.input.value = this.beforeEdit;
              this.input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const submit = commit && this.closest('form')?.querySelector('button[type="submit"]:not([hidden]):not(:disabled)');
            this.finish();
            (submit || this.display).focus();
          });
        } else {
          this.setAttribute('role', 'group');
          this.display.setAttribute('aria-hidden', 'true');
        }
        this.addEventListener('copy', event => {
          if (this.display.hidden) return;
          const selection = root.getSelection();
          if (!event.clipboardData || selection?.anchorNode?.parentElement !== this.display || selection.toString() !== this.display.textContent) return;
          event.clipboardData.setData('text/plain', this.fullValue);
          event.preventDefault();
        });
      }
      observer?.observe(this);
      this.refresh();
    }

    disconnectedCallback() { observer?.unobserve(this); this.stopEditing?.(); }
    attributeChangedCallback() { if (this.display) this.refresh(); }

    get fullValue() { return this.input?.value ?? this.getAttribute('value') ?? ''; }

    edit() {
      if (!this.input || !this.input.hidden) return;
      this.beforeEdit = this.input.value;
      this.display.hidden = true;
      this.input.hidden = false;
      this.input.focus();
      this.stopEditing = root.BitfroestWebviewInteractions.watchPathEditor(this.input, () => this.finish());
      this.input.select();
    }

    finish() {
      if (!this.input || this.input.hidden) return;
      this.stopEditing?.();
      this.input.hidden = true;
      this.display.hidden = false;
      this.refresh();
    }

    refresh() {
      if (this.display.hidden) return;
      const value = this.fullValue, label = this.getAttribute('label');
      this.title = value;
      (this.input ? this.display : this).setAttribute('aria-label', label && value ? `${label}: ${value}` : label || value);
      const width = this.display.clientWidth;
      let text = value || label || '';
      if (value && width > 0) {
        context ??= document.createElement('canvas').getContext('2d');
        if (context) {
          const style = getComputedStyle(this.display);
          const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          if ('letterSpacing' in context) context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
          text = middleEllipsis(value, width - (padding || 0), candidate => context.measureText(candidate).width);
        }
      }
      if (text !== this.display.textContent) this.display.textContent = text;
    }
  }

  root.BitfroestPathField = { middleEllipsis };
  root.customElements.define('bitfroest-path', PathField);
  const refreshPaths = () => document.querySelectorAll('bitfroest-path').forEach(field => field.refresh());
  document.fonts?.addEventListener('loadingdone', refreshPaths);
  if (document.body) new MutationObserver(refreshPaths).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
})(window);
