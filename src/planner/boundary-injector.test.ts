import { describe, expect, it } from "vitest";
import type { HclMoveOperation } from "../types.js";
import {
  detectMissingBoundaries,
  injectBoundary,
  generateBoundaryVariable,
} from "./boundary-injector.js";

function makeMove(overrides: Partial<HclMoveOperation> = {}): HclMoveOperation {
  return {
    sourceFilePath: "/infra-central/iam.tf",
    targetFilePath: "/service-api/iam.tf",
    block: {
      type: "resource",
      resourceType: "aws_iam_role",
      name: "api_lambda_exec",
      body: `{\n  name               = "api-lambda-exec"\n  assume_role_policy = "{}"\n}\n`,
      stringLiterals: [],
      arns: [],
      filePath: "/infra-central/iam.tf",
      repo: "infra-central",
    },
    sourceRepo: "infra-central",
    targetRepo: "service-api",
    ...overrides,
  };
}

describe("boundary-injector", () => {
  describe("detectMissingBoundaries", () => {
    it("detects IAM roles without permissions_boundary", () => {
      const moves = [makeMove()];
      const warnings = detectMissingBoundaries(moves);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].resource).toBe("aws_iam_role.api_lambda_exec");
      expect(warnings[0].targetRepo).toBe("service-api");
    });

    it("does not flag roles that already have permissions_boundary", () => {
      const moves = [makeMove({
        block: {
          type: "resource",
          resourceType: "aws_iam_role",
          name: "api_lambda_exec",
          body: `{\n  name                 = "api-lambda-exec"\n  assume_role_policy   = "{}"\n  permissions_boundary = var.boundary_arn\n}\n`,
          stringLiterals: [],
          arns: [],
          filePath: "/infra-central/iam.tf",
          repo: "infra-central",
        },
      })];

      const warnings = detectMissingBoundaries(moves);
      expect(warnings).toHaveLength(0);
    });

    it("does not flag non-IAM-role resources", () => {
      const moves = [makeMove({
        block: {
          type: "resource",
          resourceType: "aws_s3_bucket",
          name: "data",
          body: `{\n  bucket = "data-bucket"\n}\n`,
          stringLiterals: [],
          arns: [],
          filePath: "/infra-central/main.tf",
          repo: "infra-central",
        },
      })];

      const warnings = detectMissingBoundaries(moves);
      expect(warnings).toHaveLength(0);
    });

    it("handles multiple roles with mixed boundary status", () => {
      const moves = [
        makeMove({ block: { type: "resource", resourceType: "aws_iam_role", name: "role_a", body: `{\n  name = "a"\n}\n`, stringLiterals: [], arns: [], filePath: "a.tf", repo: "central" } }),
        makeMove({ block: { type: "resource", resourceType: "aws_iam_role", name: "role_b", body: `{\n  name = "b"\n  permissions_boundary = "arn:aws:iam::123:policy/Boundary"\n}\n`, stringLiterals: [], arns: [], filePath: "b.tf", repo: "central" } }),
        makeMove({ block: { type: "resource", resourceType: "aws_iam_role", name: "role_c", body: `{\n  name = "c"\n}\n`, stringLiterals: [], arns: [], filePath: "c.tf", repo: "central" } }),
      ];

      const warnings = detectMissingBoundaries(moves);
      expect(warnings).toHaveLength(2);
      expect(warnings.map((w) => w.resource)).toEqual(["aws_iam_role.role_a", "aws_iam_role.role_c"]);
    });
  });

  describe("injectBoundary", () => {
    it("injects permissions_boundary into role blocks without one", () => {
      const moves = [makeMove()];
      const result = injectBoundary({ moves, boundaryArn: "arn:aws:iam::123:policy/ServiceBoundary" });

      expect(result.rolesInjected).toBe(1);
      expect(moves[0].block.body).toContain("permissions_boundary = var.permissions_boundary_arn");
    });

    it("preserves existing indentation", () => {
      const moves = [makeMove({
        block: {
          type: "resource",
          resourceType: "aws_iam_role",
          name: "role",
          body: `{\n    name               = "role"\n    assume_role_policy = "{}"\n}\n`,
          stringLiterals: [],
          arns: [],
          filePath: "iam.tf",
          repo: "central",
        },
      })];

      injectBoundary({ moves, boundaryArn: "arn:..." });
      // Should use 4-space indent matching existing attributes
      expect(moves[0].block.body).toContain("    permissions_boundary = var.permissions_boundary_arn");
    });

    it("does not inject into roles that already have permissions_boundary", () => {
      const moves = [makeMove({
        block: {
          type: "resource",
          resourceType: "aws_iam_role",
          name: "role",
          body: `{\n  name                 = "role"\n  permissions_boundary = "existing"\n}\n`,
          stringLiterals: [],
          arns: [],
          filePath: "iam.tf",
          repo: "central",
        },
      })];

      const result = injectBoundary({ moves, boundaryArn: "arn:..." });
      expect(result.rolesInjected).toBe(0);
      expect(moves[0].block.body).not.toContain("var.permissions_boundary_arn");
    });

    it("does not inject into non-IAM-role blocks", () => {
      const moves = [makeMove({
        block: {
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "handler",
          body: `{\n  function_name = "handler"\n}\n`,
          stringLiterals: [],
          arns: [],
          filePath: "lambda.tf",
          repo: "central",
        },
      })];

      const result = injectBoundary({ moves, boundaryArn: "arn:..." });
      expect(result.rolesInjected).toBe(0);
    });

    it("uses custom variable name when provided", () => {
      const moves = [makeMove()];
      injectBoundary({ moves, boundaryArn: "arn:...", variableName: "boundary_arn" });

      expect(moves[0].block.body).toContain("permissions_boundary = var.boundary_arn");
    });

    it("generates variable declarations for each target repo", () => {
      const moves = [
        makeMove({ targetRepo: "service-api" }),
        makeMove({
          targetRepo: "service-analytics",
          block: { type: "resource", resourceType: "aws_iam_role", name: "analytics_role", body: `{\n  name = "analytics"\n}\n`, stringLiterals: [], arns: [], filePath: "iam.tf", repo: "central" },
        }),
      ];

      const result = injectBoundary({ moves, boundaryArn: "arn:..." });
      expect(result.variableDeclarations).toHaveLength(2);
      expect(result.variableDeclarations.map((v) => v.repo).sort()).toEqual(["service-analytics", "service-api"]);
    });

    it("deduplicates variable declarations per repo", () => {
      const moves = [
        makeMove({ targetRepo: "service-api" }),
        makeMove({
          targetRepo: "service-api",
          block: { type: "resource", resourceType: "aws_iam_role", name: "second_role", body: `{\n  name = "second"\n}\n`, stringLiterals: [], arns: [], filePath: "iam.tf", repo: "central" },
        }),
      ];

      const result = injectBoundary({ moves, boundaryArn: "arn:..." });
      expect(result.variableDeclarations).toHaveLength(1);
      expect(result.rolesInjected).toBe(2);
    });

    it("generates fileWrites with boundary variable content for each target repo", () => {
      const moves = [
        makeMove({ targetRepo: "service-api" }),
        makeMove({
          targetRepo: "service-analytics",
          block: { type: "resource", resourceType: "aws_iam_role", name: "analytics_role", body: `{\n  name = "analytics"\n}\n`, stringLiterals: [], arns: [], filePath: "iam.tf", repo: "central" },
        }),
      ];

      const result = injectBoundary({ moves, boundaryArn: "arn:aws:iam::123:policy/Boundary" });
      expect(result.fileWrites).toHaveLength(2);
      for (const fw of result.fileWrites) {
        expect(fw.operation).toBe("create");
        expect(fw.content).toContain('variable "permissions_boundary_arn"');
        expect(fw.content).toContain('default     = "arn:aws:iam::123:policy/Boundary"');
      }
    });

    it("fileWrites includes default value from boundaryArn", () => {
      const moves = [makeMove({ targetRepo: "service-api" })];
      const arn = "arn:aws:iam::999:policy/MyBoundary";
      const result = injectBoundary({ moves, boundaryArn: arn });
      expect(result.fileWrites).toHaveLength(1);
      expect(result.fileWrites[0].content).toContain(`default     = "${arn}"`);
    });

    it("fileWrites is empty when no roles injected", () => {
      const moves = [makeMove({
        block: {
          type: "resource",
          resourceType: "aws_iam_role",
          name: "role",
          body: `{\n  permissions_boundary = "existing"\n}\n`,
          stringLiterals: [],
          arns: [],
          filePath: "iam.tf",
          repo: "central",
        },
      })];
      const result = injectBoundary({ moves, boundaryArn: "arn:..." });
      expect(result.fileWrites).toHaveLength(0);
    });
  });

  describe("generateBoundaryVariable", () => {
    it("generates a valid HCL variable block", () => {
      const hcl = generateBoundaryVariable("permissions_boundary_arn");
      expect(hcl).toContain('variable "permissions_boundary_arn"');
      expect(hcl).toContain("type        = string");
      expect(hcl).toContain("permissions boundary");
    });

    it("uses the provided variable name", () => {
      const hcl = generateBoundaryVariable("boundary_arn");
      expect(hcl).toContain('variable "boundary_arn"');
    });

    it("includes default value when provided", () => {
      const hcl = generateBoundaryVariable("permissions_boundary_arn", "arn:aws:iam::123:policy/ServiceBoundary");
      expect(hcl).toContain('default     = "arn:aws:iam::123:policy/ServiceBoundary"');
    });

    it("omits default when not provided", () => {
      const hcl = generateBoundaryVariable("permissions_boundary_arn");
      expect(hcl).not.toContain("default");
    });
  });
});
