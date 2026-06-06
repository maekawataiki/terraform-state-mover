import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gatekeeperModelConfig, gatekeeperModelReportTemplate } from "../presets/gatekeeper.js";
import { terralithConfig, terralithReportTemplate } from "../presets/terralith.js";
import { spaghettiConfig, spaghettiReportTemplate } from "../presets/spaghetti.js";
import { parseStateJson } from "../state/state-reader.js";
import { validatePreset, validateDirectory, parseJson } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import type { NamespaceConfig, ParsedFile } from "../types.js";

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
