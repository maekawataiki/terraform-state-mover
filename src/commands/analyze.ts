import type { Command } from "commander";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serializeGraph, detectCycles } from "../analyzer/dependency-graph.js";
import { toGraphvizBefore, toGraphvizAfter } from "../reporter/graphviz.js";
import { groupByService, getUnresolvedArns } from "../analyzer/arn-detector.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";
import { createMigrationPlan } from "../planner/migration-planner.js";
import { findCrossNamespaceEdges } from "../planner/cut-finder.js";
import { generateMarkdownReport } from "../reporter/markdown-reporter.js";
import { detectPatterns } from "../reporter/detect-patterns.js";
import { logger } from "../utils/logger.js";
import { buildCommandContext } from "./shared.js";

/**
 * Structured JSON output for CI/tool integration.
 */
export interface AnalyzeJsonOutput {
  version: string;
  summary: {
    resources: number;
    edges: number;
    crossNamespaceEdges: number;
    arnReferences: number;
    unresolvedReferences: number;
    parserWarnings: number;
    repos: string[];
  };
  patterns: Array<{
    name: string;
    severity: "critical" | "warning" | "info";
    description: string;
    evidence: string[];
  }>;
  warnings: Array<{
    file: string;
    line: number;
    message: string;
    severity: string;
  }>;
  unresolvedRefs: Array<{
    from: string;
    expression: string;
    reason: string;
  }>;
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Scan repos and output dependency report")
    .argument("<paths...>", "Paths to Terraform repos")
    .option("--preset <name>", "Use a preset config (e.g., gatekeeper)")
    .option("--include-crossplane", "Also scan .yaml files for Crossplane resources")
    .option("--state-dir <dir>", "Directory containing <repo-name>.tfstate.json files")
    .option("--plan-dir <dir>", "Directory containing <repo-name>.plan.json files (output of terraform show -json)")
    .option("--json", "Output structured JSON to stdout (for CI/tool integration)")
    .option("--strict", "Exit with code 1 if any warnings or anti-patterns are detected")
    .action(async (paths: string[], cmdOpts) => {
      const opts = program.opts();
      const isJson = cmdOpts.json === true;
      const isStrict = cmdOpts.strict === true;

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

      // Run pattern detection
      const classifications = classifyGraph(new Map(graph.nodes), nsConfig);
      const cycles = detectCycles(graph);
      const patterns = detectPatterns(graph, arnRefs, classifications, cycles, parsedFiles);

      // Collect cross-namespace edges
      const crossNsEdges = findCrossNamespaceEdges(graph, nsConfig);

      // Collect parser warnings
      const allWarnings = parsedFiles.flatMap((f) => (f.warnings || []).map((w) => ({
        file: w.filePath,
        line: w.line,
        message: w.message,
        severity: w.severity,
      })));

      // Collect unresolved references
      const unresolvedEdges = graph.edges.filter((e) => e.type === "unresolved");
      const unresolvedRefs = unresolvedEdges.map((e) => {
        const [reason, expression] = (e.label || "unknown: ?").split(": ", 2);
        return { from: e.from, expression: expression || "", reason };
      });

      // --- JSON output mode ---
      if (isJson) {
        const repos = [...new Set([...graph.nodes.values()].map((n) => n.repo))];
        const output: AnalyzeJsonOutput = {
          version: "0.1.0",
          summary: {
            resources: graph.nodes.size,
            edges: graph.edges.length,
            crossNamespaceEdges: crossNsEdges.length,
            arnReferences: arnRefs.length,
            unresolvedReferences: unresolvedEdges.length,
            parserWarnings: allWarnings.length,
            repos,
          },
          patterns: patterns.map((p) => ({
            name: p.name,
            severity: p.severity,
            description: p.description,
            evidence: p.evidence,
          })),
          warnings: allWarnings,
          unresolvedRefs,
        };

        // Write to stdout (not logger — logger goes to stderr in json mode)
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");

        // Strict mode: exit 1 if patterns or warnings detected
        if (isStrict) {
          const hasIssues = patterns.length > 0 || allWarnings.length > 0 || unresolvedEdges.length > 0;
          if (hasIssues) {
            process.exitCode = 1;
          }
        }
        return;
      }

      // --- Human-readable output mode ---
      logger.log(`\n=== Dependency Analysis ===`);
      logger.log(`Resources: ${graph.nodes.size}`);
      logger.log(`Edges: ${graph.edges.length}`);
      logger.log(`Cross-namespace edges: ${crossNsEdges.length}`);
      logger.log(`ARN references: ${arnRefs.length}`);
      logger.log(`Unresolved ARNs: ${unresolved.length}`);
      logger.log(`Parser warnings: ${allWarnings.length}`);
      logger.log(`\nARNs by service:`);
      for (const [service, refs] of byService) {
        logger.log(`  ${service}: ${refs.length}`);
      }

      if (patterns.length > 0) {
        logger.log(`\n=== Detected Anti-Patterns ===`);
        for (const p of patterns) {
          const icon = p.severity === "critical" ? "🔴" : p.severity === "warning" ? "🟡" : "🔵";
          logger.log(`${icon} ${p.name} — ${p.description}`);
        }
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

      // Strict mode: exit 1 if patterns or warnings detected
      if (isStrict) {
        const hasIssues = patterns.length > 0 || allWarnings.length > 0 || unresolvedEdges.length > 0;
        if (hasIssues) {
          const counts = [];
          if (patterns.length > 0) counts.push(`${patterns.length} anti-pattern(s)`);
          if (allWarnings.length > 0) counts.push(`${allWarnings.length} parser warning(s)`);
          if (unresolvedEdges.length > 0) counts.push(`${unresolvedEdges.length} unresolved reference(s)`);
          logger.log(`\n⚠ --strict: exiting with code 1 due to ${counts.join(", ")}`);
          process.exitCode = 1;
        }
      }
    });
}
