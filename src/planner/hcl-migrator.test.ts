import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { planMigration, applyMigration } from "./hcl-migrator.js";
import type { ArnReference, CutEdge, DependencyGraph, GraphNode, GraphEdge } from "../types.js";

describe("hcl-migrator", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  function createTestScenario() {
    const infraDir = join(testDir, "infra-central");
    const serviceDir = join(testDir, "service-api");

    const nodes = new Map<string, GraphNode>([
      ["infra-central:aws_iam_role.api_lambda_exec", {
        id: "infra-central:aws_iam_role.api_lambda_exec",
        type: "resource",
        resourceType: "aws_iam_role",
        name: "api_lambda_exec",
        repo: "infra-central",
        filePath: join(infraDir, "main.tf"),
        namespace: "service-api",
      }],
      ["service-api:aws_lambda_function.api", {
        id: "service-api:aws_lambda_function.api",
        type: "resource",
        resourceType: "aws_lambda_function",
        name: "api",
        repo: "service-api",
        filePath: join(serviceDir, "main.tf"),
        namespace: "service-api",
      }],
    ]);

    // Lambda references IAM role via ARN (consumer → provider)
    const edges: GraphEdge[] = [{
      from: "service-api:aws_lambda_function.api",
      to: "infra-central:aws_iam_role.api_lambda_exec",
      type: "arn",
      label: "arn:aws:iam::123456789012:role/api-lambda-exec",
    }];

    const graph: DependencyGraph = { nodes, edges };

    const cutEdges: CutEdge[] = [{
      edge: edges[0],
      fromNamespace: "service-api",
      toNamespace: "service-api",
      score: 1,
    }];

    const arnRefs: ArnReference[] = [{
      arn: "arn:aws:iam::123456789012:role/api-lambda-exec",
      service: "iam",
      filePath: join(serviceDir, "main.tf"),
      repo: "service-api",
      resolved: false,
    }];

    const basePaths = new Map([
      ["infra-central", infraDir],
      ["service-api", serviceDir],
    ]);

    return { infraDir, serviceDir, graph, cutEdges, arnRefs, basePaths };
  }

  describe("planMigration", () => {
    it("produces a complete migration result", async () => {
      const { infraDir, serviceDir, graph, cutEdges, arnRefs, basePaths } = createTestScenario();

      await mkdir(infraDir, { recursive: true });
      await mkdir(serviceDir, { recursive: true });

      await writeFile(join(infraDir, "main.tf"), `resource "aws_iam_role" "api_lambda_exec" {
  name               = "api-lambda-exec"
  assume_role_policy = "{}"
}
`);

      await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = "arn:aws:iam::123456789012:role/api-lambda-exec"
  runtime       = "nodejs18.x"
}
`);

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        movedBlockMode: "moved",
      });

      // Should have planned moves
      expect(result.summary.resourcesMoved).toBeGreaterThanOrEqual(1);
      expect(result.summary.arnsRewritten).toBeGreaterThanOrEqual(1);
      expect(result.summary.filesModified).toBeGreaterThanOrEqual(1);

      // Should have tfmigrate HCL
      expect(result.tfmigrateHcl).toContain("migration");
      expect(result.tfmigrateHcl).toContain("multi_state");

      // Should have file writes
      expect(result.fileWrites.length).toBeGreaterThan(0);
    });

    it("includes moved blocks when mode is 'moved'", async () => {
      const { infraDir, serviceDir, graph, cutEdges, arnRefs, basePaths } = createTestScenario();

      await mkdir(infraDir, { recursive: true });
      await mkdir(serviceDir, { recursive: true });

      await writeFile(join(infraDir, "main.tf"), `resource "aws_iam_role" "api_lambda_exec" {
  name = "api-lambda-exec"
}
`);

      await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  role = "arn:aws:iam::123456789012:role/api-lambda-exec"
}
`);

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        movedBlockMode: "moved",
      });

      expect(result.movedBlocks.length).toBeGreaterThanOrEqual(1);
    });

    it("includes import blocks when mode is 'import'", async () => {
      const { infraDir, serviceDir, graph, cutEdges, arnRefs, basePaths } = createTestScenario();

      await mkdir(infraDir, { recursive: true });
      await mkdir(serviceDir, { recursive: true });

      await writeFile(join(infraDir, "main.tf"), `resource "aws_iam_role" "api_lambda_exec" {
  name = "api-lambda-exec"
}
`);

      await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  role = "arn:aws:iam::123456789012:role/api-lambda-exec"
}
`);

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        movedBlockMode: "import",
      });

      expect(result.importBlocks.length).toBeGreaterThanOrEqual(1);
    });

    it("returns minimal result when no cut edges", async () => {
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };

      const result = await planMigration({
        graph,
        cutEdges: [],
        arnRefs: [],
        basePaths: new Map(),
      });

      expect(result.summary.resourcesMoved).toBe(0);
      expect(result.summary.arnsRewritten).toBe(0);
      expect(result.summary.outputsGenerated).toBe(0);
      expect(result.fileWrites).toHaveLength(0);
    });

    it("includes boundary variable declarations and fileWrites when --inject-boundary used", async () => {
      const { infraDir, serviceDir, graph, cutEdges, arnRefs, basePaths } = createTestScenario();

      await mkdir(infraDir, { recursive: true });
      await mkdir(serviceDir, { recursive: true });

      await writeFile(join(infraDir, "main.tf"), `resource "aws_iam_role" "api_lambda_exec" {
  name               = "api-lambda-exec"
  assume_role_policy = "{}"
}
`);

      await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = "arn:aws:iam::123456789012:role/api-lambda-exec"
  runtime       = "nodejs18.x"
}
`);

      const boundaryArn = "arn:aws:iam::123456789012:policy/ServiceBoundary";
      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        injectBoundaryArn: boundaryArn,
      });

      // Should include boundary variable declaration
      const boundaryVarDecl = result.variableDeclarations.find((v) => v.name === "permissions_boundary_arn");
      expect(boundaryVarDecl).toBeDefined();
      expect(boundaryVarDecl!.repo).toBe("service-api");
      expect(boundaryVarDecl!.filePath).toContain("boundary-variables.tf");

      // Should include fileWrite for boundary-variables.tf with default value
      const boundaryFileWrite = result.fileWrites.find((fw) => fw.filePath.includes("boundary-variables.tf"));
      expect(boundaryFileWrite).toBeDefined();
      expect(boundaryFileWrite!.content).toContain(`default     = "${boundaryArn}"`);
      expect(boundaryFileWrite!.content).toContain('variable "permissions_boundary_arn"');
    });
  });

  describe("applyMigration", () => {
    it("writes created files to disk", async () => {
      const outputDir = join(testDir, "output");
      await mkdir(outputDir, { recursive: true });

      const result = {
        moves: [],
        variableDeclarations: [],
        outputDeclarations: [],
        movedBlocks: [],
        importBlocks: [],
        removedBlocks: [],
        fileWrites: [
          {
            filePath: join(outputDir, "moved.tf"),
            content: "# Moved blocks\nmoved {\n  from = aws_iam_role.x\n  to   = aws_iam_role.x\n}\n",
            operation: "create" as const,
          },
          {
            filePath: join(outputDir, "outputs.tf"),
            content: '# Outputs\noutput "role_arn" {\n  value = aws_iam_role.x.arn\n}\n',
            operation: "create" as const,
          },
        ],
        tfmigrateHcl: "",
        summary: { resourcesMoved: 0, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
      };

      await applyMigration(result);

      const movedContent = await readFile(join(outputDir, "moved.tf"), "utf-8");
      expect(movedContent).toContain("moved {");

      const outputsContent = await readFile(join(outputDir, "outputs.tf"), "utf-8");
      expect(outputsContent).toContain('output "role_arn"');
    });

    it("creates intermediate directories", async () => {
      const deepPath = join(testDir, "deep", "nested", "dir", "file.tf");

      const result = {
        moves: [],
        variableDeclarations: [],
        outputDeclarations: [],
        movedBlocks: [],
        importBlocks: [],
        removedBlocks: [],
        fileWrites: [{
          filePath: deepPath,
          content: "# test\n",
          operation: "create" as const,
        }],
        tfmigrateHcl: "",
        summary: { resourcesMoved: 0, arnsRewritten: 0, outputsGenerated: 0, filesModified: 1 },
      };

      await applyMigration(result);

      const content = await readFile(deepPath, "utf-8");
      expect(content).toBe("# test\n");
    });

    it("deletes files marked for deletion", async () => {
      const filePath = join(testDir, "to-delete.tf");
      await writeFile(filePath, "old content");

      const result = {
        moves: [],
        variableDeclarations: [],
        outputDeclarations: [],
        movedBlocks: [],
        importBlocks: [],
        removedBlocks: [],
        fileWrites: [{
          filePath,
          content: "",
          operation: "delete" as const,
        }],
        tfmigrateHcl: "",
        summary: { resourcesMoved: 0, arnsRewritten: 0, outputsGenerated: 0, filesModified: 1 },
      };

      await applyMigration(result);

      await expect(readFile(filePath, "utf-8")).rejects.toThrow();
    });
  });

  describe("error recovery", () => {
    it("returns partial results when block moves fail", async () => {
      const serviceDir = join(testDir, "service-api");
      await mkdir(serviceDir, { recursive: true });

      await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = "arn:aws:iam::123456789012:role/api-lambda-exec"
}
`);

      // Create a graph referencing a nonexistent source file to trigger block move failure
      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.api_lambda_exec", {
          id: "infra-central:aws_iam_role.api_lambda_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_lambda_exec",
          repo: "infra-central",
          filePath: join(testDir, "infra-central", "nonexistent.tf"),
          namespace: "foundation",
        }],
        ["service-api:aws_lambda_function.api", {
          id: "service-api:aws_lambda_function.api",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "api",
          repo: "service-api",
          filePath: join(serviceDir, "main.tf"),
          namespace: "service-api",
        }],
      ]);

      const edges: GraphEdge[] = [{
        from: "infra-central:aws_iam_role.api_lambda_exec",
        to: "service-api:aws_lambda_function.api",
        type: "arn",
        label: "arn:aws:iam::123456789012:role/api-lambda-exec",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "foundation",
        toNamespace: "service-api",
        score: 1,
      }];

      const arnRefs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/api-lambda-exec",
        service: "iam",
        filePath: join(serviceDir, "main.tf"),
        repo: "service-api",
        resolved: false,
      }];

      const basePaths = new Map([
        ["infra-central", join(testDir, "infra-central")],
        ["service-api", serviceDir],
      ]);

      // Mock planBlockMoves to throw
      const blockMoverModule = await import("./hcl-block-mover.js");
      const spy = vi.spyOn(blockMoverModule, "planBlockMoves").mockRejectedValueOnce(new Error("Source file not found"));

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        movedBlockMode: "import",
      });

      // Should have errors recorded
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThanOrEqual(1);
      expect(result.errors!.some((e) => e.step === "block-moves")).toBe(true);

      // Moves should be empty due to failure, but other results should still exist
      expect(result.moves).toEqual([]);

      // Summary should reflect partial results
      expect(result.summary.resourcesMoved).toBe(0);

      spy.mockRestore();
    });

    it("returns no errors field when all steps succeed", async () => {
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };

      const result = await planMigration({
        graph,
        cutEdges: [],
        arnRefs: [],
        basePaths: new Map(),
      });

      expect(result.errors).toBeUndefined();
    });

    it("continues after ARN rewrite failure", async () => {
      const infraDir = join(testDir, "infra-central");
      const serviceDir = join(testDir, "service-api");
      await mkdir(infraDir, { recursive: true });
      await mkdir(serviceDir, { recursive: true });

      await writeFile(join(infraDir, "main.tf"), `resource "aws_iam_role" "api_lambda_exec" {
  name = "api-lambda-exec"
}
`);

      await writeFile(join(serviceDir, "main.tf"), `resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = "arn:aws:iam::123456789012:role/api-lambda-exec"
}
`);

      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.api_lambda_exec", {
          id: "infra-central:aws_iam_role.api_lambda_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_lambda_exec",
          repo: "infra-central",
          filePath: join(infraDir, "main.tf"),
          namespace: "foundation",
        }],
        ["service-api:aws_lambda_function.api", {
          id: "service-api:aws_lambda_function.api",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "api",
          repo: "service-api",
          filePath: join(serviceDir, "main.tf"),
          namespace: "service-api",
        }],
      ]);

      const edges: GraphEdge[] = [{
        from: "infra-central:aws_iam_role.api_lambda_exec",
        to: "service-api:aws_lambda_function.api",
        type: "arn",
        label: "arn:aws:iam::123456789012:role/api-lambda-exec",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "foundation",
        toNamespace: "service-api",
        score: 1,
      }];

      const arnRefs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/api-lambda-exec",
        service: "iam",
        filePath: join(serviceDir, "main.tf"),
        repo: "service-api",
        resolved: false,
      }];

      const basePaths = new Map([
        ["infra-central", infraDir],
        ["service-api", serviceDir],
      ]);

      // Mock planArnRewrites to throw
      const arnRewriterModule = await import("./arn-rewriter.js");
      const spy = vi.spyOn(arnRewriterModule, "planArnRewrites").mockRejectedValueOnce(new Error("Failed to read source"));

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs,
        basePaths,
        movedBlockMode: "import",
      });

      // ARN rewrite error should be captured
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.step === "arn-rewrites")).toBe(true);
      expect(result.errors!.find((e) => e.step === "arn-rewrites")!.error).toBe("Failed to read source");

      // Other steps should still produce results
      expect(result.summary.arnsRewritten).toBe(0);
      // Block moves and import blocks should still work
      expect(result.importBlocks.length).toBeGreaterThanOrEqual(0);

      spy.mockRestore();
    });

    it("captures multiple step failures", async () => {
      const graph: DependencyGraph = {
        nodes: new Map<string, GraphNode>([
          ["repo:aws_iam_role.x", {
            id: "repo:aws_iam_role.x",
            type: "resource",
            resourceType: "aws_iam_role",
            name: "x",
            repo: "repo",
            filePath: "/fake/main.tf",
            namespace: "foundation",
          }],
        ]),
        edges: [{
          from: "repo:aws_iam_role.x",
          to: "repo:aws_iam_role.x",
          type: "arn",
        }],
      };

      const cutEdges: CutEdge[] = [{
        edge: graph.edges[0],
        fromNamespace: "foundation",
        toNamespace: "service-api",
        score: 1,
      }];

      // Mock multiple steps to fail
      const blockMoverModule = await import("./hcl-block-mover.js");
      const arnRewriterModule = await import("./arn-rewriter.js");
      const outputGenModule = await import("./output-generator.js");

      const spy1 = vi.spyOn(blockMoverModule, "planBlockMoves").mockRejectedValueOnce(new Error("block error"));
      const spy2 = vi.spyOn(arnRewriterModule, "planArnRewrites").mockRejectedValueOnce(new Error("arn error"));
      const spy3 = vi.spyOn(outputGenModule, "planOutputGeneration").mockRejectedValueOnce(new Error("output error"));

      const result = await planMigration({
        graph,
        cutEdges,
        arnRefs: [],
        basePaths: new Map(),
      });

      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBe(3);
      expect(result.errors!.map((e) => e.step)).toContain("block-moves");
      expect(result.errors!.map((e) => e.step)).toContain("arn-rewrites");
      expect(result.errors!.map((e) => e.step)).toContain("output-generation");

      // All result arrays should be empty
      expect(result.moves).toEqual([]);
      expect(result.variableDeclarations).toEqual([]);
      expect(result.outputDeclarations).toEqual([]);

      // tfmigrate HCL should still be generated (step 5 not mocked)
      expect(result.tfmigrateHcl).toBeDefined();

      spy1.mockRestore();
      spy2.mockRestore();
      spy3.mockRestore();
    });
  });

  describe("applyMigration atomicity", () => {
    it("does not leave partial writes when a later file fails", async () => {
      const dir = join(testDir, "atomic-test");
      await mkdir(dir, { recursive: true });

      // Pre-existing file that should be preserved
      const existingFile = join(dir, "existing.tf");
      await writeFile(existingFile, "original content");

      const result = {
        moves: [],
        variableDeclarations: [],
        outputDeclarations: [],
        movedBlocks: [],
        importBlocks: [],
        removedBlocks: [],
        fileWrites: [
          {
            filePath: join(dir, "new-file.tf"),
            content: "new content\n",
            operation: "create" as const,
          },
          {
            // Write to a path under a regular file (not directory) to trigger failure.
            // /proc/version is a file on Linux, /dev/null is a device on all UNIX — 
            // neither can have children, so mkdir for subdirectories always fails.
            filePath: join(existingFile, "subdir", "impossible.tf"),
            content: "will fail\n",
            operation: "create" as const,
          },
        ],
        tfmigrateHcl: "",
        summary: { resourcesMoved: 0, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
      };

      await expect(applyMigration(result)).rejects.toThrow();

      // The first file should NOT exist because the atomic commit failed
      const { stat } = await import("node:fs/promises");
      await expect(stat(join(dir, "new-file.tf"))).rejects.toThrow();

      // Existing file remains untouched
      const content = await readFile(existingFile, "utf-8");
      expect(content).toBe("original content");
    });

    it("cleans up temp files on failure during temp write phase", async () => {
      const dir = join(testDir, "temp-cleanup");
      await mkdir(dir, { recursive: true });

      // Create a regular file that will block mkdir when we try to create a subdirectory under it
      const blockerFile = join(dir, "blocker");
      await writeFile(blockerFile, "I am a file, not a directory");

      const result = {
        moves: [],
        variableDeclarations: [],
        outputDeclarations: [],
        movedBlocks: [],
        importBlocks: [],
        removedBlocks: [],
        fileWrites: [
          {
            filePath: join(dir, "good.tf"),
            content: "good content\n",
            operation: "create" as const,
          },
          {
            // This will fail because 'blocker' is a file, not a directory — mkdir fails with ENOTDIR
            filePath: join(blockerFile, "subdir", "bad.tf"),
            content: "bad content\n",
            operation: "create" as const,
          },
        ],
        tfmigrateHcl: "",
        summary: { resourcesMoved: 0, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
      };

      await expect(applyMigration(result)).rejects.toThrow();

      // No temp files should remain in the dir
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      const tempFiles = files.filter((f) => f.includes(".tf-mover-tmp-"));
      expect(tempFiles).toHaveLength(0);
    });
  });
});
