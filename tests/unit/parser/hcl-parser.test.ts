import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHcl, extractArns, extractStringLiterals, parseTfFile, scanDirectory } from "../../../src/parser/hcl-parser.js";

describe("hcl-parser", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "tf-state-mover-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("parseHcl", () => {
    it("parses resource blocks", () => {
      const hcl = `
resource "aws_iam_role" "example" {
  name = "example-role"
  assume_role_policy = "policy"
}`;
      const blocks = parseHcl(hcl, "main.tf", "repo1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("resource");
      expect(blocks[0].resourceType).toBe("aws_iam_role");
      expect(blocks[0].name).toBe("example");
    });

    it("parses data blocks", () => {
      const hcl = `
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
  }
}`;
      const blocks = parseHcl(hcl, "data.tf", "repo1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("data");
      expect(blocks[0].resourceType).toBe("aws_iam_policy_document");
      expect(blocks[0].name).toBe("assume");
    });

    it("parses variable blocks", () => {
      const hcl = `
variable "region" {
  type    = string
  default = "us-east-1"
}`;
      const blocks = parseHcl(hcl, "vars.tf", "repo1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("variable");
      expect(blocks[0].name).toBe("region");
    });

    it("parses module blocks", () => {
      const hcl = `
module "vpc" {
  source = "./modules/vpc"
  cidr   = "10.0.0.0/16"
}`;
      const blocks = parseHcl(hcl, "main.tf", "repo1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("module");
      expect(blocks[0].name).toBe("vpc");
    });

    it("parses locals blocks", () => {
      const hcl = `
locals "common" {
  env = "production"
}`;
      const blocks = parseHcl(hcl, "locals.tf", "repo1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("locals");
    });

    it("extracts ARNs from resource bodies", () => {
      const hcl = `
resource "aws_iam_role_policy_attachment" "attach" {
  role       = "my-role"
  policy_arn = "arn:aws:iam::123456789012:policy/MyPolicy"
}`;
      const blocks = parseHcl(hcl, "main.tf", "repo1");
      expect(blocks[0].arns).toContain("arn:aws:iam::123456789012:policy/MyPolicy");
    });

    it("handles multiple blocks in one file", () => {
      const hcl = `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}`;
      const blocks = parseHcl(hcl, "main.tf", "repo1");
      expect(blocks).toHaveLength(2);
    });

    it("handles nested braces correctly", () => {
      const hcl = `
resource "aws_iam_role" "complex" {
  name = "complex"
  inline_policy {
    name = "inner"
    policy = jsonencode({
      Statement = [{
        Effect = "Allow"
      }]
    })
  }
}`;
      const blocks = parseHcl(hcl, "main.tf", "repo1");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].body).toContain("inline_policy");
    });
  });

  describe("extractArns", () => {
    it("extracts IAM ARNs", () => {
      const text = `policy_arn = "arn:aws:iam::123456789012:role/MyRole"`;
      expect(extractArns(text)).toEqual(["arn:aws:iam::123456789012:role/MyRole"]);
    });

    it("extracts S3 ARNs", () => {
      const text = `bucket = "arn:aws:s3:::my-bucket"`;
      expect(extractArns(text)).toEqual(["arn:aws:s3:::my-bucket"]);
    });

    it("extracts Lambda ARNs", () => {
      const text = `function_arn = "arn:aws:lambda:us-east-1:123456789012:function:my-func"`;
      expect(extractArns(text)).toEqual(["arn:aws:lambda:us-east-1:123456789012:function:my-func"]);
    });

    it("extracts RDS ARNs", () => {
      const text = `db_arn = "arn:aws:rds:us-west-2:123456789012:db:mydb"`;
      expect(extractArns(text)).toEqual(["arn:aws:rds:us-west-2:123456789012:db:mydb"]);
    });

    it("extracts multiple ARNs from text", () => {
      const text = `
        role = "arn:aws:iam::123456789012:role/Role1"
        policy = "arn:aws:iam::123456789012:policy/Policy1"
      `;
      expect(extractArns(text)).toHaveLength(2);
    });

    it("returns empty for no ARNs", () => {
      expect(extractArns("no arns here")).toEqual([]);
    });
  });

  describe("extractStringLiterals", () => {
    it("extracts quoted strings", () => {
      const text = `name = "hello" value = "world"`;
      expect(extractStringLiterals(text)).toEqual(["hello", "world"]);
    });

    it("handles escaped quotes", () => {
      const text = `name = "hello \\"world\\""`;
      expect(extractStringLiterals(text)).toContain('hello \\"world\\"');
    });
  });

  describe("parseTfFile", () => {
    it("parses a tf file from disk", async () => {
      const filePath = join(testDir, "main.tf");
      await writeFile(filePath, `resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }`);
      const result = await parseTfFile(filePath, "test-repo");
      expect(result.blocks).toHaveLength(1);
      expect(result.repo).toBe("test-repo");
    });
  });

  describe("scanDirectory", () => {
    it("scans all .tf files recursively", async () => {
      await mkdir(join(testDir, "subdir"), { recursive: true });
      await writeFile(join(testDir, "main.tf"), `resource "aws_vpc" "a" { cidr_block = "10.0.0.0/16" }`);
      await writeFile(join(testDir, "subdir", "sub.tf"), `resource "aws_subnet" "b" { cidr_block = "10.0.1.0/24" }`);
      await writeFile(join(testDir, "readme.md"), "not a tf file");

      const results = await scanDirectory(testDir, "my-repo");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.repo === "my-repo")).toBe(true);
    });

    it("skips .terraform directory", async () => {
      await mkdir(join(testDir, ".terraform"), { recursive: true });
      await writeFile(join(testDir, ".terraform", "lock.tf"), `resource "a" "b" { x = "y" }`);
      await writeFile(join(testDir, "main.tf"), `resource "aws_vpc" "a" { x = "y" }`);

      const results = await scanDirectory(testDir);
      expect(results).toHaveLength(1);
    });
  });
});
