import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gatekeeperModelConfig, gatekeeperModelReportTemplate } from "../presets/gatekeeper.js";
import { terralithConfig, terralithReportTemplate } from "../presets/terralith.js";
import { spaghettiConfig, spaghettiReportTemplate } from "../presets/spaghetti.js";
import { crossAccountConfig, crossAccountReportTemplate } from "../presets/cross-account.js";
import { dataLayerConfig, dataLayerReportTemplate } from "../presets/data-layer.js";
import { parseStateJson, enrichWithState } from "../state/state-reader.js";
import type { StateFile } from "../state/state-reader.js";
import { validatePreset, validateDirectory, validateFile, parseJson } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import { scanDirectory } from "../parser/hcl-parser.js";
import { buildGraph } from "../analyzer/dependency-graph.js";
import { enrichGraphWithPlan, loadPlanDir } from "../state/plan-parser.js";
import { loadConfigFile, buildNamespaceConfig } from "../config/config-loader.js";
import type { NamespaceConfig, ParsedFile, DependencyGraph, ArnReference } from "../types.js";
import { detectArns } from "../analyzer/arn-detector.js";

export function logParserWarnings(parsedFiles: ParsedFile[]): void {
  const allWarnings = parsedFiles.flatMap((f) => f.warnings || []);
  if (allWarnings.length > 0) {
    logger.log(`\n⚠ Parser limitations detected (${allWarnings.length} warnings):`);
    for (const w of allWarnings.slice(0, 10)) {
      const icon = w.severity === "warning" ? "⚠" : "ℹ";
      logger.log(`  ${icon} ${w.filePath}:${w.line} — ${w.message}`);
    }
    if (allWarnings.length > 10) {
      logger.log(`  ... and ${allWarnings.length - 10} more`);
    }
  }
}

export function logUnresolvedReferences(graph: DependencyGraph): void {
  const unresolvedEdges = graph.edges.filter((e) => e.type === "unresolved");
  if (unresolvedEdges.length === 0) return;

  logger.warn(`\n⚠ Unresolved dynamic references (${unresolvedEdges.length}):`);
  logger.warn("  These dependencies use dynamic expressions and cannot be statically traced.");
  logger.warn("  The migration plan may be incomplete — verify manually.\n");

  const byReason = new Map<string, string[]>();
  for (const edge of unresolvedEdges) {
    const [reason] = (edge.label || "unknown: ?").split(": ", 1);
    const expressions = byReason.get(reason) || [];
    expressions.push(edge.from);
    byReason.set(reason, expressions);
  }

  for (const [reason, sources] of byReason) {
    const reasonLabel = {
      dynamic_index: "Dynamic indexing (e.g. data[local.type])",
      computed_key: "Computed map key (e.g. var.map[var.key])",
      function_call: "Function-based lookup (e.g. lookup(...))",
      conditional: "Conditional reference (e.g. cond ? a : b)",
      splat: "Splat expression (e.g. resource.*.attr)",
    }[reason] || reason;

    logger.warn(`  ${reasonLabel}: ${sources.length} occurrence(s)`);
    for (const src of sources.slice(0, 3)) {
      logger.warn(`    → ${src}`);
    }
    if (sources.length > 3) {
      logger.warn(`    ... and ${sources.length - 3} more`);
    }
  }
}

export function resolvePresetConfig(presetName: string | undefined): { config?: NamespaceConfig; templateSuffix?: string } {
  if (!presetName) return {};
  const preset = validatePreset(presetName);
  switch (preset) {
    case "gatekeeper":
      return { config: gatekeeperModelConfig, templateSuffix: gatekeeperModelReportTemplate };
    case "terralith":
      return { config: terralithConfig, templateSuffix: terralithReportTemplate };
    case "spaghetti":
      return { config: spaghettiConfig, templateSuffix: spaghettiReportTemplate };
    case "cross-account":
      return { config: crossAccountConfig, templateSuffix: crossAccountReportTemplate };
    case "data-layer":
      return { config: dataLayerConfig, templateSuffix: dataLayerReportTemplate };
  }
}

export function warnNoStateDir(): void {
  logger.warn("┌─────────────────────────────────────────────────────────────────────┐");
  logger.warn("│ ⚠ No --state-dir provided.                                         │");
  logger.warn("│   Import blocks will use <RESOURCE_ID> placeholders instead of      │");
  logger.warn("│   real resource IDs. To generate accurate import blocks, pull state: │");
  logger.warn("│                                                                     │");
  logger.warn("│   terraform -chdir=./repo state pull > states/repo.tfstate.json     │");
  logger.warn("│   Then re-run with: --state-dir ./states                            │");
  logger.warn("└─────────────────────────────────────────────────────────────────────┘");
}

export async function loadStateDir(dir: string) {
  await validateDirectory(dir);
  const entries = await readdir(dir);
  const stateFiles = [];
  for (const entry of entries) {
    if (entry.endsWith(".tfstate.json")) {
      const filePath = join(dir, entry);
      const repo = entry.replace(".tfstate.json", "");
      const content = await readFile(filePath, "utf-8");
      parseJson(content, filePath);
      stateFiles.push(parseStateJson(content, repo));
    }
  }
  return stateFiles;
}

// ---------------------------------------------------------------------------
// Shared context builder — eliminates duplication between analyze/migrate/plan/visualize
// ---------------------------------------------------------------------------

export interface BuildContextInput {
  paths: string[];
  /** Preset name (e.g. "gatekeeper") */
  preset?: string;
  /** Path to .tf-mover.yaml config file */
  configFile?: string;
  /** Directory with <repo>.tfstate.json files */
  stateDir?: string;
  /** Directory with <repo>.plan.json files */
  planDir?: string;
  /** Also scan Crossplane YAML files */
  includeCrossplane?: boolean;
}

export interface CommandContext {
  parsedFiles: ParsedFile[];
  graph: DependencyGraph;
  arnRefs: ArnReference[];
  stateFiles?: StateFile[];
  basePaths: Map<string, string>;
  nsConfig?: NamespaceConfig;
  templateSuffix?: string;
}

/**
 * Build the shared analysis context used by all commands.
 * Handles: path validation, config resolution, scanning, state enrichment,
 * graph building, plan enrichment, and warning output.
 */
export async function buildCommandContext(input: BuildContextInput): Promise<CommandContext> {
  const { paths, preset, configFile, stateDir, planDir, includeCrossplane } = input;

  // 1. Validate paths
  for (const p of paths) {
    await validateDirectory(p);
  }

  // 2. Resolve namespace config
  let nsConfig: NamespaceConfig | undefined;
  let templateSuffix: string | undefined;
  if (configFile) {
    await validateFile(configFile);
    const fileConfig = await loadConfigFile(configFile);
    nsConfig = buildNamespaceConfig(fileConfig);
  } else if (preset) {
    ({ config: nsConfig, templateSuffix } = resolvePresetConfig(preset));
  }

  // 3. Scan directories → parsedFiles + basePaths
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

  // 3b. Optionally scan Crossplane YAMLs
  if (includeCrossplane) {
    const { scanCrossplaneDirectory } = await import("../parser/crossplane-parser.js");
    for (const p of paths) {
      parsedFiles.push(...await scanCrossplaneDirectory(p));
    }
  }

  // 4. Load state + enrich
  let stateFiles: StateFile[] | undefined;
  if (stateDir) {
    stateFiles = await loadStateDir(stateDir);
    parsedFiles = enrichWithState(parsedFiles, stateFiles);
  } else {
    warnNoStateDir();
  }

  logParserWarnings(parsedFiles);

  // 5. Build graph + plan enrichment
  let graph = buildGraph(parsedFiles);
  if (planDir) {
    const plans = await loadPlanDir(planDir);
    for (const [repo, plan] of plans) {
      graph = enrichGraphWithPlan({ graph, parsedPlan: plan, repo });
    }
  }

  logUnresolvedReferences(graph);

  // 6. Detect ARNs
  const arnRefs = detectArns(parsedFiles);

  return { parsedFiles, graph, arnRefs, stateFiles, basePaths, nsConfig, templateSuffix };
}
