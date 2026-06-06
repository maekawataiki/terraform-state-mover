import type { Command } from "commander";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMigrationPlan } from "../planner/migration-planner.js";
import { generateMarkdownReport } from "../reporter/markdown-reporter.js";
import { validateFile, parseJson } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { loadConfigFile, buildNamespaceConfig } from "../config/config-loader.js";
import { resolvePresetConfig } from "./shared.js";
import type { NamespaceConfig, SerializedGraph, ArnReference } from "../types.js";

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Generate markdown report from a previous analysis JSON")
    .argument("<json-file>", "Path to graph.json from a previous analysis")
    .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
    .action(async (jsonFile: string, cmdOpts) => {
      const opts = program.opts();

      await validateFile(jsonFile);

      let nsConfig: NamespaceConfig | undefined;
      let templateSuffix: string | undefined;
      if (opts.config) {
        await validateFile(opts.config);
        const fileConfig = await loadConfigFile(opts.config);
        nsConfig = buildNamespaceConfig(fileConfig);
      } else if (cmdOpts.preset) {
        ({ config: nsConfig, templateSuffix } = resolvePresetConfig(cmdOpts.preset));
      }

      const content = await readFile(jsonFile, "utf-8");
      const serialized = parseJson<SerializedGraph>(content, jsonFile);

      const graph = {
        nodes: new Map(serialized.nodes.map((n) => [n.id, n])),
        edges: serialized.edges,
      };

      const plan = createMigrationPlan(graph, nsConfig);
      const arnRefs: ArnReference[] = [];
      const report = generateMarkdownReport({ graph, arnRefs, plan, config: nsConfig, templateSuffix });

      if (opts.outputDir) {
        await mkdir(opts.outputDir, { recursive: true });
        await writeFile(join(opts.outputDir, "report.md"), report);
        logger.log(`Report written to ${join(opts.outputDir, "report.md")}`);
      } else {
        logger.log(report);
      }
    });
}
