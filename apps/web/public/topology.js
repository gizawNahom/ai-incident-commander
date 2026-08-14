const healthRank = { healthy: 0, degraded: 1, critical: 2 };

export function buildTopologyGraph(services) {
  const byId = new Map(services.map((service) => [service.id, service]));
  const depths = new Map();
  const findDepth = (service, visiting = new Set()) => {
    if (depths.has(service.id)) return depths.get(service.id);
    if (visiting.has(service.id)) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(service.id);
    const dependencyDepths = service.dependencies
      .map((dependencyId) => byId.get(dependencyId))
      .filter(Boolean)
      .map((dependency) => findDepth(dependency, nextVisiting));
    const depth = dependencyDepths.length ? Math.max(...dependencyDepths) + 1 : 0;
    depths.set(service.id, depth);
    return depth;
  };
  for (const service of services) findDepth(service);

  const maxDepth = Math.max(0, ...depths.values());
  const nodesByLayer = new Map();
  for (const service of services) {
    const layer = maxDepth - depths.get(service.id);
    const layerNodes = nodesByLayer.get(layer) ?? [];
    layerNodes.push(service);
    nodesByLayer.set(layer, layerNodes);
  }

  const nodes = [];
  for (const [layer, layerServices] of nodesByLayer) {
    layerServices.sort((left, right) => left.name.localeCompare(right.name));
    layerServices.forEach((service, index) => {
      const x = maxDepth === 0 ? 50 : 9 + (layer / maxDepth) * 82;
      const y = ((index + 1) / (layerServices.length + 1)) * 100;
      nodes.push({ ...service, x, y });
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = services.flatMap((service) => service.dependencies
    .filter((dependencyId) => byId.has(dependencyId))
    .map((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return {
        from: service.id,
        to: dependencyId,
        health: healthRank[service.health] >= healthRank[dependency.health] ? service.health : dependency.health,
        fromNode: nodeById.get(service.id),
        toNode: nodeById.get(dependencyId),
      };
    }));

  return { nodes, edges };
}
