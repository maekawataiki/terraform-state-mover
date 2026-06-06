import type { DependencyGraph, CutEdge, NamespaceConfig } from "../types.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";
import { getOrCreate } from "../utils/map-utils.js";

/**
 * Importance scores for cross-namespace edge prioritization.
 * Higher scores = higher migration priority.
 *
 * Rationale:
 * - VPC/EKS (5): Foundational infra that many services depend on. Moving these first
 *   unblocks downstream migrations and reduces blast radius significantly.
 * - RDS (4): Stateful resources with complex migration requirements. High risk of
 *   data loss if handled incorrectly — prioritize for careful attention.
 * - IAM (3): Most common gatekeeper resource. Frequently the root cause of cross-repo
 *   coupling and deploy bottlenecks.
 * - Lambda/S3 (2): Stateless or easily recreatable. Lower migration risk.
 * - Default (1): Resources without specific classification.
 */
const DEFAULT_IMPORTANCE_SCORES: Record<string, number> = {
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
