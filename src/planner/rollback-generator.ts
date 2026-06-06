import type { MigrateResult, FileWrite, ImportBlock, RemovedBlock } from "../types.js";
import { getOrCreate } from "../utils/map-utils.js";

export interface RollbackPlan {
  description: string;
  steps: string[];
  fileWrites: FileWrite[];
  tfmigrateHcl: string;
}

/**
 * Generate a rollback plan that reverses a migration.
 * The rollback uses the same mechanism (import/removed blocks) in reverse.
 */
export function generateRollbackPlan(result: MigrateResult): RollbackPlan {
  const steps: string[] = [];
  const fileWrites: FileWrite[] = [];

  // Reverse import blocks: what was imported into target should be removed from target
  const reverseRemovedBlocks: RemovedBlock[] = result.importBlocks.map((imp) => ({
    from: imp.to,
    repo: imp.repo,
    destroy: false,
  }));

  // Reverse removed blocks: what was removed from source should be imported back
  const reverseImportBlocks: ImportBlock[] = result.removedBlocks.map((rem) => ({
    to: rem.from,
    id: "<RESOURCE_ID>",
    repo: rem.repo,
  }));

  // Generate rollback import.tf for source repos
  const importsByRepo = new Map<string, ImportBlock[]>();
  for (const imp of reverseImportBlocks) {
    getOrCreate(importsByRepo, imp.repo, () => []).push(imp);
  }

  for (const [repo, imports] of importsByRepo) {
    const content = imports.map((imp) =>
      `import {\n  to = ${imp.to}\n  id = "${imp.id}"\n}\n`
    ).join("\n");
    steps.push(`Add import blocks to ${repo} to re-import resources`);
    fileWrites.push({
      filePath: `${repo}/rollback-imports.tf`,
      content: `# Rollback: re-import resources that were removed\n\n${content}`,
      operation: "create",
    });
  }

  // Generate rollback removed.tf for target repos
  const removedByRepo = new Map<string, RemovedBlock[]>();
  for (const rem of reverseRemovedBlocks) {
    getOrCreate(removedByRepo, rem.repo, () => []).push(rem);
  }

  for (const [repo, removals] of removedByRepo) {
    const content = removals.map((rem) =>
      `removed {\n  from = ${rem.from}\n\n  lifecycle {\n    destroy = false\n  }\n}\n`
    ).join("\n");
    steps.push(`Add removed blocks to ${repo} to drop resources without destroying`);
    fileWrites.push({
      filePath: `${repo}/rollback-removed.tf`,
      content: `# Rollback: release resources from this state (no destroy)\n\n${content}`,
      operation: "create",
    });
  }

  // Generate tfmigrate HCL for rollback (reverse direction)
  const tfmigrateLines = ["migration \"multi_state\" {"];
  for (const move of result.moves) {
    // Reverse: target → source
    tfmigrateLines.push(`  state_mv "${move.targetRepo}" "${move.sourceRepo}" "${move.block.resourceType}.${move.block.name}"`);
  }
  tfmigrateLines.push("}");
  const tfmigrateHcl = tfmigrateLines.length > 2 ? tfmigrateLines.join("\n") : "";

  steps.push("Run terraform apply in both repos to execute rollback");
  steps.push("Run terraform plan in both repos to verify: expect no changes");

  return {
    description: `Rollback plan: reverses ${result.summary.resourcesMoved} resource moves, ${result.importBlocks.length} imports`,
    steps,
    fileWrites,
    tfmigrateHcl,
  };
}
