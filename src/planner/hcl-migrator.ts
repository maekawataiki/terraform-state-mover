import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DependencyGraph, CutEdge, ArnReference, MigrateResult, MigrationStepError, FileWrite, VariableDeclaration } from "../types.js";
import type { StateFile } from "../state/state-reader.js";
import { planBlockMoves, blockToHcl } from "./hcl-block-mover.js";
import type { BlockMoveResult } from "./hcl-block-mover.js";
import { planArnRewrites } from "./arn-rewriter.js";
import { planOutputGeneration } from "./output-generator.js";
import { planMovedBlocks } from "./moved-block-generator.js";
import type { RefactorMode } from "./moved-block-generator.js";
import { generateTfmigrateHcl } from "./migration-planner.js";
import { detectMissingBoundaries, logBoundaryWarnings, injectBoundary } from "./boundary-injector.js";
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
  /** Opt-in: inject permissions_boundary into IAM roles (produces plan diff). */
  injectBoundaryArn?: string;
}

/**
 * Orchestrate the full code migration: move blocks, rewrite ARNs, generate outputs, create moved/import blocks.
 * If any step fails, partial results from successful steps are still returned.
 *
 * Pipeline architecture: each step receives a shared context and contributes
 * file writes + metadata. Steps are independent — a failure in one does not
 * block others.
 */
export async function planMigration(input: MigrateInput): Promise<MigrateResult> {
  const { graph, cutEdges, arnRefs, basePaths, stateFiles, movedBlockMode = "import", injectBoundaryArn } = input;
  const errors: MigrationStepError[] = [];

  // --- Step 1: Block moves ---
  const blockMoveResult = await runStep("block-moves", errors, () =>
    planBlockMoves({ graph, cutEdges, basePaths }),
  );

  // Surface individual block-move failures (e.g. file not found, block not located)
  if (blockMoveResult) {
    collectBlockMoveFailures(blockMoveResult, "block-moves", errors);
  }

  // --- Step 1b: Boundary injection (post-processing on block moves) ---
  let boundaryVariableDeclarations: VariableDeclaration[] = [];
  let boundaryFileWrites: FileWrite[] = [];
  if (blockMoveResult && blockMoveResult.moves.length > 0) {
    const boundaryWarnings = detectMissingBoundaries(blockMoveResult.moves);
    if (injectBoundaryArn) {
      const injectionResult = injectBoundary({
        moves: blockMoveResult.moves,
        boundaryArn: injectBoundaryArn,
      });
      if (injectionResult.rolesInjected > 0) {
        logger.log(`  ✓ Injected permissions_boundary into ${injectionResult.rolesInjected} IAM role(s)`);
        rebuildTargetFileWrites(blockMoveResult);

        // Resolve file paths for boundary variable declarations and file writes
        for (let i = 0; i < injectionResult.variableDeclarations.length; i++) {
          const decl = injectionResult.variableDeclarations[i];
          const basePath = basePaths.get(decl.repo);
          if (basePath) {
            const filePath = join(basePath, "boundary-variables.tf");
            injectionResult.variableDeclarations[i] = { ...decl, filePath };
            injectionResult.fileWrites[i] = { ...injectionResult.fileWrites[i], filePath };
          }
        }

        boundaryVariableDeclarations = injectionResult.variableDeclarations;
        boundaryFileWrites = injectionResult.fileWrites;
      }
    } else {
      logBoundaryWarnings(boundaryWarnings);
    }
  }

  // --- Step 2: ARN rewrites ---
  const arnRewriteResult = await runStep("arn-rewrites", errors, () =>
    planArnRewrites({ graph, cutEdges, arnRefs, basePaths }),
  );

  // --- Step 3: Output generation ---
  const outputResult = await runStep("output-generation", errors, () =>
    planOutputGeneration({ graph, cutEdges, basePaths }),
  );

  // --- Step 4: Moved/import blocks ---
  const movedResult = runStepSync("moved-blocks", errors, () =>
    planMovedBlocks({ graph, cutEdges, basePaths, stateFiles, mode: movedBlockMode }),
  );

  // --- Step 5: tfmigrate HCL ---
  const tfmigrateHcl = runStepSync("tfmigrate-hcl", errors, () =>
    generateTfmigrateHcl(graph, cutEdges),
  ) ?? "";

  // --- Combine file writes (dedup by path, last write wins) ---
  const fileWrites = mergeFileWrites([
    blockMoveResult?.fileWrites,
    arnRewriteResult?.fileWrites,
    outputResult?.fileWrites,
    movedResult?.fileWrites,
    boundaryFileWrites,
  ]);

  return {
    moves: blockMoveResult?.moves || [],
    variableDeclarations: [
      ...(arnRewriteResult?.variableDeclarations || []),
      ...boundaryVariableDeclarations,
    ],
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

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/** Run an async step, capturing errors without throwing. */
async function runStep<T>(
  stepName: string,
  errors: MigrationStepError[],
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: stepName, error: msg });
    logger.error(`⚠ Step (${stepName}) failed: ${msg}`);
    return null;
  }
}

/** Surface individual block-move failures into the error list. */
function collectBlockMoveFailures(result: BlockMoveResult, stepName: string, errors: MigrationStepError[]): void {
  for (const failure of result.failedMoves) {
    errors.push({
      step: stepName,
      error: `${failure.resourceType}.${failure.name} (${failure.sourceRepo} → ${failure.targetRepo}): ${failure.reason}`,
    });
  }
}

/** Run a sync step, capturing errors without throwing. */
function runStepSync<T>(
  stepName: string,
  errors: MigrationStepError[],
  fn: () => T,
): T | null {
  try {
    return fn();
  } catch (error: unknown) {
    const msg = formatError(error);
    errors.push({ step: stepName, error: msg });
    logger.error(`⚠ Step (${stepName}) failed: ${msg}`);
    return null;
  }
}

/** Merge file writes from multiple steps (dedup by path, last write wins). */
function mergeFileWrites(writeSets: (FileWrite[] | undefined)[]): FileWrite[] {
  const allWrites = new Map<string, FileWrite>();
  for (const writes of writeSets) {
    if (!writes) continue;
    for (const fw of writes) {
      const existing = allWrites.get(fw.filePath);
      if (existing && existing.content !== fw.content) {
        logger.warn(
          `⚠ Multiple migration steps write to ${fw.filePath} with different content — ` +
          `keeping the later write. Review the diff for this file carefully.`,
        );
      }
      allWrites.set(fw.filePath, fw);
    }
  }
  return [...allWrites.values()];
}

/**
 * Rebuild target file writes from mutated move blocks.
 * Called after boundary injection to reflect updated block bodies in the output.
 */
function rebuildTargetFileWrites(blockMoveResult: BlockMoveResult): void {
  // Group moves by target file
  const targetBlocks = new Map<string, string[]>();
  for (const move of blockMoveResult.moves) {
    const blocks = targetBlocks.get(move.targetFilePath) || [];
    blocks.push(blockToHcl(move.block));
    targetBlocks.set(move.targetFilePath, blocks);
  }

  // Replace the content of target file writes (operation: "create")
  for (const fw of blockMoveResult.fileWrites) {
    if (fw.operation === "create" && targetBlocks.has(fw.filePath)) {
      const blocks = targetBlocks.get(fw.filePath)!;
      fw.content = `# Resources moved by terraform-state-mover\n\n${blocks.join("\n")}`;
    }
  }
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
