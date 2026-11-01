(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderIconLayout = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const defaults = Object.freeze({ size: 16, gapRatio: 0.25, badgeRatio: 0.5, minimumRow: 22 });
  function resolve(value = defaults.size) {
    const size = Number.isInteger(value) && value >= 12 && value <= 48 ? value : defaults.size;
    const gap = size * defaults.gapRatio;
    return Object.freeze({ size, gap, badge: size * defaults.badgeRatio, control: size + gap * 2, row: Math.max(defaults.minimumRow, size + gap) });
  }
  return Object.freeze({ defaults, resolve });
});
