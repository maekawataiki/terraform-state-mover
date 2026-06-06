import { describe, it, expect } from "vitest";
import { classifyArnService, detectArns, getUnresolvedArns, groupByService } from "./arn-detector.js";
import type { ParsedFile } from "../types.js";

function makeParsedFile(blocks: Array<{ type: "resource" | "data"; resourceType: string; name: string; body: string; arns: string[] }>, repo = "repo1"): ParsedFile {
  return {
    filePath: "main.tf",
    repo,
    blocks: blocks.map((b) => ({
      ...b,
      filePath: "main.tf",
      repo,
      stringLiterals: [],
    })),
  };
}

describe("arn-detector", () => {
  describe("classifyArnService", () => {
    it("classifies IAM ARNs", () => {
      expect(classifyArnService("arn:aws:iam::123456789012:role/MyRole")).toBe("iam");
    });

    it("classifies S3 ARNs", () => {
      expect(classifyArnService("arn:aws:s3:::my-bucket")).toBe("s3");
    });

    it("classifies RDS ARNs", () => {
      expect(classifyArnService("arn:aws:rds:us-west-2:123456789012:db:mydb")).toBe("rds");
    });

    it("classifies Lambda ARNs", () => {
      expect(classifyArnService("arn:aws:lambda:us-east-1:123456789012:function:my-func")).toBe("lambda");
    });

    it("classifies DynamoDB ARNs", () => {
      expect(classifyArnService("arn:aws:dynamodb:us-east-1:123456789012:table/MyTable")).toBe("dynamodb");
    });

    it("classifies SQS ARNs", () => {
      expect(classifyArnService("arn:aws:sqs:us-east-1:123456789012:my-queue")).toBe("sqs");
    });

    it("returns unknown for malformed ARN", () => {
      expect(classifyArnService("not-an-arn")).toBe("unknown");
    });

    it("classifies aws-cn partition ARNs", () => {
      expect(classifyArnService("arn:aws-cn:iam::123456789012:role/MyRole")).toBe("iam");
      expect(classifyArnService("arn:aws-cn:s3:::my-bucket")).toBe("s3");
      expect(classifyArnService("arn:aws-cn:lambda:cn-north-1:123456789012:function:my-func")).toBe("lambda");
    });

    it("classifies aws-us-gov partition ARNs", () => {
      expect(classifyArnService("arn:aws-us-gov:iam::123456789012:role/MyRole")).toBe("iam");
      expect(classifyArnService("arn:aws-us-gov:s3:::my-bucket")).toBe("s3");
      expect(classifyArnService("arn:aws-us-gov:dynamodb:us-gov-west-1:123456789012:table/MyTable")).toBe("dynamodb");
    });
  });

  describe("detectArns", () => {
    it("detects ARNs from parsed files", () => {
      const files = [makeParsedFile([{
        type: "resource",
        resourceType: "aws_iam_role_policy_attachment",
        name: "attach",
        body: "{}",
        arns: ["arn:aws:iam::123456789012:policy/MyPolicy"],
      }])];
      const arns = detectArns(files);
      expect(arns).toHaveLength(1);
      expect(arns[0].service).toBe("iam");
    });

    it("resolves ARNs to defining resources", () => {
      const arn = "arn:aws:iam::123456789012:role/SharedRole";
      const files = [
        makeParsedFile([{
          type: "resource",
          resourceType: "aws_iam_role",
          name: "shared",
          body: "{}",
          arns: [arn],
        }], "repo1"),
        makeParsedFile([{
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "func",
          body: "{}",
          arns: [arn],
        }], "repo2"),
      ];
      const arns_result = detectArns(files);
      // The ARN defined by repo1's resource should be resolved for repo2's reference
      const resolved = arns_result.filter((a) => a.resolved);
      expect(resolved.length).toBeGreaterThanOrEqual(1);
    });

    it("detects aws-cn partition ARNs", () => {
      const files = [makeParsedFile([{
        type: "resource",
        resourceType: "aws_iam_role",
        name: "cn_role",
        body: "{}",
        arns: ["arn:aws-cn:iam::123456789012:role/ChinaRole"],
      }])];
      const arns = detectArns(files);
      expect(arns).toHaveLength(1);
      expect(arns[0].service).toBe("iam");
    });

    it("detects aws-us-gov partition ARNs", () => {
      const files = [makeParsedFile([{
        type: "resource",
        resourceType: "aws_s3_bucket",
        name: "gov_bucket",
        body: "{}",
        arns: ["arn:aws-us-gov:s3:::gov-bucket"],
      }])];
      const arns = detectArns(files);
      expect(arns).toHaveLength(1);
      expect(arns[0].service).toBe("s3");
    });

    it("identifies unresolved ARNs", () => {
      const files = [makeParsedFile([{
        type: "data",
        resourceType: "aws_iam_policy",
        name: "external",
        body: "{}",
        arns: ["arn:aws:iam::999999999999:policy/External"],
      }])];
      const arns = detectArns(files);
      // Data blocks don't define resources, so this ARN is unresolved
      const unresolved = getUnresolvedArns(arns);
      expect(unresolved).toHaveLength(1);
    });
  });

  describe("groupByService", () => {
    it("groups ARN references by service", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_x", name: "a", body: "{}", arns: ["arn:aws:iam::123456789012:role/A"] },
        { type: "resource", resourceType: "aws_y", name: "b", body: "{}", arns: ["arn:aws:s3:::bucket"] },
        { type: "resource", resourceType: "aws_z", name: "c", body: "{}", arns: ["arn:aws:iam::123456789012:role/B"] },
      ])];
      const arns = detectArns(files);
      const groups = groupByService(arns);
      expect(groups.get("iam")?.length).toBe(2);
      expect(groups.get("s3")?.length).toBe(1);
    });
  });
});
