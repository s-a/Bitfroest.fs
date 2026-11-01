const names = new Set(['folder', 'folder-opened', 'star-full', 'arrow-swap', 'menu']);

function productIcon(name) {
  if (!names.has(name)) throw new Error(`Unknown platform icon: ${name}.`);
  return `$(${name})`;
}

module.exports = { productIcon };
