import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { stripComments, stripHeredocs, preprocessHcl, parseHcl, extractArns, extractStringLiterals, parseTfFile, scanDirectory } from "./hcl-parser.js";

describe("stripComments", () => {
  it("strips single-line # comments", () => {
    const input = `resource "aws_vpc" "main" {
  # This is a comment with arn:aws:iam::123456789012:role/FakeRole
  cidr_block = "10.0.0.0/16"
}`;
    const result = stripComments(input);
    expect(result).not.toContain("FakeRole");
    expect(result).toContain("cidr_block");
  });

  it("strips single-line // comments", () => {
    const input = `resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16" // arn:aws:iam::123456789012:role/InlineComment
}`;
    const result = stripComments(input);
    expect(result).not.toContain("InlineComment");
    expect(result).toContain("cidr_block");
  });

  it("strips multi-line /* */ comments", () => {
    const input = `/*
 * This block contains arn:aws:iam::123456789012:role/BlockComment
 * resource "aws_iam_role" "fake" {
 *   name = "fake-role"
 * }
 */
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}`;
    const result = stripComments(input);
    expect(result).not.toContain("BlockComment");
    expect(result).not.toContain("fake-role");
    expect(result).toContain("cidr_block");
  });

  it("preserves ARNs inside string literals", () => {
    const input = `resource "aws_iam_role_policy_attachment" "attach" {
  policy_arn = "arn:aws:iam::123456789012:policy/RealPolicy"
}`;
    const result = stripComments(input);
    expect(result).toContain("arn:aws:iam::123456789012:policy/RealPolicy");
  });

  it("does not strip inside quoted strings that look like comments", () => {
    const input = `resource "aws_iam_role" "example" {
  description = "This has # a hash and // slashes"
}`;
    const result = stripComments(input);
    expect(result).toContain("This has # a hash and // slashes");
  });

  it("preserves line count for stable error reporting", () => {
    const input = `line1
# comment
line3`;
    const result = stripComments(input);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("line3");
  });

  it("handles unterminated block comment", () => {
    const input = `resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
/* unterminated comment with arn:aws:iam::123:role/Dangling`;
    const result = stripComments(input);
    expect(result).not.toContain("Dangling");
    expect(result).toContain("cidr_block");
  });
});

describe("stripHeredocs", () => {
  it("strips heredoc content", () => {
    const input = `resource "aws_iam_role" "example" {
  assume_role_policy = <<EOF
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Resource": "arn:aws:iam::123456789012:role/HeredocRole"
  }]
}
EOF
  name = "real-role"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("HeredocRole");
    expect(result).toContain("real-role");
  });

  it("strips indented heredoc (<<-)", () => {
    const input = `resource "aws_iam_role" "example" {
  policy = <<-POLICY
    {
      "arn": "arn:aws:iam::123456789012:role/IndentedHeredoc"
    }
  POLICY
  name = "real"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("IndentedHeredoc");
    expect(result).toContain("real");
  });

  it("handles multiple heredocs in one file", () => {
    const input = `resource "a" "b" {
  policy1 = <<EOF
arn:aws:iam::111:role/First
EOF
  policy2 = <<DOC
arn:aws:iam::222:role/Second
DOC
  name = "kept"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("First");
    expect(result).not.toContain("Second");
    expect(result).toContain("kept");
  });

  it("preserves line count", () => {
    const input = `line1
<<EOF
heredoc line
another line
EOF
line6`;
    const result = stripHeredocs(input);
    const lines = result.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("line6");
  });
});

describe("preprocessHcl", () => {
  it("strips both comments and heredocs together", () => {
    const input = `# This file manages IAM
resource "aws_iam_role" "real" {
  name = "real-role"
  assume_role_policy = <<EOF
{
  "fake_arn": "arn:aws:iam::123456789012:role/InHeredoc"
}
EOF
  # arn:aws:iam::123456789012:role/InComment
  tags = {
    env = "prod"
  }
}`;
    const result = preprocessHcl(input);
    expect(result).not.toContain("InHeredoc");
    expect(result).not.toContain("InComment");
    expect(result).toContain("real-role");
    expect(result).toContain("prod");
  });
});

describe("parseHcl with preprocessing", () => {
  it("does not extract ARNs from comments", () => {
    const hcl = `
resource "aws_iam_role" "real" {
  name = "real-role"
  # policy_arn = "arn:aws:iam::123456789012:role/Commented"
}`;
    const blocks = parseHcl(hcl, "main.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].arns).not.toContain("arn:aws:iam::123456789012:role/Commented");
  });

  it("does not extract ARNs from heredocs", () => {
    const hcl = `
resource "aws_iam_role" "real" {
  name = "real-role"
  assume_role_policy = <<EOF
{
  "Resource": "arn:aws:iam::123456789012:role/HeredocArn"
}
EOF
}`;
    const blocks = parseHcl(hcl, "main.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].arns).not.toContain("arn:aws:iam::123456789012:role/HeredocArn");
  });

  it("does not extract ARNs from block comments", () => {
    const hcl = `
resource "aws_iam_role" "real" {
  name = "real-role"
  /*
   * Old config: arn:aws:iam::123456789012:policy/OldPolicy
   */
}`;
    const blocks = parseHcl(hcl, "main.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].arns).not.toContain("arn:aws:iam::123456789012:policy/OldPolicy");
  });

  it("still extracts ARNs from actual string values", () => {
    const hcl = `
resource "aws_iam_role_policy_attachment" "attach" {
  role       = "my-role"
  policy_arn = "arn:aws:iam::123456789012:policy/RealPolicy"
}`;
    const blocks = parseHcl(hcl, "main.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].arns).toContain("arn:aws:iam::123456789012:policy/RealPolicy");
  });

  it("does not detect resource blocks inside comments", () => {
    const hcl = `
# resource "aws_iam_role" "ghost" {
#   name = "ghost"
# }

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}`;
    const blocks = parseHcl(hcl, "main.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("main");
  });

  it("does not detect resource blocks inside block comments", () => {
    const hcl = `
/*
resource "aws_iam_role" "ghost" {
  name = "ghost"
}
*/

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}`;
    const blocks = parseHcl(hcl, "main.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("main");
  });
});

describe("scanDirectory with comments/heredocs", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it("ignores ARNs in commented-out code in .tf files", async () => {
    await writeFile(join(testDir, "main.tf"), `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  # old_arn = "arn:aws:iam::123456789012:role/Deprecated"
}
`);
    const results = await scanDirectory(testDir, "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0].blocks[0].arns).toHaveLength(0);
  });

  it("ignores ARNs inside heredocs in .tf files", async () => {
    await writeFile(join(testDir, "main.tf"), `
resource "aws_iam_role" "worker" {
  name = "worker"
  assume_role_policy = <<POLICY
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::999999999999:root"}
  }]
}
POLICY
}
`);
    const results = await scanDirectory(testDir, "test-repo");
    expect(results).toHaveLength(1);
    expect(results[0].blocks[0].arns).not.toContain("arn:aws:iam::999999999999:root");
  });

  it("still detects real ARN references in resource bodies", async () => {
    await writeFile(join(testDir, "main.tf"), `
resource "aws_iam_role_policy_attachment" "attach" {
  role       = "my-role"
  policy_arn = "arn:aws:iam::123456789012:policy/ActualPolicy"
}
`);
    const results = await scanDirectory(testDir, "test-repo");
    expect(results[0].blocks[0].arns).toContain("arn:aws:iam::123456789012:policy/ActualPolicy");
  });
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
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it("parses a tf file from disk", async () => {
    const filePath = join(testDir, "main.tf");
    await writeFile(filePath, `resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }`);
    const result = await parseTfFile(filePath, "test-repo");
    expect(result.blocks).toHaveLength(1);
    expect(result.repo).toBe("test-repo");
  });
});

describe("scanDirectory", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

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
