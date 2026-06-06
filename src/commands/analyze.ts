import type { Command } from "commander";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scanDirectory } from "../parser/hcl-parser.js";
import { scanCrossplaneDirectory } from "../parser/crossplane-parser.js";
import { buildGraph, serializeGraph } from "../analyzer/dependency-graph.js";
import { toGraphvizBefore, toGraphvizAfter } from "../reporter/graphviz.js";
import { detectArns, groupByService, getUnresolvedArns } from "../analyzer/arn-detector.js";
import { createMigrationPlan } from "../planner/migration-planner.js";
import { generateMarkdownReport } from "../reporter/markdown-reporter.js";
import { enrichWithState } from "../state/state-reader.js";
import { validateDirectory, validateFile } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { loadConfigFile, buildNamespaceConfig } from "../config/config-loader.js";
import { logParserWarnings, resolvePresetConfig, loadStateDir } from "./shared.js";
import type { NamespaceConfig, ParsedFile } from "../types.js";

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Scan repos and output dependency report")
    .argument("<paths...>", "Paths to Terraform repos")
    .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
    .option("--include-crossplane", "Also scan .yaml files for Crossplane resources")
    .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
    .action(async (paths: string[], cmdOpts) => {
      const opts = program.opts();

      for (const p of paths) {
        await validateDirectory(p);
      }

      let nsConfig: NamespaceConfig | undefined;
      let templateSuffix: string | undefined;
      if (opts.config) {
        await validateFile(opts.config);
        const fileConfig = await loadConfigFile(opts.config);
        nsConfig = buildNamespaceConfig(fileConfig);
      } else if (cmdOpts.preset) {
        ({ config: nsConfig, templateSuffix } = resolvePresetConfig(cmdOpts.preset));
      }

      let parsedFiles: ParsedFile[] = [];
      for (const p of paths) {
        parsedFiles.push(...await scanDirectory(p));
        if (cmdOpts.includeCrossplane) {
          parsedFiles.push(...await scanCrossplaneDirectory(p));
        }
      }

      let stateFiles: Awaited<ReturnType<typeof loadStateDir>> | undefined;
      if (cmdOpts.stateDir) {
        stateFiles = await loadStateDir(cmdOpts.stateDir);
        parsedFiles = enrichWithState(parsedFiles, stateFiles);
      }

      logParserWarnings(parsedFiles);

      const graph = buildGraph(parsedFiles);
      const arns = detectArns(parsedFiles);
      const byService = groupByService(arns);
      const unresolved = getUnresolvedArns(arns);

      logger.log(`\n=== Dependency Analysis ===`);
      logger.log(`Resources: ${graph.nodes.size}`);
      logger.log(`Edges: ${graph.edges.length}`);
      logger.log(`ARN references: ${arns.length}`);
      logger.log(`Unresolved ARNs: ${unresolved.length}`);
      logger.log(`\nARNs by service:`);
      for (const [service, refs] of byService) {
        logger.log(`  ${service}: ${refs.length}`);
      }

      if (opts.outputDir) {
        await mkdir(opts.outputDir, { recursive: true });
        await writeFile(join(opts.outputDir, "graph.json"), JSON.stringify(serializeGraph(graph), null, 2));
        logger.log(`\nGraph written to ${join(opts.outputDir, "graph.json")}`);

        const vizOpts = { config: nsConfig };
        await writeFile(join(opts.outputDir, "graph-before.dot"), toGraphvizBefore(graph, vizOpts));
        await writeFile(join(opts.outputDir, "graph-after.dot"), toGraphvizAfter(graph, vizOpts));
        logger.log(`Graphs written to ${join(opts.outputDir, "graph-before.dot")}, graph-after.dot`);

        const plan = createMigrationPlan(graph, nsConfig, stateFiles);
        const report = generateMarkdownReport({ graph, arnRefs: arns, plan, config: nsConfig, templateSuffix, parsedFiles });
        await writeFile(join(opts.outputDir, "report.md"), report);
        logger.log(`Report written to ${join(opts.outputDir, "report.md")}`);

        await writeFile(join(opts.outputDir, "plan.json"), plan.json);
        await writeFile(join(opts.outputDir, "migrate.sh"), plan.shellScript, { mode: 0o755 });
        await writeFile(join(opts.outputDir, "migrate.hcl"), plan.tfmigrateHcl);
        logger.log(`Plan written to ${join(opts.outputDir, "plan.json")}, migrate.sh, migrate.hcl`);
      }
    });
}
