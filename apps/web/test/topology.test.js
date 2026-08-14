import assert from "node:assert/strict";
import test from "node:test";

import { buildTopologyGraph } from "../public/topology.js";

test("topology graph turns arbitrary service dependencies into directional edges", () => {
  const graph = buildTopologyGraph([
    { id: "edge", name: "Edge", health: "healthy", dependencies: ["orders", "identity"] },
    { id: "orders", name: "Orders", health: "critical", dependencies: ["cache"] },
    { id: "identity", name: "Identity", health: "healthy", dependencies: ["cache"] },
    { id: "cache", name: "Cache", health: "degraded", dependencies: [] },
  ]);

  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["edge->identity", "edge->orders", "identity->cache", "orders->cache"]);
  assert.ok(graph.edges.some((edge) => edge.from === "orders" && edge.to === "cache" && edge.health === "critical"));
  assert.ok(graph.nodes.find((node) => node.id === "edge").x < graph.nodes.find((node) => node.id === "orders").x);
  assert.ok(graph.nodes.find((node) => node.id === "orders").x < graph.nodes.find((node) => node.id === "cache").x);
});

test("topology graph tolerates a dependency cycle without losing nodes", () => {
  const graph = buildTopologyGraph([
    { id: "worker-a", name: "Worker A", health: "healthy", dependencies: ["worker-b"] },
    { id: "worker-b", name: "Worker B", health: "healthy", dependencies: ["worker-a"] },
  ]);

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
});
