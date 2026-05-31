import { describe, it, expect } from "vitest";
import { rewriteArns, arnToDataSource, arnToVariable, generateUnifiedDiff } from "./code-rewriter.js";
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
  });
});
