import type { DependencyGraph, CutEdge, NamespaceConfig } from "../types.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";
import { getOrCreate } from "../utils/map-utils.js";
import { DEFAULT_IMPORTANCE_SCORES } from "../analyzer/resource-types.js";

export function findCrossNamespaceEdges(graph: DependencyGraph, config?: NamespaceConfig): CutEdge[] {
  const classifications = classifyGraph(graph.nodes, config);
  const importanceScores = config?.importanceScores ?? DEFAULT_IMPORTANCE_SCORES;
  const cutEdges: CutEdge[] = [];

  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from);
    const toNs = classifications.get(edge.to);
    if (fromNs && toNs && fromNs !== toNs) {
      const fromNode = graph.nodes.get(edge.from);
      const toNode = graph.nodes.get(edge.to);
      const score = (importanceScores[fromNode?.resourceType || ""] || 1) +
        (importanceScores[toNode?.resourceType || ""] || 1);
      cutEdges.push({
        edge,
        fromNamespace: fromNs,
        toNamespace: toNs,
        score,
      });
    }
  }

  return cutEdges.sort((a, b) => b.score - a.score);
}

export function groupCutsByNamespacePair(cuts: CutEdge[]): Map<string, CutEdge[]> {
  const groups = new Map<string, CutEdge[]>();
  for (const cut of cuts) {
    const key = `${cut.fromNamespace} -> ${cut.toNamespace}`;
    getOrCreate(groups, key, () => []).push(cut);
  }
  return groups;
}
