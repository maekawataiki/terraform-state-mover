import { describe, it, expect } from "vitest";
import { rewriteArns, arnToDataSource, arnToVariable, generateUnifiedDiff, replaceArnInContent } from "./code-rewriter.js";
import type { ArnReference } from "../types.js";

describe("code-rewriter", () => {
  describe("arnToDataSource", () => {
    it("generates a data source declaration", () => {
      const result = arnToDataSource("arn:aws:iam::123456789012:role/MyRole", "iam", "my_role");
      expect(result).toContain('data "aws_iam_role" "my_role"');
      expect(result).toContain("Replaces hardcoded ARN");
    });

    it("maps service to correct data source type", () => {
      expect(arnToDataSource("arn:aws:s3:::bucket", "s3", "bucket")).toContain("aws_s3_bucket");
      expect(arnToDataSource("arn:aws:lambda:us-east-1:123:function:f", "lambda", "f")).toContain("aws_lambda_function");
    });
  });

  describe("arnToVariable", () => {
    it("generates a variable declaration", () => {
      const result = arnToVariable("arn:aws:iam::123456789012:role/MyRole", "my_role");
      expect(result).toContain('variable "my_role_arn"');
      expect(result).toContain("type        = string");
    });
  });

  describe("generateUnifiedDiff", () => {
    it("generates unified diff format", () => {
      const original = 'role_arn = "arn:aws:iam::123:role/Old"';
      const modified = "role_arn = data.aws_iam_role.old.arn";
      const diff = generateUnifiedDiff("main.tf", original, modified);
      expect(diff).toContain("--- a/main.tf");
      expect(diff).toContain("+++ b/main.tf");
      expect(diff).toContain("-");
      expect(diff).toContain("+");
    });

    it("returns header only for identical content", () => {
      const content = "same content";
      const diff = generateUnifiedDiff("file.tf", content, content);
      expect(diff).toContain("--- a/file.tf");
      expect(diff).not.toContain("@@");
    });
  });

  describe("rewriteArns", () => {
    it("replaces ARN with data source reference", () => {
      const content = `resource "aws_lambda_function" "api" {\n  role = "arn:aws:iam::123456789012:role/LambdaRole"\n}`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/LambdaRole",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs, "data_source");
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].modified).toContain("data.aws_iam_role.");
      expect(result.dataSourceDeclarations).toHaveLength(1);
    });

    it("replaces ARN with variable reference", () => {
      const content = `resource "aws_lambda_function" "api" {\n  role = "arn:aws:iam::123456789012:role/LambdaRole"\n}`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/LambdaRole",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs, "variable");
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].modified).toContain("var.");
      expect(result.variableDeclarations).toHaveLength(1);
    });

    it("generates unified diff output", () => {
      const content = `role = "arn:aws:iam::123456789012:role/Test"`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/Test",
        service: "iam",
        filePath: "test.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "test.tf", refs);
      expect(result.diffs[0].unifiedDiff).toContain("--- a/test.tf");
      expect(result.diffs[0].unifiedDiff).toContain("+++ b/test.tf");
    });

    it("returns empty diffs when no ARNs match", () => {
      const content = `resource "aws_vpc" "main" { cidr = "10.0.0.0/16" }`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/NotHere",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs);
      expect(result.diffs).toHaveLength(0);
    });

    it("replaces ARN embedded in a larger string with interpolation (variable mode)", () => {
      const content = `resource "aws_iam_policy" "example" {\n  policy = "arn:aws:iam::123456789012:role/MyRole/*"\n}`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/MyRole",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs, "variable");
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].modified).toContain("${var.iam_role_MyRole_arn}/*");
    });

    it("replaces ARN embedded in a larger string with interpolation (data_source mode)", () => {
      const content = `resource "aws_iam_policy" "example" {\n  policy = "arn:aws:iam::123456789012:role/MyRole/*"\n}`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/MyRole",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs, "data_source");
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].modified).toContain("${data.aws_iam_role.iam_role_MyRole.arn}/*");
    });

    it("prefers exact match over interpolation when ARN is the full string value", () => {
      const content = `role = "arn:aws:iam::123456789012:role/ExactRole"`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/ExactRole",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs, "variable");
      expect(result.diffs[0].modified).toBe("role = var.iam_role_ExactRole_arn");
      // No interpolation wrapping when it's the entire string
      expect(result.diffs[0].modified).not.toContain("${");
    });

    it("handles ARN with prefix text in the string", () => {
      const content = `value = "Resource: arn:aws:s3:::my-bucket"`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:s3:::my-bucket",
        service: "s3",
        filePath: "outputs.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "outputs.tf", refs, "variable");
      expect(result.diffs[0].modified).toBe(`value = "Resource: \${var.s3_my_bucket_arn}"`);
    });

    it("handles ARN with suffix text in the string", () => {
      const content = `principal = "arn:aws:iam::123456789012:role/Admin:*"`;
      const refs: ArnReference[] = [{
        arn: "arn:aws:iam::123456789012:role/Admin",
        service: "iam",
        filePath: "main.tf",
        repo: "repo1",
        resolved: false,
      }];
      const result = rewriteArns(content, "main.tf", refs, "variable");
      expect(result.diffs[0].modified).toContain("${var.iam_role_Admin_arn}:*");
    });
  });

  describe("replaceArnInContent", () => {
    it("replaces exact match (ARN as entire string value) with bare reference", () => {
      const content = `role_arn = "arn:aws:iam::123:role/MyRole"`;
      const result = replaceArnInContent(content, "arn:aws:iam::123:role/MyRole", "var.my_role_arn");
      expect(result.content).toBe("role_arn = var.my_role_arn");
      expect(result.replacements).toBe(1);
    });

    it("replaces ARN embedded in string with interpolation", () => {
      const content = `policy = "arn:aws:iam::123:role/MyRole/*"`;
      const result = replaceArnInContent(content, "arn:aws:iam::123:role/MyRole", "var.my_role_arn");
      expect(result.content).toBe(`policy = "\${var.my_role_arn}/*"`);
      expect(result.replacements).toBe(1);
    });

    it("returns content unchanged when ARN is not present", () => {
      const content = `name = "my-resource"`;
      const result = replaceArnInContent(content, "arn:aws:iam::123:role/Missing", "var.missing_arn");
      expect(result.content).toBe(content);
      expect(result.replacements).toBe(0);
    });

    it("replaces every occurrence, choosing bare vs interpolation per context", () => {
      // Content has both an exact match AND an embedded occurrence
      const content = `role = "arn:aws:iam::123:role/X"\npolicy = "arn:aws:iam::123:role/X/*"`;
      const result = replaceArnInContent(content, "arn:aws:iam::123:role/X", "var.x_arn");
      expect(result.content).toContain("role = var.x_arn");
      expect(result.content).toContain(`policy = "\${var.x_arn}/*"`);
      expect(result.replacements).toBe(2);
    });

    it("does not replace when the ARN is a prefix of a longer name token", () => {
      const content = `role = "arn:aws:iam::123:role/App"\nother = "arn:aws:iam::123:role/AppV2"`;
      const result = replaceArnInContent(content, "arn:aws:iam::123:role/App", "var.app_arn");
      expect(result.content).toContain("role = var.app_arn");
      expect(result.content).toContain(`"arn:aws:iam::123:role/AppV2"`);
      expect(result.replacements).toBe(1);
    });

    it("handles data source reference in interpolation", () => {
      const content = `statement = "Allow arn:aws:s3:::bucket/prefix/*"`;
      const result = replaceArnInContent(content, "arn:aws:s3:::bucket", "data.aws_s3_bucket.bucket.arn");
      expect(result.content).toBe(`statement = "Allow \${data.aws_s3_bucket.bucket.arn}/prefix/*"`);
    });
  });
});
