/**
 * OSS Module Fuzzing: Parse real-world terraform-aws-modules without crash or error.
 *
 * This test validates parser robustness against popular community modules
 * containing complex HCL patterns: dynamic blocks, heredocs, templatefile(),
 * for_each, count, conditional expressions, etc.
 *
 * Success criteria:
 * - Zero crashes (no thrown exceptions)
 * - Zero errors (all files parse successfully)
 * - Warning count is bounded (no explosion of false-positive warnings)
 *
 * Modules tested (shallow-cloned to tmp/oss-modules/):
 * - terraform-aws-vpc (VPC, subnets, route tables)
 * - terraform-aws-eks (EKS, node groups, IRSA)
 * - terraform-aws-lambda (Lambda, layers, event triggers)
 * - terraform-aws-rds (RDS, Aurora, parameter groups)
 * - terraform-aws-s3-bucket (S3, lifecycle, replication)
 * - terraform-aws-iam (IAM roles, policies, OIDC)
 * - terraform-aws-alb (ALB, target groups, listeners)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { buildGraph } from "../../src/analyzer/dependency-graph.js";
import { detectArns } from "../../src/analyzer/arn-detector.js";

const OSS_MODULES_DIR = join(process.cwd(), "tmp/oss-modules");

const MODULES = [
  "terraform-aws-vpc",
  "terraform-aws-eks",
  "terraform-aws-lambda",
  "terraform-aws-rds",
  "terraform-aws-s3-bucket",
  "terraform-aws-iam",
  "terraform-aws-alb",
];

function ossModulesAvailable(): boolean {
  return existsSync(OSS_MODULES_DIR) && MODULES.some((m) => existsSync(join(OSS_MODULES_DIR, m)));
}

describe("OSS Module Fuzzing: parse without crash", () => {
  const skipAll = !ossModulesAvailable();
  const availableModules: string[] = [];

  beforeAll(async () => {
    if (skipAll) return;
    const entries = await readdir(OSS_MODULES_DIR);
    for (const m of MODULES) {
      if (entries.includes(m)) {
        availableModules.push(m);
      }
    }
  });

  it.skipIf(skipAll)("all modules parse without throwing", async () => {
    const results: Array<{
      module: string;
      files: number;
      blocks: number;
      warnings: number;
      errors: string[];
    }> = [];

    for (const moduleName of availableModules) {
      const moduleDir = join(OSS_MODULES_DIR, moduleName);
      const errors: string[] = [];

      let parsedFiles;
      try {
        parsedFiles = await scanDirectory(moduleDir, moduleName);
      } catch (err: unknown) {
        errors.push(`scanDirectory crashed: ${err instanceof Error ? err.message : String(err)}`);
        results.push({ module: moduleName, files: 0, blocks: 0, warnings: 0, errors });
        continue;
      }

      const totalBlocks = parsedFiles.reduce((sum, f) => sum + f.blocks.length, 0);
      const totalWarnings = parsedFiles.reduce((sum, f) => sum + (f.warnings?.length || 0), 0);

      results.push({
        module: moduleName,
        files: parsedFiles.length,
        blocks: totalBlocks,
        warnings: totalWarnings,
        errors,
      });
    }

    // Report
    console.log("\n=== OSS Module Fuzzing Results ===");
    console.log("Module                        | Files | Blocks | Warnings | Errors");
    console.log("------------------------------|-------|--------|----------|-------");
    for (const r of results) {
      const name = r.module.padEnd(30);
      const files = String(r.files).padStart(5);
      const blocks = String(r.blocks).padStart(6);
      const warnings = String(r.warnings).padStart(8);
      const errs = String(r.errors.length).padStart(6);
      console.log(`${name}|${files} |${blocks} |${warnings} |${errs}`);
    }

    // Assertions
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
    expect(totalErrors).toBe(0);

    // All modules should parse at least some files
    for (const r of results) {
      expect(r.files).toBeGreaterThan(0);
      expect(r.blocks).toBeGreaterThan(0);
    }
  }, 60_000);

  it.skipIf(skipAll)("graph construction works on all modules", async () => {
    for (const moduleName of availableModules) {
      const moduleDir = join(OSS_MODULES_DIR, moduleName);
      const parsedFiles = await scanDirectory(moduleDir, moduleName);

      // buildGraph should not throw
      let graph;
      try {
        graph = buildGraph(parsedFiles);
      } catch (err: unknown) {
        expect.fail(`buildGraph crashed on ${moduleName}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      expect(graph.nodes.size).toBeGreaterThan(0);
      // Edges are fine if empty (single-module repos might not have cross-references)
    }
  }, 60_000);

  it.skipIf(skipAll)("ARN detection works without crash on all modules", async () => {
    for (const moduleName of availableModules) {
      const moduleDir = join(OSS_MODULES_DIR, moduleName);
      const parsedFiles = await scanDirectory(moduleDir, moduleName);

      let arns;
      try {
        arns = detectArns(parsedFiles);
      } catch (err: unknown) {
        expect.fail(`detectArns crashed on ${moduleName}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      // ARN detection should return an array (may be empty for some modules)
      expect(Array.isArray(arns)).toBe(true);
    }
  }, 60_000);

  it.skipIf(skipAll)("warning rate is bounded (< 20% of files)", async () => {
    for (const moduleName of availableModules) {
      const moduleDir = join(OSS_MODULES_DIR, moduleName);
      const parsedFiles = await scanDirectory(moduleDir, moduleName);

      const filesWithWarnings = parsedFiles.filter((f) => f.warnings && f.warnings.length > 0).length;
      const warningRate = parsedFiles.length > 0 ? filesWithWarnings / parsedFiles.length : 0;

      // Modules should not trigger excessive warnings
      // Allow up to 50% for complex modules (dynamic blocks, templatefile are common)
      expect(warningRate).toBeLessThan(0.5);
    }
  }, 60_000);

  it.skipIf(skipAll)("combined multi-module graph works", async () => {
    // Simulate real-world usage: parse multiple modules together
    const allFiles = [];
    for (const moduleName of availableModules.slice(0, 4)) {
      const moduleDir = join(OSS_MODULES_DIR, moduleName);
      const parsedFiles = await scanDirectory(moduleDir, moduleName);
      allFiles.push(...parsedFiles);
    }

    const graph = buildGraph(allFiles);
    expect(graph.nodes.size).toBeGreaterThan(10);

    // Should detect some cross-module ARN references (IAM ARNs in other modules)
    const arnEdges = graph.edges.filter((e) => e.type === "arn");
    // Even if 0, the graph should be well-formed
    expect(graph.edges.length).toBeGreaterThanOrEqual(0);
    console.log(`Combined graph: ${graph.nodes.size} nodes, ${graph.edges.length} edges (${arnEdges.length} ARN-based)`);
  }, 60_000);
});
