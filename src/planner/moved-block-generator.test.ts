import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { generateMovedBlockHcl, generateImportBlockHcl, generateRemovedBlockHcl, planMovedBlocks } from "./moved-block-generator.js";
import type { CutEdge, DependencyGraph, GraphNode, GraphEdge } from "../types.js";

describe("moved-block-generator", () => {
  describe("generateMovedBlockHcl", () => {
    it("generates a valid moved block", () => {
      const result = generateMovedBlockHcl({
        from: "aws_iam_role.lambda_exec",
        to: "aws_iam_role.lambda_exec",
      });

      expect(result).toContain("moved {");
      expect(result).toContain("from = aws_iam_role.lambda_exec");
      expect(result).toContain("to   = aws_iam_role.lambda_exec");
      expect(result).toContain("}");
    });

    it("supports different from/to addresses", () => {
      const result = generateMovedBlockHcl({
        from: "module.old.aws_iam_role.exec",
        to: "aws_iam_role.exec",
      });

      expect(result).toContain("from = module.old.aws_iam_role.exec");
      expect(result).toContain("to   = aws_iam_role.exec");
    });
  });

  describe("generateImportBlockHcl", () => {
    it("generates a valid import block", () => {
      const result = generateImportBlockHcl({
        to: "aws_iam_role.lambda_exec",
        id: "arn:aws:iam::123456789012:role/lambda-exec",
      });

      expect(result).toContain("import {");
      expect(result).toContain("to = aws_iam_role.lambda_exec");
      expect(result).toContain('id = "arn:aws:iam::123456789012:role/lambda-exec"');
      expect(result).toContain("}");
    });

    it("includes provider when specified", () => {
      const result = generateImportBlockHcl({
        to: "aws_iam_role.cross_account",
        id: "arn:aws:iam::999:role/cross",
        provider: "aws.secondary",
      });

      expect(result).toContain("provider = aws.secondary");
    });

    it("omits provider line when not specified", () => {
      const result = generateImportBlockHcl({
        to: "aws_s3_bucket.data",
        id: "my-bucket",
      });

      expect(result).not.toContain("provider");
    });
  });

  describe("generateRemovedBlockHcl", () => {
    it("generates a removed block with destroy = false", () => {
      const result = generateRemovedBlockHcl({
        from: "aws_iam_role.api_exec",
        destroy: false,
      });

      expect(result).toContain("removed {");
      expect(result).toContain("from = aws_iam_role.api_exec");
      expect(result).toContain("lifecycle {");
      expect(result).toContain("destroy = false");
    });

    it("defaults destroy to false", () => {
      const result = generateRemovedBlockHcl({ from: "aws_s3_bucket.data" });
      expect(result).toContain("destroy = false");
    });

    it("supports destroy = true", () => {
      const result = generateRemovedBlockHcl({ from: "aws_s3_bucket.temp", destroy: true });
      expect(result).toContain("destroy = true");
    });
  });

  describe("planMovedBlocks", () => {
    let testDir: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ testDir, cleanup } = await setupTestDirectory());
    });

    afterEach(async () => {
      await cleanup();
    });

    it("generates moved blocks in 'moved' mode", async () => {
      const targetDir = join(testDir, "service-api");
      await mkdir(targetDir, { recursive: true });

      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.api_exec", {
          id: "infra-central:aws_iam_role.api_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_exec",
          repo: "infra-central",
          filePath: "main.tf",
          namespace: "foundation",
        }],
        ["service-api:aws_lambda_function.api", {
          id: "service-api:aws_lambda_function.api",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "api",
          repo: "service-api",
          filePath: "main.tf",
          namespace: "service-api",
        }],
      ]);

      // Lambda references IAM role via ARN (consumer → provider)
      const edges: GraphEdge[] = [{
        from: "service-api:aws_lambda_function.api",
        to: "infra-central:aws_iam_role.api_exec",
        type: "arn",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([["service-api", targetDir]]);

      const result = planMovedBlocks({ graph, cutEdges, basePaths, mode: "moved" });

      expect(result.movedBlocks).toHaveLength(1);
      expect(result.movedBlocks[0].from).toBe("aws_iam_role.api_exec");
      expect(result.movedBlocks[0].to).toBe("aws_iam_role.api_exec");
      expect(result.movedBlocks[0].repo).toBe("service-api");

      expect(result.importBlocks).toHaveLength(0);
      expect(result.removedBlocks).toHaveLength(0);

      expect(result.fileWrites).toHaveLength(1);
      expect(result.fileWrites[0].filePath).toContain("moved.tf");
      expect(result.fileWrites[0].content).toContain("moved {");
    });

    it("generates import + removed blocks in 'import' mode (cross-state)", async () => {
      const sourceDir = join(testDir, "infra-central");
      const targetDir = join(testDir, "service-api");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });

      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.api_exec", {
          id: "infra-central:aws_iam_role.api_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_exec",
          repo: "infra-central",
          filePath: "main.tf",
          namespace: "foundation",
        }],
        ["service-api:aws_lambda_function.api", {
          id: "service-api:aws_lambda_function.api",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "api",
          repo: "service-api",
          filePath: "main.tf",
          namespace: "service-api",
        }],
      ]);

      const edges: GraphEdge[] = [{
        from: "service-api:aws_lambda_function.api",
        to: "infra-central:aws_iam_role.api_exec",
        type: "arn",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([
        ["infra-central", sourceDir],
        ["service-api", targetDir],
      ]);

      const result = planMovedBlocks({ graph, cutEdges, basePaths, mode: "import" });

      // Import block in target
      expect(result.importBlocks).toHaveLength(1);
      expect(result.importBlocks[0].to).toBe("aws_iam_role.api_exec");
      expect(result.importBlocks[0].repo).toBe("service-api");

      // Removed block in source
      expect(result.removedBlocks).toHaveLength(1);
      expect(result.removedBlocks[0].from).toBe("aws_iam_role.api_exec");
      expect(result.removedBlocks[0].repo).toBe("infra-central");
      expect(result.removedBlocks[0].destroy).toBe(false);

      expect(result.movedBlocks).toHaveLength(0);

      // File writes: imports.tf in target + removed.tf in source
      expect(result.fileWrites).toHaveLength(2);
      const importFile = result.fileWrites.find((fw) => fw.filePath.includes("imports.tf"));
      const removedFile = result.fileWrites.find((fw) => fw.filePath.includes("removed.tf"));

      expect(importFile).toBeDefined();
      expect(importFile!.content).toContain("import {");
      expect(importFile!.filePath).toContain("service-api");

      expect(removedFile).toBeDefined();
      expect(removedFile!.content).toContain("removed {");
      expect(removedFile!.content).toContain("destroy = false");
      expect(removedFile!.filePath).toContain("infra-central");
    });

    it("returns empty results in 'tfmigrate' mode", async () => {
      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.api_exec", {
          id: "infra-central:aws_iam_role.api_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_exec",
          repo: "infra-central",
          filePath: "main.tf",
        }],
      ]);

      const graph: DependencyGraph = { nodes, edges: [] };

      const cutEdges: CutEdge[] = [{
        edge: { from: "infra-central:aws_iam_role.api_exec", to: "b", type: "arn" },
        fromNamespace: "foundation",
        toNamespace: "service-api",
        score: 1,
      }];

      const result = planMovedBlocks({ graph, cutEdges, basePaths: new Map(), mode: "tfmigrate" });

      expect(result.movedBlocks).toHaveLength(0);
      expect(result.importBlocks).toHaveLength(0);
      expect(result.removedBlocks).toHaveLength(0);
      expect(result.fileWrites).toHaveLength(0);
    });

    it("resolves resource ID from state files", async () => {
      const targetDir = join(testDir, "service-api");
      const sourceDir = join(testDir, "infra-central");
      await mkdir(targetDir, { recursive: true });
      await mkdir(sourceDir, { recursive: true });

      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.api_exec", {
          id: "infra-central:aws_iam_role.api_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_exec",
          repo: "infra-central",
          filePath: "main.tf",
        }],
        ["service-api:aws_lambda_function.api", {
          id: "service-api:aws_lambda_function.api",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "api",
          repo: "service-api",
          filePath: "main.tf",
        }],
      ]);

      const edges: GraphEdge[] = [{
        from: "service-api:aws_lambda_function.api",
        to: "infra-central:aws_iam_role.api_exec",
        type: "arn",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([
        ["infra-central", sourceDir],
        ["service-api", targetDir],
      ]);

      const stateFiles = [{
        repo: "infra-central",
        resources: [{
          address: "aws_iam_role.api_exec",
          type: "aws_iam_role",
          name: "api_exec",
          arn: "arn:aws:iam::123456789012:role/api-exec-role",
          attributes: { id: "api-exec-role" },
        }],
      }];

      const result = planMovedBlocks({ graph, cutEdges, basePaths, stateFiles, mode: "import" });

      expect(result.importBlocks[0].id).toBe("api-exec-role");
    });

    it("deduplicates resources across multiple cut edges", async () => {
      const targetDir = join(testDir, "service-api");
      await mkdir(targetDir, { recursive: true });

      const nodes = new Map<string, GraphNode>([
        ["infra-central:aws_iam_role.shared", {
          id: "infra-central:aws_iam_role.shared",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "shared",
          repo: "infra-central",
          filePath: "main.tf",
        }],
        ["service-api:aws_lambda_function.a", {
          id: "service-api:aws_lambda_function.a",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "a",
          repo: "service-api",
          filePath: "main.tf",
        }],
        ["service-api:aws_lambda_function.b", {
          id: "service-api:aws_lambda_function.b",
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "b",
          repo: "service-api",
          filePath: "main.tf",
        }],
      ]);

      const edges: GraphEdge[] = [
        { from: "service-api:aws_lambda_function.a", to: "infra-central:aws_iam_role.shared", type: "arn" },
        { from: "service-api:aws_lambda_function.b", to: "infra-central:aws_iam_role.shared", type: "arn" },
      ];

      const graph: DependencyGraph = { nodes, edges };

      // Same resource referenced by two cut edges
      const cutEdges: CutEdge[] = [
        { edge: edges[0], fromNamespace: "service-api", toNamespace: "foundation", score: 1 },
        { edge: edges[1], fromNamespace: "service-api", toNamespace: "foundation", score: 1 },
      ];

      const basePaths = new Map([["service-api", targetDir]]);

      const result = planMovedBlocks({ graph, cutEdges, basePaths, mode: "moved" });

      // Should only produce one moved block
      expect(result.movedBlocks).toHaveLength(1);
    });
  });
});
