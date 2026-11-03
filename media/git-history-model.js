(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GitHistoryModel = api;
})(typeof window === 'object' ? window : globalThis, function () {
  function graphRows(commits) {
    let lanes = [];
    const visible = new Set(commits.map(commit => commit.hash));
    return commits.map(commit => {
      let lane = lanes.indexOf(commit.hash);
      const incoming = lane >= 0;
      if (lane < 0) { lane = lanes.length; lanes.push(commit.hash); }
      const before = [...lanes];
      lanes.splice(lane, 1);
      const parents = [...new Set(commit.parents)];
      for (let i = parents.length - 1; i >= 0; i--) if (visible.has(parents[i]) && !lanes.includes(parents[i])) lanes.splice(lane, 0, parents[i]);
      const edges = before.flatMap((hash, from) => hash === commit.hash ? [] : [{ from, to: lanes.indexOf(hash), pass: true }]);
      for (const parent of parents) edges.push({ from: lane, to: visible.has(parent) ? lanes.indexOf(parent) : lane, pass: false, external: !visible.has(parent) });
      return { hash: commit.hash, lane, width: Math.max(before.length, lanes.length, 1), incoming,
        parents: parents.map(hash => ({ hash, lane: lanes.indexOf(hash) })), edges };
    });
  }
  const statuses = { 0: ['Geändert', 'Modified'], 1: ['Hinzugefügt', 'Added'], 2: ['Gelöscht', 'Deleted'], 3: ['Umbenannt', 'Renamed'], 4: ['Kopiert', 'Copied'], 5: ['Geändert', 'Modified'], 6: ['Gelöscht', 'Deleted'], 11: ['Typ geändert', 'Type changed'] };
  function status(value, english) { return statuses[value]?.[english ? 1 : 0] || String(value); }
  return { graphRows, status };
});
