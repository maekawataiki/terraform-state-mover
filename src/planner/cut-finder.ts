import type { DependencyGraph, GraphEdge, Namespace, CutEdge, NamespaceConfig } from "../types.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";

const IMPORTANCE_SCORES: Record<string, number> = {
  "aws_iam_role": 3,
  "aws_iam_policy": 3,
  "aws_vpc": 5,
  "aws_eks_cluster": 5,
  "aws_db_instance": 4,
  "aws_rds_cluster": 4,
  "aws_lambda_function": 2,
  "aws_s3_bucket": 2,
};

export function findCrossNamespaceEdges(graph: DependencyGraph, config?: NamespaceConfig): CutEdge[] {
  const classifications = classifyGraph(graph.nodes, config);
  const cutEdges: CutEdge[] = [];

  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from);
    const toNs = classifications.get(edge.to);
    if (fromNs && toNs && fromNs !== toNs) {
      const fromNode = graph.nodes.get(edge.from);
      const toNode = graph.nodes.get(edge.to);
      const score = (IMPORTANCE_SCORES[fromNode?.resourceType || ""] || 1) +
        (IMPORTANCE_SCORES[toNode?.resourceType || ""] || 1);
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
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(cut);
  }
  return groups;
}
