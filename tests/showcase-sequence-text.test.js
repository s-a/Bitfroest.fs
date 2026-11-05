const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSequence, executeSequence } = require('../scripts/showcases/sequence.cjs');

test('text steps insert into the focused field and verify the resulting value without submitting', async () => {
  const steps = [{ type: 'type', selector: '#query', text: 'invoice', value: 'invoice' }];
  const calls = [], field = { value: '', focused: true };
  const evidence = await executeSequence(steps, {
    check: async step => {
      calls.push(['check', step]);
      return { matched: step.focused === true && field.focused && (step.value === undefined || field.value === step.value) };
    },
    type: async step => { calls.push(['type', step]); field.value += step.text; }
  });
  assert.deepEqual(calls.map(([name]) => name), ['check', 'type', 'check']);
  assert.deepEqual(calls[0][1], { selector: '#query', focused: true });
  assert.deepEqual(calls[2][1], { selector: '#query', value: 'invoice', focused: true });
  assert.equal(field.value, 'invoice');
  assert.equal(evidence[0].observed.matched, true);
});

test('text steps reject missing fields, oversized strings, and control characters before input', async () => {
  for (const step of [
    { type: 'type', selector: '', text: 'name' },
    { type: 'type', selector: '#query', text: '' },
    { type: 'type', selector: '#query', text: 'x'.repeat(257) },
    { type: 'type', selector: '#query', text: 'name\nEnter' }
  ]) assert.throws(() => validateSequence([step]));
});

test('text is never inserted unless the selected field is focused', async () => {
  let inserted = false;
  await assert.rejects(executeSequence([{ type: 'type', selector: '#query', text: 'invoice' }], {
    check: async () => ({ matched: false }),
    type: async () => { inserted = true; }
  }), /target field to be focused/);
  assert.equal(inserted, false);
});
