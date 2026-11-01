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
  const hex = channels => '#' + channels.map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
  function luminance(channels) {
    const linear = channels.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  }
  function highlight(value) {
    const channels = parse(value) || [255, 235, 59], light = luminance(channels);
    const black = (light + .05) / .05, white = 1.05 / (light + .05);
    return { background: hex(channels), foreground: black >= white ? '#000000' : '#ffffff', ratio: Math.max(black, white) };
  }
  function progressColors(foreground, background, accent) {
    let text = parse(foreground);
    const base = parse(background), tint = parse(accent);
    if (!text || !base || !tint) return null;
    const ratio = color => (Math.max(luminance(text), luminance(color)) + .05) / (Math.min(luminance(text), luminance(color)) + .05);
    if (ratio(base) < 4.5) text = parse(highlight(background).foreground);
    let fill = base;
    for (let weight = 24; weight >= 0; weight--) {
      const candidate = base.map((channel, i) => Math.round(channel + (tint[i] - channel) * weight / 100));
      if (ratio(candidate) >= 4.5) { fill = candidate; break; }
    }
    return { foreground: hex(text), fill: hex(fill) };
  }
  return { highlight, progressColors };
});
