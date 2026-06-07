import type { Command } from "commander";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve, basename, relative, dirname } from "node:path";
import { scanDirectory } from "../parser/hcl-parser.js";
import { buildGraph } from "../analyzer/dependency-graph.js";
import { detectArns } from "../analyzer/arn-detector.js";
import { enrichWithState } from "../state/state-reader.js";
import { findCrossNamespaceEdges } from "../planner/cut-finder.js";
import { planMigration, applyMigration } from "../planner/hcl-migrator.js";
import { generateUnifiedDiff } from "../planner/code-rewriter.js";
import { generateRollbackPlan } from "../planner/rollback-generator.js";
import { validateDirectory, validateFile } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { loadConfigFile, buildNamespaceConfig } from "../config/config-loader.js";
import { logParserWarnings, resolvePresetConfig, loadStateDir, warnNoStateDir, logUnresolvedReferences } from "./shared.js";
import { enrichGraphWithPlan, loadPlanDir } from "../state/plan-parser.js";
import type { NamespaceConfig, ParsedFile } from "../types.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Full code migration: move HCL blocks, rewrite ARNs, generate outputs/variables, create import/removed blocks")
    .argument("<paths...>", "Paths to Terraform repos")
    .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
    .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
    .option("--plan-dir <dir>", "Directory containing <repo-name>.plan.json files (output of terraform show -json)")
    .option("--mode <mode>", "Refactoring mode: import (TF 1.7+, cross-state), moved (TF 1.5+, same-state), tfmigrate (legacy)", "import")
    .option("--namespace <ns>", "Only migrate edges involving this namespace (e.g., service-api, foundation)")
    .option("--apply", "Write migration files to source repos (does NOT run terraform apply — you must do that manually after review)")
    .option("--validate", "Run terraform validate on migrated output (requires terraform binary)")
    .action(async (paths: string[], cmdOpts) => {
      const opts = program.opts();

      for (const p of paths) {
        await validateDirectory(p);
      }

      let nsConfig: NamespaceConfig | undefined;
      if (opts.config) {
        await validateFile(opts.config);
        const fileConfig = await loadConfigFile(opts.config);
        nsConfig = buildNamespaceConfig(fileConfig);
      } else if (cmdOpts.preset) {
        ({ config: nsConfig } = resolvePresetConfig(cmdOpts.preset));
      }

      // Build basePaths map (repo name -> absolute path)
      const basePaths = new Map<string, string>();
      let parsedFiles: ParsedFile[] = [];
      for (const p of paths) {
        const absPath = resolve(p);
        const files = await scanDirectory(absPath);
        parsedFiles.push(...files);
        if (files.length > 0) {
          basePaths.set(files[0].repo, absPath);
        }
      }

      let stateFiles: Awaited<ReturnType<typeof loadStateDir>> | undefined;
      if (cmdOpts.stateDir) {
        stateFiles = await loadStateDir(cmdOpts.stateDir);
        parsedFiles = enrichWithState(parsedFiles, stateFiles);
      } else {
        warnNoStateDir();
      }

      logParserWarnings(parsedFiles);

      let graph = buildGraph(parsedFiles);

      // Enrich graph with plan-based dependencies (higher precision than static analysis)
      if (cmdOpts.planDir) {
        const plans = await loadPlanDir(cmdOpts.planDir);
        for (const [repo, plan] of plans) {
          graph = enrichGraphWithPlan({ graph, parsedPlan: plan, repo });
        }
      }

      logUnresolvedReferences(graph);
      let cutEdges = findCrossNamespaceEdges(graph, nsConfig);
      const arnRefs = detectArns(parsedFiles);

      // Filter by namespace if specified
      if (cmdOpts.namespace) {
        const ns = cmdOpts.namespace as string;
        cutEdges = cutEdges.filter((c) => c.fromNamespace === ns || c.toNamespace === ns);
        if (cutEdges.length === 0) {
          logger.log(`✓ No cross-namespace dependencies involving "${ns}". Nothing to migrate.`);
          return;
        }
        logger.log(`Filtering to namespace: ${ns} (${cutEdges.length} edges)`);
      }

      if (cutEdges.length === 0) {
        logger.log("✓ No cross-namespace dependencies found. Nothing to migrate.");
        return;
      }

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        stateFiles,
        movedBlockMode: cmdOpts.mode as "moved" | "import" | "tfmigrate",
        dryRun: !cmdOpts.apply,
      });

      // Summary
      logger.log("\n=== Migration Plan ===");
      logger.log(`Resources to move: ${result.summary.resourcesMoved}`);
      logger.log(`ARNs to rewrite:   ${result.summary.arnsRewritten}`);
      logger.log(`Outputs to add:    ${result.summary.outputsGenerated}`);
      logger.log(`Files affected:    ${result.summary.filesModified}`);

      if (result.errors && result.errors.length > 0) {
        logger.log(`\n⚠ ${result.errors.length} step(s) had errors (partial results generated):`);
        for (const e of result.errors) {
          logger.log(`  • ${e.step}: ${e.error}`);
        }
      }

      // Show file operations
      logger.log("\n--- File Operations ---");
      for (const fw of result.fileWrites) {
        const icon = fw.operation === "create" ? "+" : fw.operation === "delete" ? "-" : "~";
        logger.log(`  [${icon}] ${fw.filePath}`);
      }

      if (cmdOpts.apply) {
        await handleApply({ result, opts });
      } else if (opts.outputDir) {
        await handleOutputPreview({ result, outputDir: opts.outputDir as string, basePaths, cmdOpts });
      } else {
        logger.log("\n⚠ Dry run — no files modified. Use -o <dir> to output files, or --apply to write in-place.");
      }
    });
}

async function handleApply({ result, opts }: { result: Awaited<ReturnType<typeof planMigration>>; opts: { outputDir?: string } }): Promise<void> {
  await applyMigration(result);
  logger.log("\n✓ Migration applied. Files written to disk.");

  if (opts.outputDir) {
    await mkdir(opts.outputDir, { recursive: true });
    await writeFile(join(opts.outputDir, "migrate.hcl"), result.tfmigrateHcl);
    logger.log(`  tfmigrate HCL: ${join(opts.outputDir, "migrate.hcl")}`);
  }

  logger.log("\nNext steps:");
  logger.log("  1. Review the changes: git diff");
  logger.log("  2. Run tfmigrate to move state: tfmigrate apply migrate.hcl");
  logger.log("  3. Verify: terraform plan (expect no changes)");
}

async function handleOutputPreview({ result, outputDir, basePaths, cmdOpts }: {
  result: Awaited<ReturnType<typeof planMigration>>;
  outputDir: string;
  basePaths: Map<string, string>;
  cmdOpts: { validate?: boolean };
}): Promise<void> {
  const outDir = outputDir;
  await mkdir(outDir, { recursive: true });

  // Write tfmigrate HCL and plan JSON
  await writeFile(join(outDir, "migrate.hcl"), result.tfmigrateHcl);
  await writeFile(join(outDir, "migrate-plan.json"), JSON.stringify(result, null, 2));

  // Write migrated file tree under output/migrated/
  const migratedDir = join(outDir, "migrated");
  const diffsDir = join(outDir, "diffs");
  await mkdir(migratedDir, { recursive: true });
  await mkdir(diffsDir, { recursive: true });

  const diffLines: string[] = [];

  for (const fw of result.fileWrites) {
    const relPath = resolveRelativePath(fw.filePath, basePaths);
    const outFilePath = join(migratedDir, relPath);

    if (fw.operation === "delete") {
      await mkdir(dirname(outFilePath), { recursive: true });
      await writeFile(outFilePath + ".DELETED", "# This file would be deleted by migration\n");
      diffLines.push(`--- a/${relPath}\n+++ /dev/null\n@@ deleted @@`);
    } else {
      await mkdir(dirname(outFilePath), { recursive: true });
      await writeFile(outFilePath, fw.content);

      if (fw.operation === "modify") {
        try {
          const original = await readFile(fw.filePath, "utf-8");
          const diff = generateUnifiedDiff(relPath, original, fw.content);
          diffLines.push(diff);
        } catch {
          // Original not readable, skip diff
        }
      } else {
        diffLines.push(`--- /dev/null\n+++ b/${relPath}\n@@ new file @@\n+${fw.content.split("\n").join("\n+")}`);
      }
    }
  }

  // Write combined diff
  if (diffLines.length > 0) {
    await writeFile(join(diffsDir, "migration.diff"), diffLines.join("\n\n"));
  }

  // Generate rollback plan
  const rollback = generateRollbackPlan(result);
  if (rollback.fileWrites.length > 0) {
    const rollbackDir = join(outDir, "rollback");
    await mkdir(rollbackDir, { recursive: true });
    for (const fw of rollback.fileWrites) {
      const rollbackFilePath = join(rollbackDir, fw.filePath);
      await mkdir(dirname(rollbackFilePath), { recursive: true });
      await writeFile(rollbackFilePath, fw.content);
    }
    if (rollback.tfmigrateHcl) {
      await writeFile(join(rollbackDir, "rollback.hcl"), rollback.tfmigrateHcl);
    }
    await writeFile(join(rollbackDir, "README.md"), `# Rollback Plan\n\n${rollback.description}\n\n## Steps\n\n${rollback.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`);
  }

  logger.log(`\n✓ Migration plan written to ${outDir}/`);
  logger.log(`  migrate.hcl         — tfmigrate execution file`);
  logger.log(`  migrate-plan.json   — full plan details`);
  logger.log(`  migrated/           — file tree after migration`);
  logger.log(`  diffs/              — unified diffs of all changes`);
  if (rollback.fileWrites.length > 0) {
    logger.log(`  rollback/           — reverse migration (if needed)`);
  }

  // Run terraform validate if --validate flag is set
  if (cmdOpts.validate) {
    const { validateSourceDirs } = await import("../state/terraform-validator.js");
    logger.log("\n--- Terraform Validate (source repos) ---");
    const sourceDirs = [...basePaths.values()];
    const validationResults = await validateSourceDirs({ directories: sourceDirs });
    let hasFailure = false;
    for (const vr of validationResults) {
      const icon = vr.valid ? "✓" : "✗";
      const dirName = vr.directory.split("/").pop() ?? vr.directory;
      logger.log(`  ${icon} ${dirName}${vr.valid ? "" : `: ${vr.error}`}`);
      if (!vr.valid) hasFailure = true;
    }
    if (hasFailure) {
      logger.warn("\n⚠ Validation failed for some directories. This may be expected if providers are not available locally.");
    }
  }

  logger.log(`\nSource repos are untouched. To apply: re-run with --apply`);
}

function resolveRelativePath(filePath: string, basePaths: Map<string, string>): string {
  // First pass: exact basePath prefix match (most reliable)
  for (const [repoName, basePath] of basePaths) {
    if (filePath.startsWith(basePath)) {
      return join(repoName, relative(basePath, filePath));
    }
  }

  // Second pass: check parent directory name matches a known repo
  const parentDir = filePath.split("/").slice(-2, -1)[0];
  if (parentDir && basePaths.has(parentDir)) {
    return join(parentDir, basename(filePath));
  }

  // Last resort: use filename only
  return basename(filePath);
}
