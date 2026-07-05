import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import {
  resolvePresetConfig,
  loadStateDir,
  buildCommandContext,
  logParserWarnings,
  logUnresolvedReferences,
} from "./shared.js";
import type { ParsedFile, DependencyGraph } from "../types.js";

// ---------------------------------------------------------------------------
// resolvePresetConfig (pure, no I/O)
// ---------------------------------------------------------------------------

describe("resolvePresetConfig", () => {
  it("returns empty object when no preset given", () => {
    const result = resolvePresetConfig(undefined);
    expect(result).toEqual({});
  });

  it("returns config for gatekeeper preset", () => {
    const result = resolvePresetConfig("gatekeeper");
    expect(result.config).toBeDefined();
    expect(result.templateSuffix).toBeDefined();
  });

  it("returns config for terralith preset", () => {
    const result = resolvePresetConfig("terralith");
    expect(result.config).toBeDefined();
  });

  it("returns config for spaghetti preset", () => {
    const result = resolvePresetConfig("spaghetti");
    expect(result.config).toBeDefined();
  });

  it("returns config for cross-account preset", () => {
    const result = resolvePresetConfig("cross-account");
    expect(result.config).toBeDefined();
  });

  it("returns config for data-layer preset", () => {
    const result = resolvePresetConfig("data-layer");
    expect(result.config).toBeDefined();
  });

  it("throws CliError for unknown preset", () => {
    expect(() => resolvePresetConfig("nonexistent")).toThrow("Unknown preset");
    expect(() => resolvePresetConfig("nonexistent")).toThrow("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// loadStateDir
// ---------------------------------------------------------------------------

describe("loadStateDir", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("throws CliError when directory does not exist", async () => {
    const nonexistent = join(testDir, "not-here");
    await expect(loadStateDir(nonexistent)).rejects.toThrow("Directory not found");
  });

  it("returns empty array when directory has no .tfstate.json files", async () => {
    const stateDir = join(testDir, "states");
    await mkdir(stateDir);
    await writeFile(join(stateDir, "readme.txt"), "not a state file");
    const result = await loadStateDir(stateDir);
    expect(result).toEqual([]);
  });

  it("loads valid state files", async () => {
    const stateDir = join(testDir, "states");
    await mkdir(stateDir);
    const stateContent = JSON.stringify({
      version: 4,
      terraform_version: "1.7.0",
      serial: 1,
      lineage: "abc",
      outputs: {},
      resources: [{
        mode: "managed",
        type: "aws_instance",
        name: "main",
        provider: "provider[\"registry.terraform.io/hashicorp/aws\"]",
        instances: [{ attributes: { id: "i-12345", arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-12345" } }],
      }],
    });
    await writeFile(join(stateDir, "infra-central.tfstate.json"), stateContent);
    const result = await loadStateDir(stateDir);
    expect(result).toHaveLength(1);
  });

  it("throws CliError for invalid JSON in state file", async () => {
    const stateDir = join(testDir, "states");
    await mkdir(stateDir);
    await writeFile(join(stateDir, "bad.tfstate.json"), "not json {{{");
    await expect(loadStateDir(stateDir)).rejects.toThrow("Invalid JSON");
  });
});

// ---------------------------------------------------------------------------
// buildCommandContext
// ---------------------------------------------------------------------------

describe("buildCommandContext", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("throws CliError when path does not exist", async () => {
    const badPath = join(testDir, "nonexistent");
    await expect(buildCommandContext({ paths: [badPath] })).rejects.toThrow("Directory not found");
  });

  it("throws CliError when path is a file, not directory", async () => {
    const filePath = join(testDir, "file.txt");
    await writeFile(filePath, "content");
    await expect(buildCommandContext({ paths: [filePath] })).rejects.toThrow("Not a directory");
  });

  it("throws CliError for invalid preset", async () => {
    const repoDir = join(testDir, "repo");
    await mkdir(repoDir);
    await expect(buildCommandContext({ paths: [repoDir], preset: "bad-preset" })).rejects.toThrow("Unknown preset");
  });

  it("builds context from empty repo directory", async () => {
    const repoDir = join(testDir, "repo");
    await mkdir(repoDir);
    const ctx = await buildCommandContext({ paths: [repoDir] });
    expect(ctx.graph.nodes.size).toBe(0);
    expect(ctx.graph.edges).toHaveLength(0);
    expect(ctx.arnRefs).toHaveLength(0);
  });

  it("builds context from repo with .tf files", async () => {
    const repoDir = join(testDir, "service-api");
    await mkdir(repoDir);
    await writeFile(join(repoDir, "main.tf"), `
resource "aws_instance" "web" {
  ami           = "ami-123"
  instance_type = "t3.micro"
}

resource "aws_security_group" "web" {
  name = "web-sg"
}
`);
    const ctx = await buildCommandContext({ paths: [repoDir] });
    expect(ctx.graph.nodes.size).toBe(2);
    expect(ctx.parsedFiles).toHaveLength(1);
  });

  it("throws CliError when state-dir does not exist", async () => {
    const repoDir = join(testDir, "repo");
    await mkdir(repoDir);
    const badStateDir = join(testDir, "no-states");
    await expect(buildCommandContext({ paths: [repoDir], stateDir: badStateDir })).rejects.toThrow("Directory not found");
  });

  it("throws CliError when config file does not exist", async () => {
    const repoDir = join(testDir, "repo");
    await mkdir(repoDir);
    const badConfig = join(testDir, "no-config.yaml");
    await expect(buildCommandContext({ paths: [repoDir], configFile: badConfig })).rejects.toThrow("File not found");
  });

  it("accepts preset and applies namespace config", async () => {
    const repoDir = join(testDir, "infra-central");
    await mkdir(repoDir);
    await writeFile(join(repoDir, "main.tf"), `
resource "aws_iam_role" "api" {
  name = "api-role"
  assume_role_policy = "{}"
}
`);
    const ctx = await buildCommandContext({ paths: [repoDir], preset: "gatekeeper" });
    expect(ctx.nsConfig).toBeDefined();
    expect(ctx.templateSuffix).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// logParserWarnings (verify no crashes with various inputs)
// ---------------------------------------------------------------------------

describe("logParserWarnings", () => {
  it("handles empty warnings gracefully", () => {
    const files: ParsedFile[] = [{ filePath: "main.tf", repo: "r", blocks: [], warnings: [] }];
    expect(() => logParserWarnings(files)).not.toThrow();
  });

  it("handles files with no warnings field", () => {
    const files: ParsedFile[] = [{ filePath: "main.tf", repo: "r", blocks: [] }];
    expect(() => logParserWarnings(files)).not.toThrow();
  });

  it("handles multiple warnings without crashing", () => {
    const files: ParsedFile[] = [{
      filePath: "main.tf",
      repo: "r",
      blocks: [],
      warnings: Array.from({ length: 15 }, (_, i) => ({
        filePath: "main.tf",
        line: i + 1,
        message: `Warning ${i}`,
        severity: "warning" as const,
      })),
    }];
    expect(() => logParserWarnings(files)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// logUnresolvedReferences (verify no crashes)
// ---------------------------------------------------------------------------

describe("logUnresolvedReferences", () => {
  it("handles graph with no unresolved edges", () => {
    const graph: DependencyGraph = {
      nodes: new Map(),
      edges: [{ from: "a", to: "b", type: "reference" }],
    };
    expect(() => logUnresolvedReferences(graph)).not.toThrow();
  });

  it("handles graph with unresolved edges", () => {
    const graph: DependencyGraph = {
      nodes: new Map(),
      edges: [
        { from: "a", to: "b", type: "unresolved", label: "dynamic_index: data[local.type]" },
        { from: "c", to: "d", type: "unresolved", label: "computed_key: var.map[var.k]" },
      ],
    };
    expect(() => logUnresolvedReferences(graph)).not.toThrow();
  });
});
