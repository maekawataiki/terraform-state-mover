import { Command } from "commander";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { scanDirectory } from "./parser/hcl-parser.js";
import { scanCrossplaneDirectory } from "./parser/crossplane-parser.js";
import { buildGraph, serializeGraph, toGraphviz, toGraphvizBefore, toGraphvizAfter } from "./analyzer/dependency-graph.js";
import { detectArns, groupByService, getUnresolvedArns } from "./analyzer/arn-detector.js";
import { createMigrationPlan } from "./planner/migration-planner.js";
import { generateMarkdownReport } from "./reporter/markdown-reporter.js";
import { gatekeeperModelConfig, gatekeeperModelReportTemplate } from "./presets/gatekeeper.js";
import { parseStateJson, enrichWithState } from "./state/state-reader.js";
import { checkPrerequisites, dryRunMigration } from "./state/tfmigrate-executor.js";
import { CliError, formatError, validatePreset, validateDirectory, validateFile, parseJson } from "./utils/error.js";
import { logger } from "./utils/logger.js";
import type { NamespaceConfig, ParsedFile, SerializedGraph, ArnReference, MigrationPlan } from "./types.js";

const program = new Command();

program
  .name("tf-state-mover")
  .description("Analyze Terraform HCL files and generate migration plans")
  .version("0.1.0")
  .option("-o, --output-dir <dir>", "Output directory", "./output")
  .option("--dry-run", "Dry run mode")
  .option("-v, --verbose", "Verbose output");

function resolvePresetConfig(presetName: string | undefined): { config?: NamespaceConfig; templateSuffix?: string } {
  if (!presetName) return {};
  const preset = validatePreset(presetName);
  switch (preset) {
    case "gatekeeper":
      return { config: gatekeeperModelConfig, templateSuffix: gatekeeperModelReportTemplate };
  }
}

async function loadStateDir(dir: string) {
  await validateDirectory(dir);
  const entries = await readdir(dir);
  const stateFiles = [];
  for (const entry of entries) {
    if (entry.endsWith(".tfstate.json")) {
      const filePath = join(dir, entry);
      const repo = entry.replace(".tfstate.json", "");
      const content = await readFile(filePath, "utf-8");
      // Validate JSON before passing to parser
      parseJson(content, filePath);
      stateFiles.push(parseStateJson(content, repo));
    }
  }
  return stateFiles;
}

program
  .command("analyze")
  .description("Scan repos and output dependency report")
  .argument("<paths...>", "Paths to Terraform repos")
  .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
  .option("--include-crossplane", "Also scan .yaml files for Crossplane resources")
  .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
  .action(async (paths: string[], cmdOpts) => {
    const opts = program.opts();

    // Validate inputs
    for (const p of paths) {
      await validateDirectory(p);
    }
    const { config: nsConfig, templateSuffix } = resolvePresetConfig(cmdOpts.preset);

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
    }
  });

program
  .command("plan")
  .description("Generate migration plan")
  .argument("<paths...>", "Paths to Terraform repos")
  .option("-n, --namespaces <config>", "Namespace config JSON file")
  .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
  .action(async (paths: string[], cmdOpts) => {
    const opts = program.opts();

    // Validate inputs
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

program
  .command("validate")
  .description("Validate a migration HCL file using tfmigrate plan (dry-run)")
  .argument("<hcl-file>", "Path to tfmigrate HCL file")
  .option("--tf-binary <binary>", "Terraform binary name", "terraform")
  .action(async (hclFile: string, cmdOpts) => {
    const opts = program.opts();
    const workingDir = opts.outputDir || ".";

    await validateFile(hclFile);

    const prereqs = await checkPrerequisites({ dryRun: true, workingDir, tfBinary: cmdOpts.tfBinary });
    if (!prereqs.terraform) {
      throw new CliError("terraform binary not found in PATH. Install terraform first.");
    }
    if (!prereqs.tfmigrate) {
      throw new CliError("tfmigrate binary not found in PATH. Install tfmigrate first: https://github.com/minamijoyo/tfmigrate");
    }

    const result = await dryRunMigration(hclFile, { dryRun: true, workingDir, tfBinary: cmdOpts.tfBinary });
    if (result.success) {
      logger.log("✓ Migration plan validated successfully");
      logger.log(result.output);
    } else {
      throw new CliError(`Migration plan validation failed:\n${result.error}`);
    }
  });

program
  .command("report")
  .description("Generate markdown report from a previous analysis JSON")
  .argument("<json-file>", "Path to graph.json from a previous analysis")
  .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
  .action(async (jsonFile: string, cmdOpts) => {
    const opts = program.opts();

    await validateFile(jsonFile);
    const { config: nsConfig, templateSuffix } = resolvePresetConfig(cmdOpts.preset);

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

program
  .command("visualize")
  .description("Output dependency graphs (before/after) as DOT format")
  .argument("<paths...>", "Paths to Terraform repos")
  .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
  .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
  .action(async (paths: string[], cmdOpts) => {
    const opts = program.opts();

    // Validate inputs
    for (const p of paths) {
      await validateDirectory(p);
    }
    const { config: nsConfig } = resolvePresetConfig(cmdOpts.preset);

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

// Global error handler — catches CliError thrown from any action
async function main() {
  try {
    await program.parseAsync();
  } catch (error: unknown) {
    if (error instanceof CliError) {
      logger.error(`Error: ${error.message}`);
      process.exitCode = 1;
    } else {
      logger.error(`Unexpected error: ${formatError(error)}`);
      if (program.opts().verbose) {
        logger.error(error);
      }
      process.exitCode = 1;
    }
  }
}

main();
