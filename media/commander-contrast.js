(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderContrast = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function parse(value) {
    const text = String(value || '').trim();
    if (/^#[\da-f]{3}$/i.test(text)) return [...text.slice(1)].map(c => parseInt(c + c, 16));
    if (/^#[\da-f]{6}$/i.test(text)) return [1, 3, 5].map(i => parseInt(text.slice(i, i + 2), 16));
    const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/i.exec(text);
    return match && match.slice(1, 4).every(c => Number(c) <= 255) ? match.slice(1, 4).map(Number) : null;
  }
  function highlight(value) {
    const channels = parse(value) || [255, 235, 59];
    const linear = channels.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    const black = (luminance + .05) / .05, white = 1.05 / (luminance + .05);
    return { background: '#' + channels.map(c => Math.round(c).toString(16).padStart(2, '0')).join(''), foreground: black >= white ? '#000000' : '#ffffff', ratio: Math.max(black, white) };
  }
  return { highlight };
});
