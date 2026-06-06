import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { removeBlockFromContent, blockToHcl, planBlockMoves } from "./hcl-block-mover.js";
import type { TerraformBlock, DependencyGraph, CutEdge, GraphNode, GraphEdge } from "../types.js";

describe("hcl-block-mover", () => {
  describe("removeBlockFromContent", () => {
    it("removes a resource block from HCL content", () => {
      const content = `resource "aws_iam_role" "lambda_exec" {
  name = "lambda-exec"
  assume_role_policy = "{}"
}

resource "aws_s3_bucket" "data" {
  bucket = "my-data-bucket"
}
`;
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "lambda_exec",
        body: '{\n  name = "lambda-exec"\n  assume_role_policy = "{}"\n}',
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "infra-central",
      };

      const result = removeBlockFromContent(content, block);
      expect(result).not.toContain("aws_iam_role");
      expect(result).toContain("aws_s3_bucket");
      expect(result).toContain("my-data-bucket");
    });

    it("returns content unchanged if block not found", () => {
      const content = `resource "aws_s3_bucket" "data" {
  bucket = "my-bucket"
}
`;
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "nonexistent",
        body: "{}",
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo",
      };

      const result = removeBlockFromContent(content, block);
      expect(result).toBe(content);
    });

    it("handles nested braces correctly", () => {
      const content = `resource "aws_iam_role" "complex" {
  name = "complex"
  inline_policy {
    name = "policy"
    policy = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect = "Allow"
        Action = ["s3:*"]
        Resource = ["*"]
      }]
    })
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
`;
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "complex",
        body: "{}",
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo",
      };

      const result = removeBlockFromContent(content, block);
      expect(result).not.toContain("aws_iam_role");
      expect(result).not.toContain("complex");
      expect(result).toContain("aws_vpc");
      expect(result).toContain("10.0.0.0/16");
    });

    it("removes data blocks", () => {
      const content = `data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
  }
}
`;
      const block: TerraformBlock = {
        type: "data",
        resourceType: "aws_iam_policy_document",
        name: "assume",
        body: "{}",
        stringLiterals: [],
        arns: [],
        filePath: "data.tf",
        repo: "repo",
      };

      const result = removeBlockFromContent(content, block);
      expect(result.trim()).toBe("");
    });

    it("handles closing braces inside string literals", () => {
      const content = `resource "aws_iam_role" "tricky" {
  name = "tricky"
  assume_role_policy = "{\\"Version\\": \\"2012-10-17\\"}"
  description = "contains } and { braces"
}

resource "aws_s3_bucket" "keep" {
  bucket = "keep-me"
}
`;
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "tricky",
        body: "{}",
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo",
      };

      const result = removeBlockFromContent(content, block);
      expect(result).not.toContain("aws_iam_role");
      expect(result).toContain("aws_s3_bucket");
      expect(result).toContain("keep-me");
    });

    it("handles closing braces inside heredocs", () => {
      const content = `resource "aws_iam_role" "heredoc" {
  name = "heredoc"
  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow"}]
}
EOF
}

resource "aws_vpc" "keep" {
  cidr_block = "10.0.0.0/16"
}
`;
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "heredoc",
        body: "{}",
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo",
      };

      const result = removeBlockFromContent(content, block);
      expect(result).not.toContain("aws_iam_role");
      expect(result).not.toContain("EOF");
      expect(result).toContain("aws_vpc");
    });

    it("does not match a block whose name is mentioned in a comment", () => {
      const content = `# TODO: move resource "aws_iam_role" "victim" someday

resource "aws_iam_role" "victim" {
  name = "victim"
}
`;
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "victim",
        body: "{}",
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo",
      };

      const result = removeBlockFromContent(content, block);
      expect(result).toContain("# TODO");
      expect(result).not.toContain('resource "aws_iam_role" "victim" {');
    });
  });

  describe("blockToHcl", () => {
    it("generates HCL for a resource block", () => {
      const block: TerraformBlock = {
        type: "resource",
        resourceType: "aws_iam_role",
        name: "lambda_exec",
        body: '{\n  name = "lambda-exec"\n}',
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo",
      };

      const result = blockToHcl(block);
      expect(result).toBe('resource "aws_iam_role" "lambda_exec" {\n  name = "lambda-exec"\n}\n');
    });

    it("generates HCL for a data block", () => {
      const block: TerraformBlock = {
        type: "data",
        resourceType: "aws_iam_policy_document",
        name: "assume",
        body: '{\n  statement {\n    actions = ["sts:AssumeRole"]\n  }\n}',
        stringLiterals: [],
        arns: [],
        filePath: "data.tf",
        repo: "repo",
      };

      const result = blockToHcl(block);
      expect(result).toContain('data "aws_iam_policy_document" "assume"');
    });

    it("generates HCL for a variable block", () => {
      const block: TerraformBlock = {
        type: "variable",
        resourceType: "region",
        name: "region",
        body: '{\n  type = string\n  default = "us-east-1"\n}',
        stringLiterals: [],
        arns: [],
        filePath: "vars.tf",
        repo: "repo",
      };

      const result = blockToHcl(block);
      expect(result).toContain('variable "region"');
    });
  });

  describe("planBlockMoves", () => {
    let testDir: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ testDir, cleanup } = await setupTestDirectory());
    });

    afterEach(async () => {
      await cleanup();
    });

    it("plans moves for cross-namespace resources", async () => {
      // Setup: infra-central repo with IAM role that should move to service-api
      const infraDir = join(testDir, "infra-central");
      const serviceDir = join(testDir, "service-api");
      await mkdir(infraDir, { recursive: true });
      await mkdir(serviceDir, { recursive: true });

      const mainTf = `resource "aws_iam_role" "api_lambda_exec" {
  name               = "api-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "shared_role" {
  name = "shared-role"
}
`;
      await writeFile(join(infraDir, "main.tf"), mainTf);

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

      // Lambda references IAM role via ARN (consumer → provider)
      const edges: GraphEdge[] = [{
        from: "service-api:aws_lambda_function.api",
        to: "infra-central:aws_iam_role.api_lambda_exec",
        type: "arn",
        label: "arn:aws:iam::123:role/api-lambda-exec",
      }];

      const graph: DependencyGraph = { nodes, edges };

      const cutEdges: CutEdge[] = [{
        edge: edges[0],
        fromNamespace: "service-api",
        toNamespace: "foundation",
        score: 1,
      }];

      const basePaths = new Map([
        ["infra-central", infraDir],
        ["service-api", serviceDir],
      ]);

      const result = await planBlockMoves({ graph, cutEdges, basePaths });

      expect(result.moves).toHaveLength(1);
      expect(result.moves[0].sourceRepo).toBe("infra-central");
      expect(result.moves[0].targetRepo).toBe("service-api");

      // Should have file writes for both source (modify) and target (create)
      const createWrites = result.fileWrites.filter((fw) => fw.operation === "create");
      const modifyWrites = result.fileWrites.filter((fw) => fw.operation === "modify");

      expect(createWrites.length).toBeGreaterThanOrEqual(1);
      // Target file should contain the moved resource
      const targetWrite = createWrites.find((fw) => fw.filePath.includes("service-api"));
      expect(targetWrite).toBeDefined();
      expect(targetWrite!.content).toContain("aws_iam_role");
      expect(targetWrite!.content).toContain("api_lambda_exec");

      // Source should still have shared_role but not api_lambda_exec
      expect(modifyWrites.length).toBeGreaterThanOrEqual(1);
      const sourceWrite = modifyWrites[0];
      expect(sourceWrite.content).toContain("shared_role");
      expect(sourceWrite.content).not.toContain("api_lambda_exec");
    });

    it("returns empty results when no cut edges", async () => {
      const graph: DependencyGraph = { nodes: new Map(), edges: [] };
      const result = await planBlockMoves({ graph, cutEdges: [], basePaths: new Map() });
      expect(result.moves).toHaveLength(0);
      expect(result.fileWrites).toHaveLength(0);
    });
  });
});
