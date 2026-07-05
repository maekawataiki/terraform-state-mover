import type { Command } from "commander";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serializeGraph } from "../analyzer/dependency-graph.js";
import { toGraphvizBefore, toGraphvizAfter } from "../reporter/graphviz.js";
import { groupByService, getUnresolvedArns } from "../analyzer/arn-detector.js";
import { createMigrationPlan } from "../planner/migration-planner.js";
import { generateMarkdownReport } from "../reporter/markdown-reporter.js";
import { logger } from "../utils/logger.js";
import { buildCommandContext } from "./shared.js";

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Scan repos and output dependency report")
    .argument("<paths...>", "Paths to Terraform repos")
    .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
    .option("--include-crossplane", "Also scan .yaml files for Crossplane resources")
    .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
    .option("--plan-dir <dir>", "Directory containing <repo-name>.plan.json files (output of terraform show -json)")
    .action(async (paths: string[], cmdOpts) => {
      const opts = program.opts();

      const ctx = await buildCommandContext({
        paths,
        preset: cmdOpts.preset,
        configFile: opts.config,
        stateDir: cmdOpts.stateDir,
        planDir: cmdOpts.planDir,
        includeCrossplane: cmdOpts.includeCrossplane,
      });

      const { graph, arnRefs, stateFiles, parsedFiles, nsConfig, templateSuffix } = ctx;
      const byService = groupByService(arnRefs);
      const unresolved = getUnresolvedArns(arnRefs);

      logger.log(`\n=== Dependency Analysis ===`);
      logger.log(`Resources: ${graph.nodes.size}`);
      logger.log(`Edges: ${graph.edges.length}`);
      logger.log(`ARN references: ${arnRefs.length}`);
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
        const report = generateMarkdownReport({ graph, arnRefs, plan, config: nsConfig, templateSuffix, parsedFiles });
        await writeFile(join(opts.outputDir, "report.md"), report);
        logger.log(`Report written to ${join(opts.outputDir, "report.md")}`);

        await writeFile(join(opts.outputDir, "plan.json"), plan.json);
        await writeFile(join(opts.outputDir, "migrate.sh"), plan.shellScript, { mode: 0o755 });
        await writeFile(join(opts.outputDir, "migrate.hcl"), plan.tfmigrateHcl);
        logger.log(`Plan written to ${join(opts.outputDir, "plan.json")}, migrate.sh, migrate.hcl`);
      }
    });
}
