import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gatekeeperModelConfig, gatekeeperModelReportTemplate } from "../presets/gatekeeper.js";
import { terralithConfig, terralithReportTemplate } from "../presets/terralith.js";
import { spaghettiConfig, spaghettiReportTemplate } from "../presets/spaghetti.js";
import { parseStateJson } from "../state/state-reader.js";
import { validatePreset, validateDirectory, parseJson } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import type { NamespaceConfig, ParsedFile, DependencyGraph } from "../types.js";

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
