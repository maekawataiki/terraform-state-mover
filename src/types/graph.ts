/**
 * Types for the analyzer domain — dependency graph, namespace classification.
 */

import type { TerraformBlock } from "./parser.js";

export type Namespace = "foundation" | "platform" | `service-${string}`;

export interface GraphNode {
  id: string;
  type: "resource" | "data";
  resourceType: string;
  name: string;
  repo: string;
  filePath: string;
  namespace?: Namespace;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "reference" | "arn" | "remote_state" | "unresolved";
  label?: string;
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface SerializedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ArnReference {
  arn: string;
  service: string;
  filePath: string;
  repo: string;
  sourceBlock?: TerraformBlock;
  resolved: boolean;
  definingResource?: GraphNode;
}

export interface ClassificationOverride {
  resourceType?: string;
  resourceName?: string;
  namespace: Namespace;
}

export interface NamespaceConfig {
  overrides?: ClassificationOverride[];
  customClassifier?: (node: GraphNode) => Namespace | null;
  groupByRepo?: boolean;
  /** Custom importance scores for cut-finder edge prioritization (resource_type → score). */
  importanceScores?: Record<string, number>;
}

export interface CutEdge {
  edge: GraphEdge;
  fromNamespace: Namespace;
  toNamespace: Namespace;
  score: number;
}
