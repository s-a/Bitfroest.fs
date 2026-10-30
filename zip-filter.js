function matches(name, filter = '*.*') {
  const [include, exclude = ''] = filter.split('|');
  const tokens = value => (value.match(/"[^"]*"|[^;\s]+/g) || []).map(value => value.replace(/^"|"$/g, ''));
  const match = pattern => new RegExp('^' + (pattern === '*.*' ? '*' : pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i').test(name);
  const included = tokens(include);
  return (!included.length || included.some(match)) && !tokens(exclude).some(match);
}
module.exports = { matches };
