import type {
  DependencyGraph,
  ArnReference,
  Namespace,
} from "../types.js";
import { getOrCreate } from "../utils/map-utils.js";

export function toMermaidSummaryBefore(
  graph: DependencyGraph,
  classifications: Map<string, Namespace>,
  _arnRefs: ArnReference[],
): string {
  const lines: string[] = ["```mermaid", "graph LR"];

  // Count resources per namespace
  const nsCounts = new Map<string, number>();
  for (const ns of classifications.values()) {
    nsCounts.set(ns, (nsCounts.get(ns) || 0) + 1);
  }

  // Count cross-namespace edges by type
  const nsEdges = new Map<string, { arn: number; remoteState: number; ref: number }>();
  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from) || "unknown";
    const toNs = classifications.get(edge.to) || "unknown";
    if (fromNs !== toNs) {
      const key = `${fromNs}|||${toNs}`;
      const counts = getOrCreate(nsEdges, key, () => ({ arn: 0, remoteState: 0, ref: 0 }));
      if (edge.type === "arn") counts.arn++;
      else if (edge.type === "remote_state") counts.remoteState++;
      else counts.ref++;
    }
  }

  // Nodes = namespaces with resource count
  for (const [ns, count] of [...nsCounts.entries()].sort()) {
    const id = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${id}["${ns}<br/>${count} resources"]`);
  }

  // Edges with problem counts
  for (const [key, counts] of nsEdges) {
    const [fromNs, toNs] = key.split("|||");
    const fromId = fromNs.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = toNs.replace(/[^a-zA-Z0-9]/g, "_");
    if (counts.arn > 0) {
      lines.push(`  ${fromId} -. "⚠ ${counts.arn} hardcoded ARN" .-> ${toId}`);
    }
    if (counts.remoteState > 0) {
      lines.push(`  ${fromId} -. "${counts.remoteState} remote_state" .-> ${toId}`);
    }
    if (counts.ref > 0) {
      lines.push(`  ${fromId} --> |"${counts.ref} refs"| ${toId}`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}

export function toMermaidSummaryAfter(
  graph: DependencyGraph,
  classifications: Map<string, Namespace>,
): string {
  const lines: string[] = ["```mermaid", "graph LR"];

  const nsCounts = new Map<string, number>();
  for (const ns of classifications.values()) {
    nsCounts.set(ns, (nsCounts.get(ns) || 0) + 1);
  }

  // Count cross-namespace interfaces
  const nsInterfaces = new Map<string, number>();
  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from) || "unknown";
    const toNs = classifications.get(edge.to) || "unknown";
    if (fromNs !== toNs) {
      const key = `${fromNs}|||${toNs}`;
      nsInterfaces.set(key, (nsInterfaces.get(key) || 0) + 1);
    }
  }

  for (const [ns, count] of [...nsCounts.entries()].sort()) {
    const id = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${id}["${ns}<br/>${count} resources"]`);
  }

  for (const [key, count] of nsInterfaces) {
    const [fromNs, toNs] = key.split("|||");
    const fromId = fromNs.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = toNs.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${fromId} --> |"${count} var/output"| ${toId}`);
  }

  lines.push("```");
  return lines.join("\n");
}
