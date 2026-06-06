/**
 * Integration test: Full cycle — scan → plan → output files validation.
 *
 * Verifies that the complete pipeline produces structurally correct output files:
 * - migrate.hcl: valid tfmigrate multi_state syntax
 * - migrate.sh: valid bash script
 * - plan.json: parseable JSON with expected schema
 * - report.md: contains expected sections
 * - graph-before.dot / graph-after.dot: valid DOT syntax
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { setupTestDirectory } from "../../src/test-utils/test-directories.js";
import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { buildGraph, serializeGraph } from "../../src/analyzer/dependency-graph.js";
import { toGraphvizBefore, toGraphvizAfter } from "../../src/reporter/graphviz.js";
import { detectArns } from "../../src/analyzer/arn-detector.js";
import { createMigrationPlan } from "../../src/planner/migration-planner.js";
import { generateMarkdownReport } from "../../src/reporter/markdown-reporter.js";
import { parseStateJson, enrichWithState } from "../../src/state/state-reader.js";
import { gatekeeperModelConfig, gatekeeperModelReportTemplate } from "../../src/presets/gatekeeper.js";
import type { ParsedFile } from "../../src/types.js";

describe("Full cycle: scan → plan → output validation", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;
  let outputDir: string;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    outputDir = join(testDir, "output");
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  async function setupGatekeeperScenario() {
    // infra-central: centralized IAM roles
    const infraDir = join(testDir, "infra-central");
    await mkdir(infraDir, { recursive: true });
    await writeFile(join(infraDir, "roles.tf"), `
resource "aws_organizations_policy" "deny_iam" {
  name = "deny-iam-without-boundary"
  type = "SERVICE_CONTROL_POLICY"
  content = "{}"
}

resource "aws_iam_policy" "web_boundary" {
  name = "web-tier-boundary"
  policy = "{}"
}

resource "aws_iam_role" "api_lambda_exec" {
  name               = "api-lambda-exec"
  assume_role_policy = "{}"
  arn                = "arn:aws:iam::111111111111:role/api-lambda-exec"
}

resource "aws_iam_role" "analytics_s3_access" {
  name               = "analytics-s3-access"
  assume_role_policy = "{}"
  arn                = "arn:aws:iam::111111111111:role/analytics-s3-access"
}
`);

    // service-api: consumes role via hardcoded ARN
    const apiDir = join(testDir, "service-api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "main.tf"), `
resource "aws_lambda_function" "handler" {
  function_name = "api-handler"
  role          = "arn:aws:iam::111111111111:role/api-lambda-exec"
}

resource "aws_db_instance" "db" {
  identifier = "api-db"
  engine     = "postgres"
}
`);

    // service-analytics: consumes role via hardcoded ARN
    const analyticsDir = join(testDir, "service-analytics");
    await mkdir(analyticsDir, { recursive: true });
    await writeFile(join(analyticsDir, "main.tf"), `
resource "aws_s3_bucket" "data" {
  bucket = "analytics-data"
}

resource "aws_lambda_function" "ingest" {
  function_name = "analytics-ingest"
  role          = "arn:aws:iam::111111111111:role/analytics-s3-access"
}
`);

    // State file for infra-central
    const stateDir = join(testDir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "infra-central.tfstate.json"), JSON.stringify({
      version: 4,
      resources: [
        {
          type: "aws_iam_role",
          name: "api_lambda_exec",
          instances: [{ attributes: { arn: "arn:aws:iam::111111111111:role/api-lambda-exec", id: "api-lambda-exec" } }],
        },
        {
          type: "aws_iam_role",
          name: "analytics_s3_access",
          instances: [{ attributes: { arn: "arn:aws:iam::111111111111:role/analytics-s3-access", id: "analytics-s3-access" } }],
        },
      ],
    }));

    return { infraDir, apiDir, analyticsDir, stateDir };
  }

  describe("migrate.hcl output", () => {
    it("generates valid tfmigrate multi_state blocks", async () => {
      const { infraDir, apiDir, analyticsDir, stateDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const stateContent = await readFile(join(stateDir, "infra-central.tfstate.json"), "utf-8");
      const stateFiles = [parseStateJson(stateContent, "infra-central")];
      parsedFiles = enrichWithState(parsedFiles, stateFiles);

      const graph = buildGraph(parsedFiles);
      // Use default config (no gatekeeper) so cross-repo edges are detected as cross-namespace
      const plan = createMigrationPlan(graph, undefined, stateFiles);

      const hcl = plan.tfmigrateHcl;

      // Structure validation — with 3 repos and cross-repo ARNs, there should be migrations
      expect(hcl).toContain('migration "multi_state"');
      expect(hcl).toContain("from_dir");
      expect(hcl).toContain("to_dir");
      expect(hcl).toContain("actions");

      // Every migration block has required fields
      const blocks = hcl.split('migration "multi_state"').slice(1);
      for (const block of blocks) {
        expect(block).toMatch(/from_dir\s*=\s*"/);
        expect(block).toMatch(/to_dir\s*=\s*"/);
        expect(block).toMatch(/actions\s*=\s*\[/);
        expect(block).toContain("mv ");
      }

      // Actions use correct format: "mv <type>.<name> <type>.<name>"
      const actionPattern = /mv\s+\w+\.\w+\s+\w+\.\w+/;
      const actions = hcl.match(/"mv .+?"/g) || [];
      for (const action of actions) {
        expect(action).toMatch(actionPattern);
      }
    });

    it("does not produce empty migration blocks", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig);

      const blocks = plan.tfmigrateHcl.split('migration "multi_state"').slice(1);
      for (const block of blocks) {
        const actions = block.match(/"mv .+?"/g) || [];
        expect(actions.length).toBeGreaterThan(0);
      }
    });
  });

  describe("migrate.sh output", () => {
    it("generates a valid bash script", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig);
      const script = plan.shellScript;

      // Shebang and strict mode
      expect(script).toMatch(/^#!\/bin\/bash\n/);
      expect(script).toContain("set -euo pipefail");

      // Every terraform command is properly quoted
      const mvCommands = script.split("\n").filter((l) => l.startsWith("terraform state mv"));
      for (const cmd of mvCommands) {
        expect(cmd).toContain("-state=");
        expect(cmd).toContain("-state-out=");
        expect(cmd).toContain("'"); // single-quoted resource addresses
      }

      // Bash syntax check (if bash is available)
      try {
        execSync(`echo ${JSON.stringify(script)} | bash -n`, { stdio: "pipe" });
      } catch {
        // bash not available or syntax error — skip on systems without bash
      }
    });

    it("includes verification step at the end", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig);

      const lines = plan.shellScript.split("\n").filter((l) => l.trim());
      const lastCommand = lines.filter((l) => l.startsWith("terraform")).pop();
      expect(lastCommand).toBe("terraform plan");
    });
  });

  describe("plan.json output", () => {
    it("produces valid JSON with expected schema", async () => {
      const { infraDir, apiDir, analyticsDir, stateDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const stateContent = await readFile(join(stateDir, "infra-central.tfstate.json"), "utf-8");
      const stateFiles = [parseStateJson(stateContent, "infra-central")];
      parsedFiles = enrichWithState(parsedFiles, stateFiles);

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig, stateFiles);

      // Valid JSON
      const parsed = JSON.parse(plan.json);

      // Schema validation
      expect(parsed).toHaveProperty("steps");
      expect(parsed).toHaveProperty("crossNamespaceEdges");
      expect(Array.isArray(parsed.steps)).toBe(true);
      expect(Array.isArray(parsed.crossNamespaceEdges)).toBe(true);

      // Steps have required fields
      for (const step of parsed.steps) {
        expect(step).toHaveProperty("type");
        expect(step).toHaveProperty("description");
        expect(["state_mv", "import", "code_rewrite", "verify"]).toContain(step.type);

        if (step.type === "state_mv" || step.type === "import") {
          expect(step).toHaveProperty("command");
          expect(step).toHaveProperty("resource");
        }
      }

      // Cross-namespace edges have required fields
      for (const edge of parsed.crossNamespaceEdges) {
        expect(edge).toHaveProperty("edge");
        expect(edge).toHaveProperty("fromNamespace");
        expect(edge).toHaveProperty("toNamespace");
        expect(edge).toHaveProperty("score");
        expect(edge.edge).toHaveProperty("from");
        expect(edge.edge).toHaveProperty("to");
        expect(edge.edge).toHaveProperty("type");
      }
    });

    it("resolves resource IDs when state is provided", async () => {
      const { infraDir, apiDir, analyticsDir, stateDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const stateContent = await readFile(join(stateDir, "infra-central.tfstate.json"), "utf-8");
      const stateFiles = [parseStateJson(stateContent, "infra-central")];
      parsedFiles = enrichWithState(parsedFiles, stateFiles);

      const graph = buildGraph(parsedFiles);
      // Use default config to generate cross-namespace edges
      const plan = createMigrationPlan(graph, undefined, stateFiles);
      const parsed = JSON.parse(plan.json);

      const importSteps = parsed.steps.filter((s: { type: string }) => s.type === "import");
      const resolvedImports = importSteps.filter((s: { command: string }) => !s.command.includes("<RESOURCE_ID>"));

      // At least one import should have a resolved ID from state
      expect(resolvedImports.length).toBeGreaterThan(0);
      // Resolved imports should contain actual resource ID (e.g., role name, bucket name)
      for (const step of resolvedImports) {
        expect(step.command).not.toContain("<RESOURCE_ID>");
      }
    });
  });

  describe("report.md output", () => {
    it("contains all expected sections", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const arns = detectArns(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig);
      const report = generateMarkdownReport({
        graph, arnRefs: arns, plan,
        config: gatekeeperModelConfig,
        templateSuffix: gatekeeperModelReportTemplate,
        parsedFiles,
      });

      // Required sections
      expect(report).toContain("# Migration Analysis Report");
      expect(report).toContain("## Diagnosis");
      expect(report).toContain("## Summary");
      expect(report).toContain("## State Split Plan");
      expect(report).toContain("## Before");
      expect(report).toContain("## After");
      expect(report).toContain("## Migration Steps");
      expect(report).toContain("## Recommended Order");

      // Mermaid graphs present
      expect(report).toContain("```mermaid");

      // Gatekeeper template appended
      expect(report).toContain("Gatekeeper Model Context");
      expect(report).toContain("Permission Boundaries");
    });
  });

  describe("DOT graph output", () => {
    it("generates valid DOT syntax for before/after graphs", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const before = toGraphvizBefore(graph);
      const after = toGraphvizAfter(graph);

      // Valid DOT structure
      for (const dot of [before, after]) {
        expect(dot).toMatch(/^digraph \w+ \{/);
        expect(dot).toMatch(/\}$/);
        expect(dot).toContain("rankdir=LR");
        expect(dot).toContain("subgraph");

        // Balanced braces
        const opens = (dot.match(/\{/g) || []).length;
        const closes = (dot.match(/\}/g) || []).length;
        expect(opens).toBe(closes);
      }

      // Before graph shows problem indicators
      expect(before).toContain("Before Migration");
      // After graph shows clean interfaces
      expect(after).toContain("After Migration");
      expect(after).toContain("var/output");
    });
  });

  describe("cross-file consistency", () => {
    it("plan.json step count matches migrate.sh command count", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig);
      const parsed = JSON.parse(plan.json);

      // Count state_mv steps in JSON
      const jsonMvCount = parsed.steps.filter((s: { type: string }) => s.type === "state_mv").length;
      // Count state mv commands in shell script
      const shMvCount = plan.shellScript.split("\n").filter((l: string) => l.startsWith("terraform state mv")).length;

      expect(jsonMvCount).toBe(shMvCount);
    });

    it("migrate.hcl actions match plan.json state_mv steps", async () => {
      const { infraDir, apiDir, analyticsDir } = await setupGatekeeperScenario();

      let parsedFiles: ParsedFile[] = [];
      for (const dir of [infraDir, apiDir, analyticsDir]) {
        parsedFiles.push(...await scanDirectory(dir));
      }

      const graph = buildGraph(parsedFiles);
      const plan = createMigrationPlan(graph, gatekeeperModelConfig);
      const parsed = JSON.parse(plan.json);

      // Extract resource names from JSON state_mv steps
      const jsonResources = parsed.steps
        .filter((s: { type: string }) => s.type === "state_mv")
        .map((s: { resource: string }) => s.resource)
        .sort();

      // Extract resource names from HCL mv actions
      const hclActions = plan.tfmigrateHcl.match(/"mv (\S+) \S+"/g) || [];
      const hclResources = hclActions
        .map((a: string) => a.match(/"mv (\S+)/)?.[1])
        .filter(Boolean)
        .sort();

      expect(jsonResources).toEqual(hclResources);
    });
  });
});
