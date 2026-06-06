import { join } from "node:path";
import type { CutEdge, DependencyGraph, FileWrite, MovedBlock, ImportBlock, RemovedBlock, GraphNode } from "../types.js";
import type { StateFile } from "../state/state-reader.js";
import { buildResourceIdMap } from "./migration-planner.js";
import { getOrCreate } from "../utils/map-utils.js";

/**
 * Mode determines which Terraform refactoring mechanism to use:
 * - "moved": TF 1.5+ moved blocks (same-state renames only)
 * - "import": TF 1.7+ import blocks in target + removed blocks in source (cross-state)
 * - "tfmigrate": No TF blocks generated, rely on migrate.hcl for state operations
 */
export type RefactorMode = "moved" | "import" | "tfmigrate";

export interface MovedBlockInput {
  graph: DependencyGraph;
  cutEdges: CutEdge[];
  basePaths: Map<string, string>;
  stateFiles?: StateFile[];
  mode: RefactorMode;
}

export interface MovedBlockResult {
  movedBlocks: MovedBlock[];
  importBlocks: ImportBlock[];
  removedBlocks: RemovedBlock[];
  fileWrites: FileWrite[];
}

/**
 * Generate a TF 1.5+ moved block (same-state address rename).
 */
export function generateMovedBlockHcl(opts: { from: string; to: string }): string {
  return `moved {
  from = ${opts.from}
  to   = ${opts.to}
}\n`;
}

/**
 * Generate a TF 1.7+ import block (bring existing resource into new state).
 */
export function generateImportBlockHcl(opts: { to: string; id: string; provider?: string }): string {
  const providerLine = opts.provider ? `\n  provider = ${opts.provider}` : "";
  return `import {
  to = ${opts.to}
  id = "${opts.id}"${providerLine}
}\n`;
}

/**
 * Generate a TF 1.7+ removed block (remove resource from source state without destroying).
 */
export function generateRemovedBlockHcl(opts: { from: string; destroy?: boolean }): string {
  const destroy = opts.destroy ?? false;
  return `removed {
  from = ${opts.from}

  lifecycle {
    destroy = ${destroy}
  }
}\n`;
}

/**
 * Resolve all state addresses for a given node (handles count/for_each).
 * Returns an array of { address, id } for each instance found in state.
 * Falls back to a single entry with base address and placeholder if no state match.
 */
function resolveNodeAddresses(
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
 * Plan generation of refactoring blocks based on mode.
 *
 * - "moved": generates moved.tf in target (only works for same-state)
 * - "import": generates imports.tf in target + removed.tf in source (cross-state, TF 1.7+)
 * - "tfmigrate": no blocks generated (rely on migrate.hcl)
 */
export function planMovedBlocks(input: MovedBlockInput): MovedBlockResult {
  const { graph, cutEdges, basePaths, stateFiles, mode } = input;
  const movedBlocks: MovedBlock[] = [];
  const importBlocks: ImportBlock[] = [];
  const removedBlocks: RemovedBlock[] = [];
  const fileWrites: FileWrite[] = [];

  if (mode === "tfmigrate") {
    return { movedBlocks, importBlocks, removedBlocks, fileWrites };
  }

  const resourceIdMap = stateFiles ? buildResourceIdMap(stateFiles) : new Map<string, string>();

  // Collect unique resources to move (dedup by node ID)
  const seen = new Set<string>();
  const importsByTargetRepo = new Map<string, string[]>();
  const removedBySourceRepo = new Map<string, string[]>();
  const movedByTargetRepo = new Map<string, string[]>();

  // Primary: find misplaced resources (namespace != repo)
  for (const [nodeId, node] of graph.nodes) {
    if (!node.namespace) continue;
    const expectedRepo = node.namespace;
    if (node.repo !== expectedRepo && basePaths.has(expectedRepo)) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);

      const sourceRepo = node.repo;
      const targetRepo = node.namespace;

      if (mode === "moved") {
        const address = `${node.resourceType}.${node.name}`;
        const moved: MovedBlock = { from: address, to: address, repo: targetRepo };
        movedBlocks.push(moved);
        getOrCreate(movedByTargetRepo, targetRepo, () => []).push(generateMovedBlockHcl({ from: address, to: address }));
      } else if (mode === "import") {
        // Resolve all indexed addresses for count/for_each resources
        const addresses = resolveNodeAddresses(node, resourceIdMap);
        for (const { address, id } of addresses) {
          const importBlock: ImportBlock = { to: address, id, repo: targetRepo };
          importBlocks.push(importBlock);
          getOrCreate(importsByTargetRepo, targetRepo, () => []).push(generateImportBlockHcl({ to: address, id }));

          const removed: RemovedBlock = { from: address, repo: sourceRepo, destroy: false };
          removedBlocks.push(removed);
          getOrCreate(removedBySourceRepo, sourceRepo, () => []).push(generateRemovedBlockHcl({ from: address, destroy: false }));
        }
      }
    }
  }

  // Secondary: cross-repo cut edges

  for (const cut of cutEdges) {
    const fromNode = graph.nodes.get(cut.edge.from);
    const toNode = graph.nodes.get(cut.edge.to);
    if (!toNode) continue;

    // Skip same-repo edges — no physical state move needed
    if (fromNode && toNode && fromNode.repo === toNode.repo) continue;

    if (seen.has(cut.edge.to)) continue;

    const sourceRepo = toNode.repo;
    const targetRepo = cut.fromNamespace;

    // Skip if resource is already in the target namespace's repo
    if (sourceRepo === targetRepo) continue;
    // Skip if target repo doesn't exist in basePaths
    if (!basePaths.has(targetRepo)) continue;

    seen.add(cut.edge.to);
  

    if (mode === "moved") {
      // moved block: same-state rename (put in target repo)
      const address = `${toNode.resourceType}.${toNode.name}`;
      const moved: MovedBlock = { from: address, to: address, repo: targetRepo };
      movedBlocks.push(moved);

      getOrCreate(movedByTargetRepo, targetRepo, () => []).push(generateMovedBlockHcl({ from: address, to: address }));
    } else if (mode === "import") {
      // import block: bring resource into target state — expand indexed addresses
      const addresses = resolveNodeAddresses(toNode, resourceIdMap);
      for (const { address, id } of addresses) {
        const importBlock: ImportBlock = { to: address, id, repo: targetRepo };
        importBlocks.push(importBlock);

        getOrCreate(importsByTargetRepo, targetRepo, () => []).push(generateImportBlockHcl({ to: address, id }));

        // removed block: remove from source state without destroying
        const removed: RemovedBlock = { from: address, repo: sourceRepo, destroy: false };
        removedBlocks.push(removed);

        getOrCreate(removedBySourceRepo, sourceRepo, () => []).push(generateRemovedBlockHcl({ from: address, destroy: false }));
      }
    }
  }

  // Generate file writes for "moved" mode
  for (const [repo, blocks] of movedByTargetRepo) {
    const basePath = basePaths.get(repo);
    if (!basePath) continue;

    fileWrites.push({
      filePath: join(basePath, "moved.tf"),
      content: `# Moved blocks generated by terraform-state-mover (TF 1.5+)\n# NOTE: moved blocks only work for same-state renames.\n# For cross-state migration, use --mode import (requires TF 1.7+)\n\n${blocks.join("\n")}`,
      operation: "create",
    });
  }

  // Generate file writes for "import" mode
  for (const [repo, blocks] of importsByTargetRepo) {
    const basePath = basePaths.get(repo);
    if (!basePath) continue;

    fileWrites.push({
      filePath: join(basePath, "imports.tf"),
      content: `# Import blocks generated by terraform-state-mover (TF 1.7+)\n# Run: terraform apply (imports resource into this state)\n# After successful apply, remove this file.\n\n${blocks.join("\n")}`,
      operation: "create",
    });
  }

  for (const [repo, blocks] of removedBySourceRepo) {
    const basePath = basePaths.get(repo);
    if (!basePath) continue;

    fileWrites.push({
      filePath: join(basePath, "removed.tf"),
      content: `# Removed blocks generated by terraform-state-mover (TF 1.7+)\n# Run: terraform apply (removes resource from this state WITHOUT destroying)\n# After successful apply, remove this file.\n\n${blocks.join("\n")}`,
      operation: "create",
    });
  }

  return { movedBlocks, importBlocks, removedBlocks, fileWrites };
}
