import type { DependencyGraph, GraphNode, NamespaceConfig } from "../types.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";
import { getOrCreate } from "../utils/map-utils.js";

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
    getOrCreate(namespaces, ns, () => []).push(node);
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
    getOrCreate(namespaces, ns, () => []).push(node);
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
