import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DependencyGraph, CutEdge, ArnReference, MigrateResult, MigrationStepError, FileWrite } from "../types.js";
import type { StateFile } from "../state/state-reader.js";
import { planBlockMoves } from "./hcl-block-mover.js";
import { planArnRewrites } from "./arn-rewriter.js";
import { planOutputGeneration } from "./output-generator.js";
import { planMovedBlocks } from "./moved-block-generator.js";
import type { RefactorMode } from "./moved-block-generator.js";
import { generateTfmigrateHcl } from "./migration-planner.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";

export interface MigrateInput {
  graph: DependencyGraph;
  cutEdges: CutEdge[];
  arnRefs: ArnReference[];
  basePaths: Map<string, string>;
  stateFiles?: StateFile[];
  movedBlockMode?: RefactorMode;
  dryRun?: boolean;
}

/**
 * Orchestrate the full code migration: move blocks, rewrite ARNs, generate outputs, create moved/import blocks.
 * If any step fails, partial results from successful steps are still returned.
 */
export async function planMigration(input: MigrateInput): Promise<MigrateResult> {
  const { graph, cutEdges, arnRefs, basePaths, stateFiles, movedBlockMode = "import" } = input;
  const errors: MigrationStepError[] = [];

  // Step 1: Plan block moves
  let blockMoveResult: Awaited<ReturnType<typeof planBlockMoves>> | null = null;
  try {
    blockMoveResult = await planBlockMoves({ graph, cutEdges, basePaths });
    // Surface individual move failures as errors
    if (blockMoveResult.failedMoves.length > 0) {
      for (const failure of blockMoveResult.failedMoves) {
        errors.push({
          step: "block-moves",
          error: `${failure.resourceType}.${failure.name} (${failure.sourceRepo} → ${failure.targetRepo}): ${failure.reason}`,
        });
      }
    }
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: "block-moves", error: msg });
    logger.error(`⚠ Step 1 (block moves) failed: ${msg}`);
  }

  // Step 2: Plan ARN rewrites
  let arnRewriteResult: Awaited<ReturnType<typeof planArnRewrites>> | null = null;
  try {
    arnRewriteResult = await planArnRewrites({ graph, cutEdges, arnRefs, basePaths });
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: "arn-rewrites", error: msg });
    logger.error(`⚠ Step 2 (ARN rewrites) failed: ${msg}`);
  }

  // Step 3: Plan output generation
  let outputResult: Awaited<ReturnType<typeof planOutputGeneration>> | null = null;
  try {
    outputResult = await planOutputGeneration({ graph, cutEdges, basePaths });
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: "output-generation", error: msg });
    logger.error(`⚠ Step 3 (output generation) failed: ${msg}`);
  }

  // Step 4: Plan moved/import blocks
  let movedResult: ReturnType<typeof planMovedBlocks> | null = null;
  try {
    movedResult = planMovedBlocks({ graph, cutEdges, basePaths, stateFiles, mode: movedBlockMode });
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: "moved-blocks", error: msg });
    logger.error(`⚠ Step 4 (moved/import blocks) failed: ${msg}`);
  }

  // Step 5: Generate tfmigrate HCL
  let tfmigrateHcl = "";
  try {
    tfmigrateHcl = generateTfmigrateHcl(graph, cutEdges);
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: "tfmigrate-hcl", error: msg });
    logger.error(`⚠ Step 5 (tfmigrate HCL) failed: ${msg}`);
  }

  // Combine all file writes from successful steps (dedup by path, last write wins)
  const allWrites = new Map<string, FileWrite>();
  const allFileWrites = [
    ...(blockMoveResult?.fileWrites || []),
    ...(arnRewriteResult?.fileWrites || []),
    ...(outputResult?.fileWrites || []),
    ...(movedResult?.fileWrites || []),
  ];
  for (const fw of allFileWrites) {
    const existing = allWrites.get(fw.filePath);
    if (existing && existing.content !== fw.content) {
      logger.warn(
        `⚠ Multiple migration steps write to ${fw.filePath} with different content — ` +
        `keeping the later write. Review the diff for this file carefully.`,
      );
    }
    allWrites.set(fw.filePath, fw);
  }

  const fileWrites = [...allWrites.values()];

  return {
    moves: blockMoveResult?.moves || [],
    variableDeclarations: arnRewriteResult?.variableDeclarations || [],
    outputDeclarations: outputResult?.outputDeclarations || [],
    movedBlocks: movedResult?.movedBlocks || [],
    importBlocks: movedResult?.importBlocks || [],
    removedBlocks: movedResult?.removedBlocks || [],
    fileWrites,
    tfmigrateHcl,
    errors: errors.length > 0 ? errors : undefined,
    summary: {
      resourcesMoved: blockMoveResult?.moves.length || 0,
      arnsRewritten: arnRewriteResult?.arnsRewritten || 0,
      outputsGenerated: outputResult?.outputDeclarations.length || 0,
      filesModified: fileWrites.length,
    },
  };
}

/**
 * Apply planned file writes to disk.
 *
 * Best-effort atomic: original contents of every touched file are captured
 * before any write. If a write fails mid-way, all already-applied writes are
 * rolled back so the working tree is not left half-migrated.
 */
export async function applyMigration(result: MigrateResult): Promise<void> {
  // Snapshot originals of all files we are about to touch
  const originals = new Map<string, string | null>(); // null = did not exist
  for (const fw of result.fileWrites) {
    try {
      originals.set(fw.filePath, await readFile(fw.filePath, "utf-8"));
    } catch {
      originals.set(fw.filePath, null);
    }
  }

  const applied: string[] = [];
  try {
    for (const fw of result.fileWrites) {
      if (fw.operation === "delete") {
        await rm(fw.filePath, { force: true });
      } else {
        await mkdir(dirname(fw.filePath), { recursive: true });
        await writeFile(fw.filePath, fw.content, "utf-8");
      }
      applied.push(fw.filePath);
    }
  } catch (error: unknown) {
    logger.error(`✗ Migration write failed at ${applied.length + 1}/${result.fileWrites.length} — rolling back ${applied.length} applied write(s)`);
    for (const filePath of applied.reverse()) {
      const original = originals.get(filePath);
      try {
        if (original === null) {
          await rm(filePath, { force: true });
        } else if (original !== undefined) {
          await writeFile(filePath, original, "utf-8");
        }
      } catch (restoreError: unknown) {
        logger.error(`✗ Could not restore ${filePath}: ${formatError(restoreError)}`);
      }
    }
    throw error;
  }
}
