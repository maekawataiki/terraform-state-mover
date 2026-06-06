import type { DependencyGraph, CutEdge, MigrationStep, MigrationPlan, NamespaceConfig, GraphNode } from "../types.js";
import type { StateFile } from "../state/state-reader.js";
import { findCrossNamespaceEdges } from "./cut-finder.js";
import { getOrCreate } from "../utils/map-utils.js";

export interface MigrationPlanOptions {
  config?: NamespaceConfig;
  stateFiles?: StateFile[];
}

/**
 * Topological sort of nodes that need to be moved.
 * Returns nodes in dependency order: move leaves first (nodes with no outgoing edges to other moved nodes).
 */
export function topologicalSort(graph: DependencyGraph, nodeIds: string[]): string[] {
  const moveSet = new Set(nodeIds);

  // Build adjacency list restricted to moved nodes
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of moveSet) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }

  for (const edge of graph.edges) {
    // Only count edges between moved nodes
    if (moveSet.has(edge.from) && moveSet.has(edge.to)) {
      getOrCreate(adj, edge.from, () => []).push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // If cycle detected, append remaining (shouldn't happen with DAG)
  for (const id of moveSet) {
    if (!sorted.includes(id)) sorted.push(id);
  }

  // Reverse: Kahn's outputs dependents first (nodes no one depends on).
  // For migration, we need dependencies first (the resources being referenced).
  // Edge semantics: from→to means "from depends on to", so to has incoming edges.
  // After Kahn's, zero-indegree nodes (dependents) come first. Reversing gives dependencies first.
  return sorted.reverse();
}

/**
 * Build a map from resource address to its ID/ARN from state files.
 * Key format: "repo:resource_type.resource_name"
 * For indexed resources (count/for_each), also includes keys like "repo:type.name[0]" or "repo:type.name[\"key\"]"
 */
export function buildResourceIdMap(stateFiles: StateFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sf of stateFiles) {
    for (const r of sf.resources) {
      const key = `${sf.repo}:${r.address}`;
      // Prefer resource ID (attributes.id) — this is the terraform import identifier.
      // ARN is NOT a valid import ID for many resources (e.g., IAM Role uses role name, not ARN).
      const id = (r.attributes.id as string | undefined) || r.arn;
      if (id) {
        map.set(key, id);
      }
    }
  }
  return map;
}

/**
 * Resolve all state addresses for a given resource (handles count/for_each).
 * Returns an array of { address, id } for each instance found in state.
 * Falls back to a single entry with base address and placeholder if no state match.
 */
function resolveResourceAddresses(
  node: GraphNode,
  resourceIdMap: Map<string, string>,
): Array<{ address: string; id: string }> {
  const baseAddress = `${node.resourceType}.${node.name}`;
  const prefix = `${node.repo}:${baseAddress}`;

  // Collect all indexed entries for this resource
  const indexed: Array<{ address: string; id: string }> = [];
  for (const [key, id] of resourceIdMap) {
    if (key === prefix || key.startsWith(`${prefix}[`)) {
      const address = key.slice(node.repo.length + 1); // strip "repo:"
      indexed.push({ address, id });
    }
  }

  if (indexed.length > 0) {
    return indexed;
  }

  // Fallback: no state data available
  return [{ address: baseAddress, id: "<RESOURCE_ID>" }];
}

/**
 * Resolve the resource ID for a terraform import command.
 * Falls back to <RESOURCE_ID> placeholder if state is not available.
 */
function _resolveResourceId(node: GraphNode, resourceIdMap: Map<string, string>): string {
  const key = `${node.repo}:${node.resourceType}.${node.name}`;
  return resourceIdMap.get(key) || "<RESOURCE_ID>";
}

export function generateMigrationSteps(
  graph: DependencyGraph,
  cutEdges: CutEdge[],
  opts?: { stateFiles?: StateFile[] },
): MigrationStep[] {
  const steps: MigrationStep[] = [];
  const resourceIdMap = opts?.stateFiles ? buildResourceIdMap(opts.stateFiles) : new Map<string, string>();

  // Collect unique resources that need to be moved
  // The "from" node of each cut edge is what gets moved to toNamespace
  const movedResources = new Map<string, { node: GraphNode; targetNamespace: string }>();
  for (const cut of cutEdges) {
    const fromNode = graph.nodes.get(cut.edge.from);
    if (!fromNode) continue;
    // Dedup: same resource only moved once
    if (!movedResources.has(cut.edge.from)) {
      movedResources.set(cut.edge.from, { node: fromNode, targetNamespace: cut.toNamespace });
    }
  }

  // Topological sort for correct ordering
  const sortedIds = topologicalSort(graph, [...movedResources.keys()]);

  // Generate state_mv steps in dependency order
  for (const id of sortedIds) {
    const entry = movedResources.get(id);
    if (!entry) continue;
    const { node, targetNamespace } = entry;

    // Resolve all indexed addresses (count/for_each expand to multiple instances)
    const addresses = resolveResourceAddresses(node, resourceIdMap);
    for (const { address } of addresses) {
      const escapedState = shellEscape(`${node.repo}/terraform.tfstate`);
      const escapedStateOut = shellEscape(`${targetNamespace}/terraform.tfstate`);
      const escapedAddress = shellEscape(address);
      steps.push({
        type: "state_mv",
        command: `terraform state mv -state=${escapedState} -state-out=${escapedStateOut} ${escapedAddress} ${escapedAddress}`,
        description: `Move ${address} from ${node.repo} to ${targetNamespace}`,
        resource: address,
        targetRepo: targetNamespace,
      });
    }
  }

  // Generate import steps for target resources (the "to" side of cut edges)
  const importedResources = new Set<string>();
  for (const cut of cutEdges) {
    const toNode = graph.nodes.get(cut.edge.to);
    if (!toNode) continue;
    // Dedup imports
    if (importedResources.has(cut.edge.to)) continue;
    importedResources.add(cut.edge.to);

    // Resolve all indexed addresses (count/for_each expand to multiple instances)
    const addresses = resolveResourceAddresses(toNode, resourceIdMap);
    for (const { address, id } of addresses) {
      steps.push({
        type: "import",
        command: `terraform import ${shellEscape(address)} ${shellEscape(id)}`,
        description: `Import ${address} into ${cut.toNamespace} state`,
        resource: address,
        targetRepo: cut.toNamespace,
      });
    }
  }

  // Code rewrite steps for ARN edges
  const rewrittenArns = new Set<string>();
  for (const cut of cutEdges) {
    if (cut.edge.type === "arn" && cut.edge.label && !rewrittenArns.has(cut.edge.label)) {
      rewrittenArns.add(cut.edge.label);
      const fromNode = graph.nodes.get(cut.edge.from);
      steps.push({
        type: "code_rewrite",
        description: `Replace hardcoded ARN "${cut.edge.label}" with data source or variable reference`,
        resource: fromNode ? `${fromNode.resourceType}.${fromNode.name}` : undefined,
      });
    }
  }

  // Verification step
  steps.push({
    type: "verify",
    command: "terraform plan",
    description: "Verify no infrastructure changes after migration (expect no changes)",
  });

  return steps;
}

/**
 * Escape a string for safe inclusion in a single-quoted shell argument.
 * Single quotes are handled by ending the quote, inserting an escaped single quote, and reopening.
 */
export function shellEscape(value: string): string {
  // Replace ' with '\'' (end quote, escaped literal quote, reopen quote)
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function generateShellScript(steps: MigrationStep[]): string {
  const lines = [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "# Terraform State Migration Script",
    "# Generated by terraform-state-mover",
    "",
  ];

  for (const step of steps) {
    lines.push(`# ${step.description}`);
    if (step.command) {
      lines.push(step.command);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function generateTfmigrateHcl(graph: DependencyGraph, cutEdges: CutEdge[]): string {
  // Group moves by from_dir/to_dir pair
  const groups = new Map<string, { fromDir: string; toDir: string; actions: string[] }>();

  for (const cut of cutEdges) {
    const fromNode = graph.nodes.get(cut.edge.from);
    if (!fromNode) continue;

    const fromDir = fromNode.repo;
    const toDir = cut.toNamespace;
    const key = `${fromDir}|${toDir}`;

    const action = `mv ${fromNode.resourceType}.${fromNode.name} ${fromNode.resourceType}.${fromNode.name}`;
    const group = getOrCreate(groups, key, () => ({ fromDir, toDir, actions: [] as string[] }));
    if (!group.actions.includes(action)) {
      group.actions.push(action);
    }
  }

  const blocks: string[] = [];
  for (const [, group] of groups) {
    const migrationName = `move_to_${group.toDir.replace(/-/g, "_")}`;
    const actionsStr = group.actions.map((a) => `    "${a}",`).join("\n");
    blocks.push(`migration "multi_state" "${migrationName}" {
  from_dir = "${group.fromDir}"
  to_dir   = "${group.toDir}"
  actions = [
${actionsStr}
  ]
}`);
  }

  return blocks.join("\n\n") + "\n";
}

export function createMigrationPlan(graph: DependencyGraph, config?: NamespaceConfig, stateFiles?: StateFile[]): MigrationPlan {
  const crossNamespaceEdges = findCrossNamespaceEdges(graph, config);
  const steps = generateMigrationSteps(graph, crossNamespaceEdges, { stateFiles });
  const shellScript = generateShellScript(steps);
  const json = JSON.stringify({ steps, crossNamespaceEdges }, null, 2);
  const tfmigrateHcl = generateTfmigrateHcl(graph, crossNamespaceEdges);

  return { steps, crossNamespaceEdges, shellScript, json, tfmigrateHcl };
}
