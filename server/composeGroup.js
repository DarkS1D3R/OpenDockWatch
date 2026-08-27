// Orders a compose group's containers for a group-wide start/stop/restart so it respects the same
// com.docker.compose.depends_on relationships the Flow view already draws, rather than acting on
// whatever order `docker ps` happens to list them in. Pure and exported so it's unit-tested without
// a database or a docker daemon - server/index.js's compose-group route supplies the depends_on
// edges (via docker.js's dependsOnEdges, already computed for the Flow view and cached) and runs
// each returned level with Promise.all before moving to the next.

// Kahn's algorithm in levels rather than a flat topological order: two containers with no ordering
// relationship between them (the common case - most services in a compose file don't depend on
// each other) run in the same level, in parallel, instead of waiting on one another for no reason.
// A cycle (shouldn't happen from real compose depends_on, but a malformed one is possible) can't
// produce a "ready" container on some iteration - rather than looping forever, everything still
// remaining becomes one final unordered level.
function orderGroupLevels(containerIds, edges, action) {
  const idSet = new Set(containerIds);
  const deps = new Map(containerIds.map((id) => [id, new Set()])); // id -> ids it depends on
  for (const { source, target } of edges) {
    if (source !== target && idSet.has(source) && idSet.has(target)) deps.get(source).add(target);
  }

  const remaining = new Set(containerIds);
  const levels = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) => [...deps.get(id)].every((dep) => !remaining.has(dep)));
    if (!ready.length) {
      levels.push([...remaining]);
      break;
    }
    levels.push(ready);
    for (const id of ready) remaining.delete(id);
  }

  // Dependency-first is correct for start/restart (a container's dependencies come up before it).
  // stop is the opposite: whatever depends on something should stop before the thing it depends on.
  return action === 'stop' ? levels.slice().reverse() : levels;
}

module.exports = { orderGroupLevels };
