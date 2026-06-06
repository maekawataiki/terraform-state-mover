import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { generateOutputBlock, planOutputGeneration } from "./output-generator.js";
import type { CutEdge, DependencyGraph, GraphNode, GraphEdge } from "../types.js";

describe("output-generator", () => {
  describe("generateOutputBlock", () => {
    it("generates a valid output block", () => {
      const result = generateOutputBlock({
        name: "iam_role_lambda_exec_arn",
        value: "aws_iam_role.lambda_exec.arn",
        description: "ARN of aws_iam_role.lambda_exec for cross-repo consumption",
      });

      expect(result).toContain('output "iam_role_lambda_exec_arn"');
      expect(result).toContain("value       = aws_iam_role.lambda_exec.arn");
      expect(result).toContain('description = "ARN of aws_iam_role.lambda_exec for cross-repo consumption"');
      expect(result).toContain("}");
    });

    it("handles special characters in description", () => {
      const result = generateOutputBlock({
        name: "bucket_arn",
        value: "aws_s3_bucket.data.arn",
        description: "S3 bucket ARN for data pipeline",
      });

      expect(result).toContain('output "bucket_arn"');
      expect(result).toContain("aws_s3_bucket.data.arn");
    });
  });

  describe("planOutputGeneration", () => {
    let testDir: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ testDir, cleanup } = await setupTestDirectory());
    });

    afterEach(async () => {
      await cleanup();
    });

    it("generates outputs for cross-namespace referenced resources", async () => {
      const foundationDir = join(testDir, "foundation");
      await mkdir(foundationDir, { recursive: true });

      const nodes = new Map<string, GraphNode>([
        ["foundation:aws_iam_role.lambda_exec", {
          id: "foundation:aws_iam_role.lambda_exec",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "lambda_exec",
          repo: "foundation",
          filePath: join(foundationDir, "main.tf"),
          namespace: "foundation",
        }],
      ]);

      const edges: GraphEdge[] = [{
        from: "service-api:aws_lambda_function.api",
        to: "foundation:aws_iam_role.lambda_exec",
        type: "arn",
        label: "arn:aws:iam::123:role/lambda-exec",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([["foundation", foundationDir]]);

      const result = await planOutputGeneration({ graph, cutEdges, basePaths });

      expect(result.outputDeclarations).toHaveLength(1);
      expect(result.outputDeclarations[0].name).toContain("lambda_exec");
      expect(result.outputDeclarations[0].name).toContain("arn");
      expect(result.outputDeclarations[0].value).toContain("aws_iam_role.lambda_exec.arn");

      // Should create outputs.tf
      expect(result.fileWrites).toHaveLength(1);
      expect(result.fileWrites[0].filePath).toContain("outputs.tf");
      expect(result.fileWrites[0].operation).toBe("create");
      expect(result.fileWrites[0].content).toContain("output");
      expect(result.fileWrites[0].content).toContain("lambda_exec");
    });

    it("deduplicates outputs for the same resource", async () => {
      const foundationDir = join(testDir, "foundation");
      await mkdir(foundationDir, { recursive: true });

      const nodes = new Map<string, GraphNode>([
        ["foundation:aws_iam_role.shared", {
          id: "foundation:aws_iam_role.shared",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "shared",
          repo: "foundation",
          filePath: join(foundationDir, "main.tf"),
          namespace: "foundation",
        }],
      ]);

      const graph: DependencyGraph = { nodes, edges: [] };

      // Two services reference the same resource
      const cutEdges: CutEdge[] = [
        {
          edge: { from: "service-api:aws_lambda_function.api", to: "foundation:aws_iam_role.shared", type: "arn", label: "arn1" },
          fromNamespace: "service-api",
          toNamespace: "foundation",
          score: 1,
        },
        {
          edge: { from: "service-web:aws_lambda_function.web", to: "foundation:aws_iam_role.shared", type: "arn", label: "arn2" },
          fromNamespace: "service-web",
          toNamespace: "foundation",
          score: 1,
        },
      ];

      const basePaths = new Map([["foundation", foundationDir]]);

      const result = await planOutputGeneration({ graph, cutEdges, basePaths });

      // Should only generate one output despite two cut edges
      expect(result.outputDeclarations).toHaveLength(1);
    });

    it("appends to existing outputs.tf", async () => {
      const foundationDir = join(testDir, "foundation");
      await mkdir(foundationDir, { recursive: true });

      const existingOutputs = `output "vpc_id" {
  value = aws_vpc.main.id
}
`;
      await writeFile(join(foundationDir, "outputs.tf"), existingOutputs);

      const nodes = new Map<string, GraphNode>([
        ["foundation:aws_iam_role.api_role", {
          id: "foundation:aws_iam_role.api_role",
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_role",
          repo: "foundation",
          filePath: join(foundationDir, "roles.tf"),
          namespace: "foundation",
        }],
      ]);

      const graph: DependencyGraph = { nodes, edges: [] };
      const cutEdges: CutEdge[] = [{
        edge: { from: "a", to: "foundation:aws_iam_role.api_role", type: "arn" },
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([["foundation", foundationDir]]);

      const result = await planOutputGeneration({ graph, cutEdges, basePaths });

      expect(result.fileWrites[0].operation).toBe("modify");
      expect(result.fileWrites[0].content).toContain('output "vpc_id"');
      expect(result.fileWrites[0].content).toContain("# Outputs added by terraform-state-mover");
      expect(result.fileWrites[0].content).toContain("api_role");
    });

    it("returns empty when no cut edges", async () => {
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };
      const result = await planOutputGeneration({ graph, cutEdges: [], basePaths: new Map() });
      expect(result.outputDeclarations).toHaveLength(0);
      expect(result.fileWrites).toHaveLength(0);
    });

    it("skips when target node not found in graph", async () => {
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };
      const cutEdges: CutEdge[] = [{
        edge: { from: "a", to: "nonexistent:aws_iam_role.x", type: "arn" },
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const result = await planOutputGeneration({ graph, cutEdges, basePaths: new Map() });
      expect(result.outputDeclarations).toHaveLength(0);
    });
  });
});
