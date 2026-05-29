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
import type { NamespaceConfig, ParsedFile, SerializedGraph, ArnReference, MigrationPlan } from "./types.js";

const program = new Command();

program
  .name("tf-state-mover")
  .description("Analyze Terraform HCL files and generate migration plans")
  .version("0.1.0")
  .option("-o, --output-dir <dir>", "Output directory", "./output")
  .option("--dry-run", "Dry run mode")
  .option("-v, --verbose", "Verbose output");

program
  .command("analyze")
  .description("Scan repos and output dependency report")
  .argument("<paths...>", "Paths to Terraform repos")
  .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
  .option("--include-crossplane", "Also scan .yaml files for Crossplane resources")
  .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
  .action(async (paths: string[], cmdOpts) => {
    const opts = program.opts();
    let parsedFiles: ParsedFile[] = [];
    for (const p of paths) {
      parsedFiles.push(...await scanDirectory(p));
      if (cmdOpts.includeCrossplane) {
        parsedFiles.push(...await scanCrossplaneDirectory(p));
      }
    }

    if (cmdOpts.stateDir) {
      const stateFiles = await loadStateDir(cmdOpts.stateDir);
      parsedFiles = enrichWithState(parsedFiles, stateFiles);
    }

    let nsConfig: NamespaceConfig | undefined;
    if (cmdOpts.preset === "gatekeeper") {
      nsConfig = gatekeeperModelConfig;
    }

    const graph = buildGraph(parsedFiles);
    const arns = detectArns(parsedFiles);
    const byService = groupByService(arns);
    const unresolved = getUnresolvedArns(arns);

    console.log(`\n=== Dependency Analysis ===`);
    console.log(`Resources: ${graph.nodes.size}`);
    console.log(`Edges: ${graph.edges.length}`);
    console.log(`ARN references: ${arns.length}`);
    console.log(`Unresolved ARNs: ${unresolved.length}`);
    console.log(`\nARNs by service:`);
    for (const [service, refs] of byService) {
      console.log(`  ${service}: ${refs.length}`);
    }

    if (opts.outputDir) {
      await mkdir(opts.outputDir, { recursive: true });
      await writeFile(join(opts.outputDir, "graph.json"), JSON.stringify(serializeGraph(graph), null, 2));
      console.log(`\nGraph written to ${join(opts.outputDir, "graph.json")}`);

      const vizOpts = { config: nsConfig };
      await writeFile(join(opts.outputDir, "graph-before.dot"), toGraphvizBefore(graph, vizOpts));
      await writeFile(join(opts.outputDir, "graph-after.dot"), toGraphvizAfter(graph, vizOpts));
      console.log(`Graphs written to ${join(opts.outputDir, "graph-before.dot")}, graph-after.dot`);

      const plan = createMigrationPlan(graph, nsConfig);
      const templateSuffix = cmdOpts.preset === "gatekeeper" ? gatekeeperModelReportTemplate : undefined;
      const report = generateMarkdownReport({ graph, arnRefs: arns, plan, config: nsConfig, templateSuffix, parsedFiles });
      await writeFile(join(opts.outputDir, "report.md"), report);
      console.log(`Report written to ${join(opts.outputDir, "report.md")}`);
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
    let parsedFiles: ParsedFile[] = [];
    for (const p of paths) {
      parsedFiles.push(...await scanDirectory(p));
    }

    let nsConfig: NamespaceConfig | undefined;
    if (cmdOpts.namespaces) {
      const content = await readFile(cmdOpts.namespaces, "utf-8");
      nsConfig = JSON.parse(content);
    }

    if (cmdOpts.stateDir) {
      const stateFiles = await loadStateDir(cmdOpts.stateDir);
      parsedFiles = enrichWithState(parsedFiles, stateFiles);
    }

    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph, nsConfig);

    console.log(`\n=== Migration Plan ===`);
    console.log(`Steps: ${plan.steps.length}`);
    console.log(`Cross-namespace edges: ${plan.crossNamespaceEdges.length}`);

    if (opts.outputDir && !opts.dryRun) {
      await mkdir(opts.outputDir, { recursive: true });
      await writeFile(join(opts.outputDir, "plan.json"), plan.json);
      await writeFile(join(opts.outputDir, "migrate.sh"), plan.shellScript, { mode: 0o755 });
      await writeFile(join(opts.outputDir, "migrate.hcl"), plan.tfmigrateHcl);
      console.log(`\nPlan written to ${opts.outputDir}/`);
    } else {
      console.log(plan.shellScript);
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

    const prereqs = await checkPrerequisites({ dryRun: true, workingDir, tfBinary: cmdOpts.tfBinary });
    if (!prereqs.terraform) {
      console.error("Error: terraform binary not found");
      process.exit(1);
    }
    if (!prereqs.tfmigrate) {
      console.error("Error: tfmigrate binary not found");
      process.exit(1);
    }

    const result = await dryRunMigration(hclFile, { dryRun: true, workingDir, tfBinary: cmdOpts.tfBinary });
    if (result.success) {
      console.log("✓ Migration plan validated successfully");
      console.log(result.output);
    } else {
      console.error("✗ Migration plan validation failed");
      console.error(result.error);
      process.exit(1);
    }
  });

program
  .command("report")
  .description("Generate markdown report from a previous analysis JSON")
  .argument("<json-file>", "Path to graph.json from a previous analysis")
  .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
  .action(async (jsonFile: string, cmdOpts) => {
    const opts = program.opts();
    const content = await readFile(jsonFile, "utf-8");
    const serialized: SerializedGraph = JSON.parse(content);

    const graph = {
      nodes: new Map(serialized.nodes.map((n) => [n.id, n])),
      edges: serialized.edges,
    };

    let nsConfig: NamespaceConfig | undefined;
    let templateSuffix: string | undefined;
    if (cmdOpts.preset === "gatekeeper") {
      nsConfig = gatekeeperModelConfig;
      templateSuffix = gatekeeperModelReportTemplate;
    }

    const plan = createMigrationPlan(graph, nsConfig);
    const arnRefs: ArnReference[] = [];
    const report = generateMarkdownReport({ graph, arnRefs, plan, config: nsConfig, templateSuffix });

    if (opts.outputDir) {
      await mkdir(opts.outputDir, { recursive: true });
      await writeFile(join(opts.outputDir, "report.md"), report);
      console.log(`Report written to ${join(opts.outputDir, "report.md")}`);
    } else {
      console.log(report);
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
    let parsedFiles: ParsedFile[] = [];
    for (const p of paths) {
      parsedFiles.push(...await scanDirectory(p));
    }

    if (cmdOpts.stateDir) {
      const stateFiles = await loadStateDir(cmdOpts.stateDir);
      parsedFiles = enrichWithState(parsedFiles, stateFiles);
    }

    let nsConfig: NamespaceConfig | undefined;
    if (cmdOpts.preset === "gatekeeper") {
      nsConfig = gatekeeperModelConfig;
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
      console.log(`DOT graphs written to ${opts.outputDir}/`);
      console.log("  graph.dot        — basic dependency graph");
      console.log("  graph-before.dot — current state with problems highlighted");
      console.log("  graph-after.dot  — target state after migration");
    } else {
      console.log(before);
    }
  });

async function loadStateDir(dir: string) {
  const entries = await readdir(dir);
  const stateFiles = [];
  for (const entry of entries) {
    if (entry.endsWith(".tfstate.json")) {
      const repo = entry.replace(".tfstate.json", "");
      const content = await readFile(join(dir, entry), "utf-8");
      stateFiles.push(parseStateJson(content, repo));
    }
  }
  return stateFiles;
}

program.parse();
