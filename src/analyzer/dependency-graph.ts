import type { ParsedFile, DependencyGraph, GraphNode, GraphEdge, SerializedGraph, NamespaceConfig } from "../types.js";
import { classifyGraph } from "./namespace-classifier.js";

export function buildNodeId(type: "resource" | "data", resourceType: string, name: string, repo: string): string {
  return `${repo}:${type}.${resourceType}.${name}`;
}

export function buildGraph(parsedFiles: ParsedFile[]): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // First pass: register all nodes
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type === "resource" || block.type === "data") {
        const id = buildNodeId(block.type, block.resourceType, block.name, block.repo);
        nodes.set(id, {
          id,
          type: block.type,
          resourceType: block.resourceType,
          name: block.name,
          repo: block.repo,
          filePath: block.filePath,
        });
      }
    }
  }

  // Build ARN→definer map: identify which resource "owns" each ARN
  const arnServiceTypeMap: Record<string, string> = {
    iam: "aws_iam_role",
    s3: "aws_s3_bucket",
    rds: "aws_db_instance",
    lambda: "aws_lambda_function",
    dynamodb: "aws_dynamodb_table",
    sqs: "aws_sqs_queue",
    sns: "aws_sns_topic",
    eks: "aws_eks_cluster",
    kinesis: "aws_kinesis_stream",
  };

  const arnDefinerMap = new Map<string, { id: string; repo: string }>();
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "resource") continue;
      for (const arn of block.arns) {
        // Extract service from ARN: arn:aws:{service}:...
        const arnParts = arn.split(":");
        const arnService = arnParts[2];
        const expectedType = arnServiceTypeMap[arnService];
        // The definer is identified if the resource type matches the ARN service
        // OR if the resource name appears in the ARN path
        const arnPath = arnParts.slice(5).join(":").replace(/^[^/]*\//, "");
        const nameInArn = arnPath.replace(/-/g, "_").toLowerCase().includes(block.name.toLowerCase().replace(/-/g, "_"));
        if (block.resourceType === expectedType || nameInArn) {
          const id = buildNodeId("resource", block.resourceType, block.name, block.repo);
          if (!arnDefinerMap.has(arn)) {
            arnDefinerMap.set(arn, { id, repo: block.repo });
          }
        }
      }
    }
  }

  // Second pass: detect edges
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "resource" && block.type !== "data") continue;
      const fromId = buildNodeId(block.type, block.resourceType, block.name, block.repo);

      // Detect data source references in body
      const dataRefPattern = /data\.([a-z_]+)\.([a-z_][a-z0-9_]*)/g;
      let match: RegExpExecArray | null;
      while ((match = dataRefPattern.exec(block.body)) !== null) {
        const targetId = buildNodeId("data", match[1], match[2], block.repo);
        if (nodes.has(targetId)) {
          edges.push({ from: fromId, to: targetId, type: "reference", label: `data.${match[1]}.${match[2]}` });
        }
      }

      // Detect resource references
      const resRefPattern = /(?<!\.)([a-z_]+)\.([a-z_][a-z0-9_]*)\.([a-z_]+)/g;
      while ((match = resRefPattern.exec(block.body)) !== null) {
        if (["var", "local", "module", "data", "each", "self", "path", "count"].includes(match[1])) continue;
        const targetId = buildNodeId("resource", match[1], match[2], block.repo);
        if (nodes.has(targetId) && targetId !== fromId) {
          edges.push({ from: fromId, to: targetId, type: "reference", label: `${match[1]}.${match[2]}` });
        }
      }

      // Detect remote state references
      if (block.body.includes("terraform_remote_state")) {
        const remotePattern = /data\.terraform_remote_state\.([a-z_][a-z0-9_]*)/g;
        while ((match = remotePattern.exec(block.body)) !== null) {
          const targetId = buildNodeId("data", "terraform_remote_state", match[1], block.repo);
          if (nodes.has(targetId)) {
            edges.push({ from: fromId, to: targetId, type: "remote_state", label: match[1] });
          }
        }
      }

      // Cross-repo ARN matching: consumer→definer only
      for (const arn of block.arns) {
        const definer = arnDefinerMap.get(arn);
        if (definer && definer.repo !== block.repo && definer.id !== fromId) {
          edges.push({ from: fromId, to: definer.id, type: "arn", label: arn });
        }
      }
    }
  }

  // Deduplicate edges
  const seen = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.type}|${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { nodes, edges: uniqueEdges };
}

export function detectCycles(graph: DependencyGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from)!.push(edge.to);
  }

  function dfs(node: string): void {
    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (stack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        cycles.push(path.slice(cycleStart));
      }
    }

    path.pop();
    stack.delete(node);
  }

  for (const nodeId of graph.nodes.keys()) {
    if (!visited.has(nodeId)) dfs(nodeId);
  }

  return cycles;
}

export function serializeGraph(graph: DependencyGraph): SerializedGraph {
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  };
}

const NAMESPACE_COLORS: Record<string, string> = {
  foundation: "#2196F3",
  platform: "#4CAF50",
};
const SERVICE_COLOR = "#FF9800";
const NAMESPACE_FILL: Record<string, string> = {
  foundation: "#E3F2FD",
  platform: "#E8F5E9",
};
const SERVICE_FILL = "#FFF3E0";

function nsColor(ns: string): string {
  if (ns === "foundation") return NAMESPACE_COLORS.foundation;
  if (ns === "platform") return NAMESPACE_COLORS.platform;
  return SERVICE_COLOR;
}

function nsFill(ns: string): string {
  if (ns === "foundation") return NAMESPACE_FILL.foundation;
  if (ns === "platform") return NAMESPACE_FILL.platform;
  return SERVICE_FILL;
}

function shortLabel(node: GraphNode): string {
  return `${node.resourceType}\\n${node.name}`;
}

/**
 * Basic dependency graph (legacy compatible)
 */
export function toGraphviz(graph: DependencyGraph): string {
  const lines = ["digraph terraform {", "  rankdir=LR;"];
  for (const node of graph.nodes.values()) {
    const label = `${node.type}.${node.resourceType}.${node.name}\\n(${node.repo})`;
    lines.push(`  "${node.id}" [label="${label}"];`);
  }
  for (const edge of graph.edges) {
    const style = edge.type === "arn" ? ' [style=dashed, color=red]' : edge.type === "remote_state" ? ' [style=dotted]' : "";
    lines.push(`  "${edge.from}" -> "${edge.to}"${style};`);
  }
  lines.push("}");
  return lines.join("\n");
}

export interface VisualizationOptions {
  config?: NamespaceConfig;
  title?: string;
}

/**
 * Before view: Current state with problems highlighted.
 * - Grouped by namespace (same as After for comparison)
 * - Nodes show current repo in parentheses (= misplacement indicator)
 * - Problem edges: red=hardcoded ARN, blue dotted=remote_state
 */
export function toGraphvizBefore(graph: DependencyGraph, opts?: VisualizationOptions): string {
  const classifications = classifyGraph(graph.nodes, opts?.config);
  const lines: string[] = [];

  lines.push("digraph before {");
  lines.push("  rankdir=LR; compound=true; newrank=true;");
  lines.push(`  label=<<B>${opts?.title || "Before Migration"}</B>>; labelloc=t; fontsize=16; fontname="Helvetica";`);
  lines.push("  node [shape=box, style=\"filled,rounded\", fontname=\"Helvetica\", fontsize=9];");
  lines.push("  edge [fontname=\"Helvetica\", fontsize=8];");
  lines.push("");

  // Group by namespace
  const namespaces = new Map<string, GraphNode[]>();
  for (const [id, node] of graph.nodes) {
    const ns = classifications.get(id) || "service-unknown";
    if (!namespaces.has(ns)) namespaces.set(ns, []);
    namespaces.get(ns)!.push(node);
  }

  for (const [ns, nodes] of namespaces) {
    const clusterName = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  subgraph "cluster_${clusterName}" {`);
    lines.push(`    label="${ns}"; style="filled,rounded"; color="${nsColor(ns)}"; fillcolor="${nsFill(ns)}";`);
    lines.push("    fontname=\"Helvetica-Bold\"; fontsize=10;");
    for (const node of nodes) {
      // Show current repo to highlight misplacement
      lines.push(`    "${node.id}" [label="${shortLabel(node)}\\n(${node.repo})", fillcolor="white", color="${nsColor(ns)}"];`);
    }
    lines.push("  }");
    lines.push("");
  }

  // Edges — problems in red/blue, normal in gray
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    const crossRepo = fromNode && toNode && fromNode.repo !== toNode.repo;

    if (edge.type === "arn" && crossRepo) {
      lines.push(`  "${edge.from}" -> "${edge.to}" [color="#D32F2F", penwidth=2.5, label="hardcoded ARN", fontcolor="#D32F2F"];`);
    } else if (edge.type === "arn") {
      lines.push(`  "${edge.from}" -> "${edge.to}" [color="#FF5722", penwidth=1.5];`);
    } else if (edge.type === "remote_state") {
      lines.push(`  "${edge.from}" -> "${edge.to}" [style=dotted, color="#1565C0", penwidth=2, label="remote_state", fontcolor="#1565C0"];`);
    } else if (crossRepo) {
      lines.push(`  "${edge.from}" -> "${edge.to}" [style=dashed, color="#E65100"];`);
    } else {
      lines.push(`  "${edge.from}" -> "${edge.to}" [color="#BDBDBD", arrowsize=0.7];`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * After view: Target state after migration.
 * - Same namespace grouping as Before
 * - Nodes no longer show repo (they live in the right place now)
 * - All cross-namespace edges become green interfaces
 */
export function toGraphvizAfter(graph: DependencyGraph, opts?: VisualizationOptions): string {
  const classifications = classifyGraph(graph.nodes, opts?.config);
  const lines: string[] = [];

  lines.push("digraph after {");
  lines.push("  rankdir=LR; compound=true; newrank=true;");
  lines.push(`  label=<<B>${opts?.title || "After Migration"}</B>>; labelloc=t; fontsize=16; fontname="Helvetica";`);
  lines.push("  node [shape=box, style=\"filled,rounded\", fontname=\"Helvetica\", fontsize=9];");
  lines.push("  edge [fontname=\"Helvetica\", fontsize=8];");
  lines.push("");

  // Same namespace grouping
  const namespaces = new Map<string, GraphNode[]>();
  for (const [id, node] of graph.nodes) {
    const ns = classifications.get(id) || "service-unknown";
    if (!namespaces.has(ns)) namespaces.set(ns, []);
    namespaces.get(ns)!.push(node);
  }

  for (const [ns, nodes] of namespaces) {
    const clusterName = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  subgraph "cluster_${clusterName}" {`);
    lines.push(`    label="${ns}"; style="filled,rounded"; color="${nsColor(ns)}"; fillcolor="${nsFill(ns)}";`);
    lines.push("    fontname=\"Helvetica-Bold\"; fontsize=10;");
    for (const node of nodes) {
      lines.push(`    "${node.id}" [label="${shortLabel(node)}", fillcolor="white", color="${nsColor(ns)}"];`);
    }
    lines.push("  }");
    lines.push("");
  }

  // All cross-namespace edges become clean interfaces
  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from);
    const toNs = classifications.get(edge.to);

    if (fromNs !== toNs) {
      lines.push(`  "${edge.from}" -> "${edge.to}" [style=dashed, color="#2E7D32", label="var/output", fontcolor="#2E7D32"];`);
    } else {
      lines.push(`  "${edge.from}" -> "${edge.to}" [color="#BDBDBD", arrowsize=0.7];`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}
