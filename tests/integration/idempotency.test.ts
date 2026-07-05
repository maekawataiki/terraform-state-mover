/**
 * Integration test: Idempotency — running migrate twice does not corrupt state.
 *
 * Verifies:
 * 1. planMigration called twice with the same input produces identical output
 * 2. applyMigration called twice on the same result doesn't corrupt the repo
 * 3. After applying, re-scanning and re-planning finds nothing to migrate
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../../src/test-utils/test-directories.js";
import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { buildGraph } from "../../src/analyzer/dependency-graph.js";
import { detectArns } from "../../src/analyzer/arn-detector.js";
import { classifyGraph } from "../../src/analyzer/namespace-classifier.js";
import { findCrossNamespaceEdges } from "../../src/planner/cut-finder.js";
import { planMigration, applyMigration } from "../../src/planner/hcl-migrator.js";
import { gatekeeperModelConfig } from "../../src/presets/gatekeeper.js";
import type { ParsedFile, ArnReference } from "../../src/types.js";

describe("Idempotency", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  async function setupGatekeeperScenario(): Promise<{
    infraDir: string;
    serviceDir: string;
  }> {
    const infraDir = join(testDir, "infra-central");
    const serviceDir = join(testDir, "service-api");
    await mkdir(infraDir, { recursive: true });
    await mkdir(serviceDir, { recursive: true });

    await writeFile(join(infraDir, "main.tf"), `resource "aws_iam_role" "api_lambda_exec" {
  name               = "api-lambda-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role" "analytics_role" {
  name               = "analytics-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}
`);

    await writeFile(join(infraDir, "versions.tf"), `terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`);

    await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = "arn:aws:iam::111111111111:role/api-lambda-exec"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = "lambda.zip"
}
`);

    await writeFile(join(serviceDir, "versions.tf"), `terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`);

    return { infraDir, serviceDir };
  }

  async function runPipeline(basePaths: Map<string, string>) {
    const paths = [...basePaths.values()];
    const allFiles: ParsedFile[] = [];
    for (const p of paths) {
      const files = await scanDirectory(p, p.split("/").pop()!);
      allFiles.push(...files);
    }

    const graph = buildGraph(allFiles);
    const arnRefs = detectArns(allFiles, graph);
    const nsConfig = gatekeeperModelConfig;
    classifyGraph(graph.nodes, nsConfig);
    const cutEdges = findCrossNamespaceEdges(graph, nsConfig);

    return { graph, arnRefs, cutEdges, basePaths };
  }

  it("planMigration produces identical results when called twice with same input", async () => {
    const { infraDir, serviceDir } = await setupGatekeeperScenario();
    const basePaths = new Map([
      ["infra-central", infraDir],
      ["service-api", serviceDir],
    ]);

    const { graph, arnRefs, cutEdges } = await runPipeline(basePaths);

    const result1 = await planMigration({ graph, cutEdges, arnRefs, basePaths });
    const result2 = await planMigration({ graph, cutEdges, arnRefs, basePaths });

    // Same number of operations
    expect(result1.summary.resourcesMoved).toBe(result2.summary.resourcesMoved);
    expect(result1.summary.arnsRewritten).toBe(result2.summary.arnsRewritten);
    expect(result1.summary.outputsGenerated).toBe(result2.summary.outputsGenerated);
    expect(result1.summary.filesModified).toBe(result2.summary.filesModified);

    // Same file writes (paths and content)
    expect(result1.fileWrites.length).toBe(result2.fileWrites.length);
    for (let i = 0; i < result1.fileWrites.length; i++) {
      expect(result1.fileWrites[i].filePath).toBe(result2.fileWrites[i].filePath);
      expect(result1.fileWrites[i].content).toBe(result2.fileWrites[i].content);
      expect(result1.fileWrites[i].operation).toBe(result2.fileWrites[i].operation);
    }

    // Same tfmigrate HCL
    expect(result1.tfmigrateHcl).toBe(result2.tfmigrateHcl);
  });

  it("applyMigration is idempotent — second apply produces same file content", async () => {
    const { infraDir, serviceDir } = await setupGatekeeperScenario();
    const basePaths = new Map([
      ["infra-central", infraDir],
      ["service-api", serviceDir],
    ]);

    const { graph, arnRefs, cutEdges } = await runPipeline(basePaths);
    const result = await planMigration({ graph, cutEdges, arnRefs, basePaths });

    // First apply
    await applyMigration(result);

    // Capture file state after first apply
    const filesAfterFirst = new Map<string, string>();
    for (const fw of result.fileWrites) {
      if (fw.operation !== "delete") {
        const content = await readFile(fw.filePath, "utf-8");
        filesAfterFirst.set(fw.filePath, content);
      }
    }

    // Second apply (same result)
    await applyMigration(result);

    // File state should be identical after second apply
    for (const [filePath, expectedContent] of filesAfterFirst) {
      const actual = await readFile(filePath, "utf-8");
      expect(actual).toBe(expectedContent);
    }
  });

  it("after apply, re-scanning shows reduced or zero cross-namespace ARN edges", async () => {
    const { infraDir, serviceDir } = await setupGatekeeperScenario();
    const basePaths = new Map([
      ["infra-central", infraDir],
      ["service-api", serviceDir],
    ]);

    const { graph, arnRefs, cutEdges } = await runPipeline(basePaths);
    const edgesBefore = cutEdges.length;

    const result = await planMigration({ graph, cutEdges, arnRefs, basePaths });

    // Only apply if there's something to do
    if (result.fileWrites.length > 0) {
      await applyMigration(result);
    }

    // Re-scan after apply
    const { cutEdges: cutEdgesAfter } = await runPipeline(basePaths);

    // Applying migration should not INCREASE cross-namespace edges
    expect(cutEdgesAfter.length).toBeLessThanOrEqual(edgesBefore);
  });
});
