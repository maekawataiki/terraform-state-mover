import type { Command } from "commander";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanDirectory } from "../parser/hcl-parser.js";
import { buildGraph } from "../analyzer/dependency-graph.js";
import { createMigrationPlan } from "../planner/migration-planner.js";
import { enrichWithState } from "../state/state-reader.js";
import { validateDirectory, validateFile, parseJson } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { loadStateDir } from "./shared.js";
import type { NamespaceConfig, ParsedFile } from "../types.js";

export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description("Generate migration plan")
    .argument("<paths...>", "Paths to Terraform repos")
    .option("-n, --namespaces <config>", "Namespace config JSON file")
    .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
    .action(async (paths: string[], cmdOpts) => {
      const opts = program.opts();

      for (const p of paths) {
        await validateDirectory(p);
      }

      let parsedFiles: ParsedFile[] = [];
      for (const p of paths) {
        parsedFiles.push(...await scanDirectory(p));
      }

      let nsConfig: NamespaceConfig | undefined;
      if (cmdOpts.namespaces) {
        await validateFile(cmdOpts.namespaces);
        const content = await readFile(cmdOpts.namespaces, "utf-8");
        nsConfig = parseJson<NamespaceConfig>(content, cmdOpts.namespaces);
      }

      let stateFiles: Awaited<ReturnType<typeof loadStateDir>> | undefined;
      if (cmdOpts.stateDir) {
        stateFiles = await loadStateDir(cmdOpts.stateDir);
        parsedFiles = enrichWithState(parsedFiles, stateFiles);
      }

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, nsConfig, stateFiles);

      logger.log(`\n=== Migration Plan ===`);
      logger.log(`Steps: ${plan.steps.length}`);
      logger.log(`Cross-namespace edges: ${plan.crossNamespaceEdges.length}`);

      if (opts.outputDir && !opts.dryRun) {
        await mkdir(opts.outputDir, { recursive: true });
        await writeFile(join(opts.outputDir, "plan.json"), plan.json);
        await writeFile(join(opts.outputDir, "migrate.sh"), plan.shellScript, { mode: 0o755 });
        await writeFile(join(opts.outputDir, "migrate.hcl"), plan.tfmigrateHcl);
        logger.log(`\nPlan written to ${opts.outputDir}/`);
      } else {
        logger.log(plan.shellScript);
      }
    });
}
