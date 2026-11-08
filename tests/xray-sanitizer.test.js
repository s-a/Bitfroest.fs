const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const createSanitizer = require('dompurify');

test('the shipped X-Ray bundle uses the locked sanitizer', () => {
  const notice = fs.readFileSync(path.join(__dirname, '../media/xray-editor.js.LEGAL.txt'), 'utf8');
  const versions = Array.from(notice.matchAll(/DOMPurify ([\d.]+)/g), match => match[1]);
  assert.deepEqual([...new Set(versions)], [createSanitizer.version]);
});

test('sanitizing an edited tree removes event handlers from a detached subtree', t => {
  const { window } = new JSDOM(
    '<main><section><span data-drop></span><img onerror="window.failed = true"></section><p>Keep <strong>formatting</strong></p></main>'
  );
  t.after(() => window.close());
  const sanitizer = createSanitizer(window);
  const root = window.document.querySelector('main');
  const image = root.querySelector('img');
  sanitizer.addHook('afterSanitizeAttributes', node => {
    if (node.hasAttribute?.('data-drop')) node.parentElement.remove();
  });

  sanitizer.sanitize(root, { IN_PLACE: true });

  assert.equal(root.innerHTML, '<p>Keep <strong>formatting</strong></p>');
  assert.equal(image.hasAttribute('onerror'), false);
});
