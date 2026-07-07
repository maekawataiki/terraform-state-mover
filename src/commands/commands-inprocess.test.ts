import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { existsSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerPlanCommand } from "./plan.js";
import { registerVisualizeCommand } from "./visualize.js";
import { registerReportCommand } from "./report.js";
import { registerMigrateCommand } from "./migrate.js";
import { registerValidateCommand } from "./validate.js";

const OUTPUT_DIR = join(process.cwd(), "tmp/tests/commands-inprocess");

function createProgram(): Command {
  const program = new Command();
  program
    .name("tf-state-mover")
    .option("-o, --output-dir <dir>", "Output directory", OUTPUT_DIR)
    .option("--config <path>", "Path to .tf-mover.yaml config file")
    .option("--dry-run", "Dry run mode")
    .option("-v, --verbose", "Verbose output")
    .exitOverride() // Throw instead of process.exit
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  return program;
}

describe("commands (in-process)", () => {
  beforeEach(() => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  describe("plan command", () => {
    it("generates plan files", async () => {
      const program = createProgram();
      registerPlanCommand(program);
      await program.parseAsync([
        "node", "cli",
        "plan",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
        "examples/gatekeeper/service-app-analytics",
        "--state-dir", "examples/gatekeeper/state",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "plan.json"))).toBe(true);
      expect(existsSync(join(OUTPUT_DIR, "migrate.sh"))).toBe(true);
      expect(existsSync(join(OUTPUT_DIR, "migrate.hcl"))).toBe(true);
    });

    it("generates plan with namespace config file", async () => {
      const nsConfigPath = join(OUTPUT_DIR, "ns-config.json");
      const nsConfig = { groupByRepo: true };
      require("node:fs").writeFileSync(nsConfigPath, JSON.stringify(nsConfig));

      const program = createProgram();
      registerPlanCommand(program);
      await program.parseAsync([
        "node", "cli",
        "plan",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
        "-n", nsConfigPath,
      ]);
      expect(existsSync(join(OUTPUT_DIR, "plan.json"))).toBe(true);
    });

    it("throws on invalid directory", async () => {
      const program = createProgram();
      registerPlanCommand(program);
      await expect(program.parseAsync([
        "node", "cli", "plan", "/nonexistent/path",
      ])).rejects.toThrow();
    });
  });

  describe("visualize command", () => {
    it("generates DOT files with preset", async () => {
      const program = createProgram();
      registerVisualizeCommand(program);
      await program.parseAsync([
        "node", "cli",
        "visualize",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
        "examples/gatekeeper/service-app-analytics",
        "--preset", "gatekeeper",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "graph.dot"))).toBe(true);
      expect(existsSync(join(OUTPUT_DIR, "graph-before.dot"))).toBe(true);
      expect(existsSync(join(OUTPUT_DIR, "graph-after.dot"))).toBe(true);
    });

    it("generates DOT files with state-dir", async () => {
      const program = createProgram();
      registerVisualizeCommand(program);
      await program.parseAsync([
        "node", "cli",
        "visualize",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
        "--preset", "gatekeeper",
        "--state-dir", "examples/gatekeeper/state",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "graph.dot"))).toBe(true);
    });

    it("generates DOT without preset (uses config)", async () => {
      const program = createProgram();
      registerVisualizeCommand(program);
      await program.parseAsync([
        "node", "cli",
        "visualize",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "graph.dot"))).toBe(true);
    });

    it("throws on invalid directory", async () => {
      const program = createProgram();
      registerVisualizeCommand(program);
      await expect(program.parseAsync([
        "node", "cli", "visualize", "/nonexistent/path",
      ])).rejects.toThrow();
    });
  });

  describe("report command", () => {
    let graphJsonPath: string;

    beforeEach(async () => {
      // Generate graph.json first
      const { registerAnalyzeCommand } = await import("./analyze.js");
      const analyzeDir = join(OUTPUT_DIR, "analyze");
      const program = createProgram();
      program.opts().outputDir = analyzeDir;
      registerAnalyzeCommand(program);
      await program.parseAsync([
        "node", "cli",
        "analyze",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
        "examples/gatekeeper/service-app-analytics",
        "--preset", "gatekeeper",
        "--state-dir", "examples/gatekeeper/state",
        "-o", analyzeDir,
      ]);
      graphJsonPath = join(analyzeDir, "graph.json");
    });

    it("generates report from graph.json with preset", async () => {
      const reportDir = join(OUTPUT_DIR, "report");
      const program = createProgram();
      program.opts().outputDir = reportDir;
      registerReportCommand(program);
      await program.parseAsync([
        "node", "cli",
        "report", graphJsonPath,
        "--preset", "gatekeeper",
        "-o", reportDir,
      ]);
      expect(existsSync(join(reportDir, "report.md"))).toBe(true);
      const report = readFileSync(join(reportDir, "report.md"), "utf-8");
      expect(report).toContain("Diagnosis");
    });

    it("generates report without preset", async () => {
      const reportDir = join(OUTPUT_DIR, "report2");
      const program = createProgram();
      program.opts().outputDir = reportDir;
      registerReportCommand(program);
      await program.parseAsync([
        "node", "cli",
        "report", graphJsonPath,
        "-o", reportDir,
      ]);
      expect(existsSync(join(reportDir, "report.md"))).toBe(true);
    });

    it("throws on invalid file", async () => {
      const program = createProgram();
      registerReportCommand(program);
      await expect(program.parseAsync([
        "node", "cli", "report", "/nonexistent.json",
      ])).rejects.toThrow();
    });

    it("throws on malformed JSON", async () => {
      const badFile = join(OUTPUT_DIR, "bad.json");
      require("node:fs").writeFileSync(badFile, "not json");
      const program = createProgram();
      registerReportCommand(program);
      await expect(program.parseAsync([
        "node", "cli", "report", badFile,
      ])).rejects.toThrow();
    });
  });

  describe("validate command", () => {
    it("throws on invalid file", async () => {
      const program = createProgram();
      registerValidateCommand(program);
      await expect(program.parseAsync([
        "node", "cli", "validate", "/nonexistent.hcl",
      ])).rejects.toThrow();
    });

    it("throws when tfmigrate not found", async () => {
      const hclFile = join(OUTPUT_DIR, "test.hcl");
      require("node:fs").writeFileSync(hclFile, 'migration "state" "test" { actions = ["mv a b"] }');
      const program = createProgram();
      registerValidateCommand(program);
      await expect(program.parseAsync([
        "node", "cli", "validate", hclFile,
      ])).rejects.toThrow();
    });
  });

  describe("migrate command", () => {
    it("reports no cross-namespace dependencies for gatekeeper", async () => {
      const program = createProgram();
      registerMigrateCommand(program);
      // Gatekeeper examples have no graph edges, so no cross-namespace deps
      await program.parseAsync([
        "node", "cli",
        "migrate",
        "examples/gatekeeper/infra-central",
        "examples/gatekeeper/service-app-api",
        "examples/gatekeeper/service-app-analytics",
        "--preset", "gatekeeper",
        "--state-dir", "examples/gatekeeper/state",
      ]);
      // Should complete without error (prints "No cross-namespace dependencies")
    });

    it("generates migration for spaghetti example", async () => {
      const program = createProgram();
      registerMigrateCommand(program);
      await program.parseAsync([
        "node", "cli",
        "migrate",
        "examples/spaghetti/platform",
        "examples/spaghetti/network",
        "examples/spaghetti/services",
        "--preset", "spaghetti",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "migrate.hcl"))).toBe(true);
      expect(existsSync(join(OUTPUT_DIR, "migrate-plan.json"))).toBe(true);
    });

    it("supports --namespace filter with no matching edges", async () => {
      const program = createProgram();
      registerMigrateCommand(program);
      await program.parseAsync([
        "node", "cli",
        "migrate",
        "examples/spaghetti/platform",
        "examples/spaghetti/network",
        "examples/spaghetti/services",
        "--preset", "spaghetti",
        "--namespace", "nonexistent-ns",
      ]);
      // Should complete without error
    });

    it("supports --mode moved", async () => {
      const program = createProgram();
      registerMigrateCommand(program);
      await program.parseAsync([
        "node", "cli",
        "migrate",
        "examples/spaghetti/platform",
        "examples/spaghetti/network",
        "examples/spaghetti/services",
        "--preset", "spaghetti",
        "--mode", "moved",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "migrate-plan.json"))).toBe(true);
    });

    it("supports --mode tfmigrate", async () => {
      const program = createProgram();
      registerMigrateCommand(program);
      await program.parseAsync([
        "node", "cli",
        "migrate",
        "examples/spaghetti/platform",
        "examples/spaghetti/network",
        "examples/spaghetti/services",
        "--preset", "spaghetti",
        "--mode", "tfmigrate",
      ]);
      expect(existsSync(join(OUTPUT_DIR, "migrate-plan.json"))).toBe(true);
    });

    it("throws on invalid path", async () => {
      const program = createProgram();
      registerMigrateCommand(program);
      await expect(program.parseAsync([
        "node", "cli",
        "migrate", "/nonexistent/path",
        "--preset", "gatekeeper",
      ])).rejects.toThrow();
    });
  });
});
