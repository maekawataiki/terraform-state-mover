import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { findCrossNamespaceArns, arnToVarName, planArnRewrites } from "./arn-rewriter.js";
import type { ArnReference, CutEdge, DependencyGraph, GraphEdge, GraphNode } from "../types.js";

describe("arn-rewriter", () => {
  describe("findCrossNamespaceArns", () => {
    it("returns ARNs that match cut edge labels", () => {
      const arnRefs: ArnReference[] = [
        { arn: "arn:aws:iam::123:role/ApiRole", service: "iam", filePath: "main.tf", repo: "service-api", resolved: false },
        { arn: "arn:aws:s3:::my-bucket", service: "s3", filePath: "main.tf", repo: "service-api", resolved: false },
        { arn: "arn:aws:iam::123:role/OtherRole", service: "iam", filePath: "other.tf", repo: "service-api", resolved: false },
      ];

      const cutEdges: CutEdge[] = [{
        edge: { from: "a", to: "b", type: "arn", label: "arn:aws:iam::123:role/ApiRole" },
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const result = findCrossNamespaceArns({ cutEdges, arnRefs });
      expect(result).toHaveLength(1);
      expect(result[0].arn).toBe("arn:aws:iam::123:role/ApiRole");
    });

    it("returns empty when no ARN-type cut edges", () => {
      const arnRefs: ArnReference[] = [
        { arn: "arn:aws:iam::123:role/ApiRole", service: "iam", filePath: "main.tf", repo: "repo", resolved: false },
      ];

      const cutEdges: CutEdge[] = [{
        edge: { from: "a", to: "b", type: "reference" },
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const result = findCrossNamespaceArns({ cutEdges, arnRefs });
      expect(result).toHaveLength(0);
    });

    it("handles multiple matching ARNs", () => {
      const arnRefs: ArnReference[] = [
        { arn: "arn:aws:iam::123:role/RoleA", service: "iam", filePath: "a.tf", repo: "repo", resolved: false },
        { arn: "arn:aws:iam::123:role/RoleB", service: "iam", filePath: "b.tf", repo: "repo", resolved: false },
      ];

      const cutEdges: CutEdge[] = [
        { edge: { from: "a", to: "b", type: "arn", label: "arn:aws:iam::123:role/RoleA" }, fromNamespace: "service-api", toNamespace: "foundation", score: 1 },
        { edge: { from: "c", to: "d", type: "arn", label: "arn:aws:iam::123:role/RoleB" }, fromNamespace: "service-api", toNamespace: "foundation", score: 1 },
      ];

      const result = findCrossNamespaceArns({ cutEdges, arnRefs });
      expect(result).toHaveLength(2);
    });
  });

  describe("arnToVarName", () => {
    it("generates safe variable name from IAM role ARN", () => {
      const result = arnToVarName("arn:aws:iam::123456789012:role/LambdaExecRole", "iam");
      expect(result).toBe("iam_role_LambdaExecRole");
    });

    it("generates safe variable name from S3 ARN", () => {
      const result = arnToVarName("arn:aws:s3:::my-data-bucket", "s3");
      expect(result).toBe("s3_my_data_bucket");
    });

    it("replaces special characters with underscores", () => {
      const result = arnToVarName("arn:aws:iam::123:role/path/to/role", "iam");
      expect(result).toBe("iam_role_path_to_role");
    });
  });

  describe("planArnRewrites", () => {
    let testDir: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ testDir, cleanup } = await setupTestDirectory());
    });

    afterEach(async () => {
      await cleanup();
    });

    it("rewrites hardcoded ARNs and generates variables.tf", async () => {
      const repoDir = join(testDir, "service-api");
      await mkdir(repoDir, { recursive: true });

      const mainTf = `resource "aws_lambda_function" "api" {
  function_name = "api-handler"
  role          = "arn:aws:iam::123456789012:role/ApiLambdaRole"
  runtime       = "nodejs18.x"
}
`;
      await writeFile(join(repoDir, "main.tf"), mainTf);

      const arnRefs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/ApiLambdaRole",
        service: "iam",
        filePath: join(repoDir, "main.tf"),
        repo: "service-api",
        resolved: false,
      }];

      const cutEdges: CutEdge[] = [{
        edge: { from: "service-api:aws_lambda_function.api", to: "infra-central:aws_iam_role.api_lambda", type: "arn", label: "arn:aws:iam::123456789012:role/ApiLambdaRole" },
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const graph: DependencyGraph = { nodes: new Map(), edges: [] };
      const basePaths = new Map([["service-api", repoDir]]);

      const result = await planArnRewrites({ graph, cutEdges, arnRefs, basePaths });

      expect(result.arnsRewritten).toBe(1);
      expect(result.variableDeclarations).toHaveLength(1);
      expect(result.variableDeclarations[0].name).toContain("arn");

      // Should have file write for the modified main.tf
      const mainWrite = result.fileWrites.find((fw) => fw.filePath.includes("main.tf"));
      expect(mainWrite).toBeDefined();
      expect(mainWrite!.content).toContain("var.");
      expect(mainWrite!.content).not.toContain("arn:aws:iam::123456789012:role/ApiLambdaRole");

      // Should have file write for variables.tf
      const varWrite = result.fileWrites.find((fw) => fw.filePath.includes("variables.tf"));
      expect(varWrite).toBeDefined();
      expect(varWrite!.content).toContain("variable");
      expect(varWrite!.content).toContain("type        = string");
    });

    it("returns empty result when no cross-namespace ARNs", async () => {
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };

      const result = await planArnRewrites({
        graph,
        cutEdges: [],
        arnRefs: [],
        basePaths: new Map(),
      });

      expect(result.arnsRewritten).toBe(0);
      expect(result.variableDeclarations).toHaveLength(0);
      expect(result.fileWrites).toHaveLength(0);
    });

    it("appends to existing variables.tf", async () => {
      const repoDir = join(testDir, "service-app");
      await mkdir(repoDir, { recursive: true });

      const existingVars = `variable "region" {
  type    = string
  default = "us-east-1"
}
`;
      await writeFile(join(repoDir, "variables.tf"), existingVars);

      const mainTf = `resource "aws_lambda_function" "app" {
  role = "arn:aws:iam::111:role/AppRole"
}
`;
      await writeFile(join(repoDir, "main.tf"), mainTf);

      const arnRefs: ArnReference[] = [{
        arn: "arn:aws:iam::111:role/AppRole",
        service: "iam",
        filePath: join(repoDir, "main.tf"),
        repo: "service-app",
        resolved: false,
      }];

      const cutEdges: CutEdge[] = [{
        edge: { from: "x", to: "y", type: "arn", label: "arn:aws:iam::111:role/AppRole" },
        fromNamespace: "service-app",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([["service-app", repoDir]]);
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };

      const result = await planArnRewrites({ graph, cutEdges, arnRefs, basePaths });

      const varWrite = result.fileWrites.find((fw) => fw.filePath.includes("variables.tf"));
      expect(varWrite).toBeDefined();
      expect(varWrite!.operation).toBe("modify");
      // Should contain both old and new content
      expect(varWrite!.content).toContain('variable "region"');
      expect(varWrite!.content).toContain("# Variables added by terraform-state-mover");
    });

    it("logs warning and skips when file is unreadable", async () => {
      const arnRefs: ArnReference[] = [{
        arn: "arn:aws:iam::123:role/Missing",
        service: "iam",
        filePath: "/nonexistent/path/main.tf",
        repo: "ghost-repo",
        resolved: false,
      }];

      const cutEdges: CutEdge[] = [{
        edge: { from: "x", to: "y", type: "arn", label: "arn:aws:iam::123:role/Missing" },
        fromNamespace: "ghost-repo",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([["ghost-repo", "/nonexistent/path"]]);
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };

      const result = await planArnRewrites({ graph, cutEdges, arnRefs, basePaths });

      // Should not crash, just skip
      expect(result.arnsRewritten).toBe(0);
      expect(result.fileWrites).toHaveLength(0);
    });
  });
});
