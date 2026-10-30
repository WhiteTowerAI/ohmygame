/**
 * Lays the story out as a map, from graph.json alone, so it holds at any
 * screen size and arranging the editor's canvas does not change it.
 *
 * A step in the story is a `replace` edge from an Exit that is not
 * navigation; `push` edges lead to side screens the player comes back from,
 * so their targets are only on the map when the story reaches them another
 * way. Scenes in `offMap` are left out and the steps through them joined, so
 * a menu between two Scenes links them directly. Steps back to a Scene
 * already above, such as retrying a failed QTE, are left out too, so the map
 * always reads downwards.
 *
 * Returns the Scenes with their `row`, their `column` from the left of a row
 * of `rowSize`, their `label`, and whether each is an `ending`; and the links
 * between them, each with the graph edge `via` which it starts.
 */
export function layoutStory(graph, { offMap = new Set(), labels = {}, isEnding = () => false } = {}) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const shown = (id) => !offMap.has(id);

  /** The story steps out of a Scene, in the order of its Exits. */
  const steps = (node) => node.signals
    .filter((signal) => signal.role !== "navigation")
    .flatMap((signal) => graph.edges.filter((edge) => edge.source.nodeId === node.id
      && edge.source.signal === signal.id
      && edge.mode === "replace"
      && byId.has(edge.targetNodeId)));

  /** The Scenes on the map a Scene's steps reach, walking through those off it. */
  const reach = (id) => {
    const links = [];
    const visited = new Set([id]);
    const walk = (nodeId, via) => {
      for (const edge of steps(byId.get(nodeId))) {
        const first = via ?? edge.id;
        if (shown(edge.targetNodeId)) {
          if (!links.some((link) => link.to === edge.targetNodeId)) links.push({ from: id, to: edge.targetNodeId, via: first });
        } else if (!visited.has(edge.targetNodeId)) {
          visited.add(edge.targetNodeId);
          walk(edge.targetNodeId, first);
        }
      }
    };
    walk(id, undefined);
    return links;
  };

  if (!byId.has(graph.entryNodeId)) return { nodes: [], links: [] };
  const roots = shown(graph.entryNodeId) ? [graph.entryNodeId] : reach(graph.entryNodeId).map((link) => link.to);

  // Depth-first from the roots: the order Scenes are found seeds their order
  // in a row, and a step to a Scene still being walked is a step back.
  const order = [];
  const finished = [];
  const links = [];
  const state = new Map();
  const visit = (id) => {
    state.set(id, "walking");
    order.push(id);
    for (const link of reach(id)) {
      const target = state.get(link.to);
      if (target === "walking") continue;
      links.push(link);
      if (!target) visit(link.to);
    }
    state.set(id, "done");
    finished.push(id);
  };
  for (const root of roots) if (!state.has(root)) visit(root);

  // Each Scene sits one row below the lowest Scene that leads to it.
  const rows = new Map();
  for (const id of [...finished].reverse()) {
    const above = links.filter((link) => link.to === id).map((link) => rows.get(link.from) ?? 0);
    rows.set(id, above.length ? Math.max(...above) + 1 : 0);
  }
  const rowCount = Math.max(0, ...rows.values()) + 1;
  const grid = Array.from({ length: rowCount }, () => []);
  for (const id of order) grid[rows.get(id)].push(id);

  // Twice down the rows, sort each row by where the Scenes leading to it sit,
  // so branches spread under their Scene and lines cross less.
  const offset = (id) => {
    const row = grid[rows.get(id)];
    return row.indexOf(id) - (row.length - 1) / 2;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (const row of grid.slice(1)) {
      const weight = new Map(row.map((id) => {
        const above = links.filter((link) => link.to === id).map((link) => offset(link.from));
        return [id, above.reduce((sum, value) => sum + value, 0) / Math.max(1, above.length)];
      }));
      row.sort((left, right) => weight.get(left) - weight.get(right));
    }
  }

  return {
    nodes: order.map((id) => {
      const node = byId.get(id);
      const row = grid[rows.get(id)];
      return {
        id,
        label: labels[id] ?? node.title,
        row: rows.get(id),
        column: row.indexOf(id),
        rowSize: row.length,
        ending: isEnding(node),
      };
    }),
    links,
  };
}
