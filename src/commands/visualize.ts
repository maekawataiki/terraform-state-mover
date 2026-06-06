import type { Command } from "commander";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scanDirectory } from "../parser/hcl-parser.js";
import { buildGraph } from "../analyzer/dependency-graph.js";
import { toGraphviz, toGraphvizBefore, toGraphvizAfter } from "../reporter/graphviz.js";
import { enrichWithState } from "../state/state-reader.js";
import { validateDirectory, validateFile } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { loadConfigFile, buildNamespaceConfig } from "../config/config-loader.js";
import { resolvePresetConfig, loadStateDir } from "./shared.js";
import type { NamespaceConfig, ParsedFile } from "../types.js";

export function registerVisualizeCommand(program: Command): void {
  program
    .command("visualize")
    .description("Output dependency graphs (before/after) as DOT format")
    .argument("<paths...>", "Paths to Terraform repos")
    .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
    .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
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

      let parsedFiles: ParsedFile[] = [];
      for (const p of paths) {
        parsedFiles.push(...await scanDirectory(p));
      }

      if (cmdOpts.stateDir) {
        const stateFiles = await loadStateDir(cmdOpts.stateDir);
        parsedFiles = enrichWithState(parsedFiles, stateFiles);
      }

      const graph = buildGraph(parsedFiles);
      const before = toGraphvizBefore(graph, { config: nsConfig });
      const after = toGraphvizAfter(graph, { config: nsConfig });
      const basic = toGraphviz(graph);

      if (opts.outputDir) {
        await mkdir(opts.outputDir, { recursive: true });
        await writeFile(join(opts.outputDir, "graph.dot"), basic);
        await writeFile(join(opts.outputDir, "graph-before.dot"), before);
        await writeFile(join(opts.outputDir, "graph-after.dot"), after);
        logger.log(`DOT graphs written to ${opts.outputDir}/`);
        logger.log("  graph.dot        — basic dependency graph");
        logger.log("  graph-before.dot — current state with problems highlighted");
        logger.log("  graph-after.dot  — target state after migration");
      } else {
        logger.log(before);
      }
    });
}
