(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommanderFileColors = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function parse(value) {
    const text = String(value || '').trim();
    if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(text)) {
      let hex = text.slice(1);
      if (hex.length < 5) hex = [...hex].map(c => c + c).join('');
      return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1);
    }
    if (text === 'transparent') return [0, 0, 0, 0];
    const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(text);
    if (!match) return null;
    const channels = match.slice(1, 4).map(Number), alpha = match[4] === undefined ? 1 : Number(match[4]);
    return channels.every(c => Number.isFinite(c) && c <= 255) && Number.isFinite(alpha) && alpha <= 1 ? [...channels, alpha] : null;
  }
  const hex = channels => '#' + channels.slice(0, 3).map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
  function composite(front, back) {
    const a = parse(front), b = parse(back);
    if (!a || !b || b[3] !== 1) return null;
    return hex(a.slice(0, 3).map((c, i) => c * a[3] + b[i] * (1 - a[3])));
  }
  function luminance(channels) {
    const linear = channels.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  }
  function ratio(front, back) {
    const a = parse(composite(front, back)), b = parse(back);
    if (!a || !b || b[3] !== 1) return 0;
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  }
  function readable(desired, background, fallback) {
    const back = parse(background);
    if (!back || back[3] !== 1) return null;
    const starting = composite(desired, background);
    if (starting && ratio(starting, background) >= 4.5) return starting;
    if (starting) {
      const channels = parse(starting), target = ratio('#000000', background) >= ratio('#ffffff', background) ? 0 : 255;
      for (let step = 1; step <= 100; step++) {
        const candidate = hex(channels.slice(0, 3).map(c => c + (target - c) * step / 100));
        if (ratio(candidate, background) >= 4.5) return candidate;
      }
    }
    const safe = composite(fallback, background);
    if (safe && ratio(safe, background) >= 4.5) return safe;
    return ratio('#000000', background) >= ratio('#ffffff', background) ? '#000000' : '#ffffff';
  }
  function compile(rules) {
    const ordered = Object.keys(rules || {}).filter(pattern => parse(rules[pattern]) && pattern.length <= 256)
      .sort((a, b) => b.length - a.length || a.localeCompare(b)).map(pattern => ({ mask: pattern.toLowerCase(), color: rules[pattern] }));
    const cache = new Map();
    return name => {
      const value = name.toLowerCase();
      if (cache.has(value)) return cache.get(value);
      let result = null;
      for (const { mask, color } of ordered) {
        let index = 0, token = 0, star = -1, retry = 0;
        while (index < value.length) {
          if (mask[token] === '?' || mask[token] === value[index]) { token++; index++; }
          else if (mask[token] === '*') { star = token++; retry = index; }
          else if (star !== -1) { token = star + 1; index = ++retry; }
          else break;
        }
        while (mask[token] === '*') token++;
        if (index === value.length && token === mask.length) { result = color; break; }
      }
      if (cache.size >= 4096) cache.clear();
      cache.set(value, result);
      return result;
    };
  }
  function match(name, rules) { return compile(rules)(name); }
  return { parse, readable, ratio, composite, match, compile };
});
