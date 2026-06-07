import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { stripComments, stripHeredocs, preprocessHcl, parseHcl, extractArns, extractStringLiterals, parseTfFile, scanDirectory, detectParserLimitations, extractUnresolvedRefs } from "./hcl-parser.js";

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

  it("does not treat hash inside interpolation as comment", () => {
    const input = `resource "aws_s3_bucket" "main" {
  bucket = "\${var.name}#suffix"
}`;
    const result = stripComments(input);
    expect(result).toContain("#suffix");
    expect(result).toContain("${var.name}#suffix");
  });

  it("handles nested quotes with escapes", () => {
    const input = `resource "aws_iam_role" "example" {
  description = "she said \\"hello\\""
  name = "real-role"
}`;
    const result = stripComments(input);
    expect(result).toContain('she said \\"hello\\"');
    expect(result).toContain("real-role");
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

  it("strips lowercase heredoc marker", () => {
    const input = `resource "aws_iam_role" "example" {
  policy = <<eof
{
  "Resource": "arn:aws:iam::123456789012:role/LowercaseHeredoc"
}
eof
  name = "kept"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("LowercaseHeredoc");
    expect(result).toContain("kept");
  });

  it("strips mixed case heredoc marker", () => {
    const input = `resource "aws_iam_role" "example" {
  policy = <<EoF
{
  "Resource": "arn:aws:iam::123456789012:role/MixedCaseHeredoc"
}
EoF
  name = "kept"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("MixedCaseHeredoc");
    expect(result).toContain("kept");
  });

  it("strips heredoc marker with digits", () => {
    const input = `resource "aws_iam_role" "example" {
  policy = <<EOF2
{
  "Resource": "arn:aws:iam::123456789012:role/DigitMarker"
}
EOF2
  name = "kept"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("DigitMarker");
    expect(result).toContain("kept");
  });

  it("strips heredoc containing template directives with ARNs", () => {
    const input = `resource "aws_iam_role" "example" {
  policy = <<EOF
{
  "Statement": [
    %{ if var.enable_admin }
    {
      "Effect": "Allow",
      "Resource": "arn:aws:iam::123456789012:role/AdminInTemplate"
    }
    %{ endif }
  ]
}
EOF
  name = "kept"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("AdminInTemplate");
    expect(result).not.toContain("%{ if");
    expect(result).not.toContain("%{ endif");
    expect(result).toContain("kept");
  });

  it("strips multiple separate heredoc blocks in same file", () => {
    const input = `resource "aws_iam_role" "role_a" {
  assume_role_policy = <<ASSUME
{
  "Resource": "arn:aws:iam::111111111111:role/FirstHeredoc"
}
ASSUME
  name = "role-a"
}

resource "aws_iam_role" "role_b" {
  inline_policy = <<INLINE
{
  "Resource": "arn:aws:iam::222222222222:role/SecondHeredoc"
}
INLINE
  name = "role-b"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("FirstHeredoc");
    expect(result).not.toContain("SecondHeredoc");
    expect(result).toContain("role-a");
    expect(result).toContain("role-b");
  });

  it("strips heredoc immediately after = with no space before <<", () => {
    const input = `resource "aws_iam_role" "example" {
  policy =<<EOF
{
  "Resource": "arn:aws:iam::123456789012:role/NoSpaceHeredoc"
}
EOF
  name = "kept"
}`;
    const result = stripHeredocs(input);
    expect(result).not.toContain("NoSpaceHeredoc");
    expect(result).toContain("kept");
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

  it("parses locals blocks (no labels)", () => {
    const hcl = `
locals {
  env = "production"
}`;
    const blocks = parseHcl(hcl, "locals.tf", "repo1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("locals");
    expect(blocks[0].body).toContain("env");
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

  it("extracts aws-cn partition ARNs", () => {
    const text = `role_arn = "arn:aws-cn:iam::123456789012:role/ChinaRole"`;
    expect(extractArns(text)).toEqual(["arn:aws-cn:iam::123456789012:role/ChinaRole"]);
  });

  it("extracts aws-us-gov partition ARNs", () => {
    const text = `bucket_arn = "arn:aws-us-gov:s3:::gov-bucket"`;
    expect(extractArns(text)).toEqual(["arn:aws-us-gov:s3:::gov-bucket"]);
  });

  it("extracts mixed partition ARNs from same text", () => {
    const text = `
      role1 = "arn:aws:iam::123456789012:role/Standard"
      role2 = "arn:aws-cn:iam::123456789012:role/China"
      role3 = "arn:aws-us-gov:iam::123456789012:role/GovCloud"
    `;
    const arns = extractArns(text);
    expect(arns).toHaveLength(3);
    expect(arns).toContain("arn:aws:iam::123456789012:role/Standard");
    expect(arns).toContain("arn:aws-cn:iam::123456789012:role/China");
    expect(arns).toContain("arn:aws-us-gov:iam::123456789012:role/GovCloud");
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

describe("detectParserLimitations", () => {
  it("detects templatefile calls", () => {
    const content = `resource "aws_iam_role" "main" {
  assume_role_policy = templatefile("policy.tpl", { account_id = var.account_id })
}`;
    const warnings = detectParserLimitations(content, "role.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      filePath: "role.tf",
      line: 2,
      severity: "warning",
      message: "templatefile() call — ARN references in template files are not scanned",
    });
  });

  it("returns empty array for simple HCL", () => {
    const content = `resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}`;
    const warnings = detectParserLimitations(content, "vpc.tf");
    expect(warnings).toHaveLength(0);
  });

  it("does not warn on dynamic blocks (handled by AST parser)", () => {
    const content = `resource "aws_security_group" "main" {
  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      from_port = ingress.value.from_port
    }
  }
}`;
    const warnings = detectParserLimitations(content, "main.tf");
    expect(warnings).toHaveLength(0);
  });

  it("warns on for_each (indexed resource needs per-instance moves)", () => {
    const content = `resource "aws_iam_role" "roles" {
  for_each = {
    admin = "arn:aws:iam::123456789012:policy/Admin"
    read  = "arn:aws:iam::123456789012:policy/Read"
  }
}`;
    const warnings = detectParserLimitations(content, "roles.tf");
    expect(warnings.some((w) => w.message.includes("for_each"))).toBe(true);
  });

  it("does not warn on ternary with ARN (handled by AST parser)", () => {
    const content = `resource "aws_iam_role_policy_attachment" "attach" {
  policy_arn = var.is_prod ? "arn:aws:iam::123456789012:policy/Prod" : "arn:aws:iam::123456789012:policy/Dev"
}`;
    const warnings = detectParserLimitations(content, "attach.tf");
    expect(warnings).toHaveLength(0);
  });

  it("detects templatefile but not dynamic-block for_each in mixed file", () => {
    const content = `resource "aws_security_group" "main" {
  dynamic "ingress" {
    for_each = var.rules
    content {
      from_port = ingress.value.from_port
    }
  }
}

resource "aws_iam_role" "main" {
  assume_role_policy = templatefile("policy.tpl", {})
}`;
    const warnings = detectParserLimitations(content, "mixed.tf");
    expect(warnings.some((w) => w.message.includes("templatefile"))).toBe(true);
    // dynamic block for_each is NOT flagged (only resource-level for_each is)
    expect(warnings.filter((w) => w.message.includes("for_each"))).toHaveLength(0);
  });

  it("warns on for_each with variable", () => {
    const content = `resource "aws_iam_role" "roles" {
  for_each = var.role_names
}`;
    const warnings = detectParserLimitations(content, "roles.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("for_each");
  });

  it("warns on count = expression", () => {
    const content = `resource "aws_iam_user" "team" {
  count = length(var.users)
  name  = var.users[count.index]
}`;
    const warnings = detectParserLimitations(content, "users.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("count resource");
  });

  it("detects interpolated ARN with variable", () => {
    const content = `resource "aws_iam_role_policy_attachment" "attach" {
  policy_arn = "arn:aws:iam::\${var.account_id}:policy/Admin"
}`;
    const warnings = detectParserLimitations(content, "attach.tf");
    expect(warnings.some((w) => w.message.includes("Interpolated ARN"))).toBe(true);
  });

  it("detects interpolated ARN with data source", () => {
    const content = `resource "aws_lambda_function" "main" {
  role = "arn:aws:iam::\${data.aws_caller_identity.current.account_id}:role/lambda-exec"
}`;
    const warnings = detectParserLimitations(content, "lambda.tf");
    expect(warnings.some((w) => w.message.includes("Interpolated ARN"))).toBe(true);
  });

  it("detects interpolated ARN with aws-cn partition", () => {
    const content = `resource "aws_iam_role_policy_attachment" "attach" {
  policy_arn = "arn:aws-cn:iam::\${var.account_id}:policy/Admin"
}`;
    const warnings = detectParserLimitations(content, "attach.tf");
    expect(warnings.some((w) => w.message.includes("Interpolated ARN"))).toBe(true);
  });

  it("detects interpolated ARN with aws-us-gov partition", () => {
    const content = `resource "aws_lambda_function" "main" {
  role = "arn:aws-us-gov:iam::\${data.aws_caller_identity.current.account_id}:role/lambda-exec"
}`;
    const warnings = detectParserLimitations(content, "lambda.tf");
    expect(warnings.some((w) => w.message.includes("Interpolated ARN"))).toBe(true);
  });

  it("does not flag static ARN as interpolated", () => {
    const content = `resource "aws_iam_role_policy_attachment" "attach" {
  policy_arn = "arn:aws:iam::123456789012:policy/Admin"
}`;
    const warnings = detectParserLimitations(content, "attach.tf");
    expect(warnings.filter((w) => w.message.includes("Interpolated ARN"))).toHaveLength(0);
  });

  it("does not warn on dynamic block for_each", () => {
    const content = `resource "aws_security_group" "sg" {
  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      from_port = ingress.value.from_port
    }
  }
}`;
    const warnings = detectParserLimitations(content, "sg.tf");
    expect(warnings.filter((w) => w.message.includes("for_each"))).toHaveLength(0);
  });

  it("detects for_each with 4-space indentation", () => {
    const content = `resource "aws_iam_role" "roles" {
    for_each = var.role_names
    name     = each.key
}`;
    const warnings = detectParserLimitations(content, "roles.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("for_each");
  });

  it("detects for_each with tab indentation", () => {
    const content = `resource "aws_iam_role" "roles" {
\tfor_each = var.role_names
\tname     = each.key
}`;
    const warnings = detectParserLimitations(content, "roles.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("for_each");
  });

  it("does not warn on for_each inside nested dynamic block at any indent", () => {
    const content = `resource "aws_security_group" "sg" {
    dynamic "ingress" {
        for_each = var.ingress_rules
        content {
            from_port = ingress.value.from_port
        }
    }
    dynamic "egress" {
        for_each = var.egress_rules
        content {
            from_port = egress.value.from_port
        }
    }
}`;
    const warnings = detectParserLimitations(content, "sg.tf");
    expect(warnings.filter((w) => w.message.includes("for_each"))).toHaveLength(0);
  });

  it("does not warn on count inside a nested provisioner block", () => {
    const content = `resource "aws_instance" "main" {
  ami = "ami-123456"

  provisioner "local-exec" {
    command = "echo count = 3"
  }
}`;
    const warnings = detectParserLimitations(content, "instance.tf");
    expect(warnings.filter((w) => w.message.includes("count"))).toHaveLength(0);
  });

  it("detects count with 4-space indentation", () => {
    const content = `resource "aws_iam_user" "team" {
    count = length(var.users)
    name  = var.users[count.index]
}`;
    const warnings = detectParserLimitations(content, "users.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("count resource");
  });

  it("detects for_each in data block", () => {
    const content = `data "aws_iam_policy_document" "docs" {
  for_each = var.policy_names
}`;
    const warnings = detectParserLimitations(content, "data.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("for_each");
  });

  it("detects for_each in module block", () => {
    const content = `module "services" {
  source   = "./modules/service"
  for_each = var.service_configs
}`;
    const warnings = detectParserLimitations(content, "modules.tf");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("for_each");
  });
});

describe("parseTfFile with warnings", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("includes warnings in parsed file when limitations detected", async () => {
    const filePath = join(testDir, "main.tf");
    await writeFile(filePath, `resource "aws_iam_role" "main" {
  assume_role_policy = templatefile("policy.tpl", { account_id = var.account_id })
}`);
    const result = await parseTfFile(filePath, "test-repo");
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0].severity).toBe("warning");
  });

  it("omits warnings field when no limitations detected", async () => {
    const filePath = join(testDir, "simple.tf");
    await writeFile(filePath, `resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}`);
    const result = await parseTfFile(filePath, "test-repo");
    expect(result.warnings).toBeUndefined();
  });
});

describe("scanDirectory symlink loop detection", () => {
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

  it("handles symlink loop without infinite recursion", async () => {
    // Create: testDir/a/main.tf and testDir/a/link -> testDir (loop back to parent)
    const subDir = join(testDir, "a");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "main.tf"), `resource "aws_vpc" "loop" { cidr_block = "10.0.0.0/16" }`);
    await symlink(testDir, join(subDir, "link"));

    const results = await scanDirectory(testDir, "loop-repo");
    // Should find the one .tf file without hanging
    expect(results).toHaveLength(1);
    expect(results[0].blocks[0].name).toBe("loop");
  });

  it("handles mutual symlink loops between directories", async () => {
    // Create: testDir/a and testDir/b that symlink to each other
    const dirA = join(testDir, "a");
    const dirB = join(testDir, "b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "a.tf"), `resource "aws_vpc" "from_a" { cidr_block = "10.0.0.0/16" }`);
    await writeFile(join(dirB, "b.tf"), `resource "aws_vpc" "from_b" { cidr_block = "10.1.0.0/16" }`);
    // a/to_b -> b, b/to_a -> a
    await symlink(dirB, join(dirA, "to_b"));
    await symlink(dirA, join(dirB, "to_a"));

    const results = await scanDirectory(testDir, "mutual-repo");
    expect(results).toHaveLength(2);
    const names = results.flatMap((r) => r.blocks.map((b) => b.name)).sort();
    expect(names).toEqual(["from_a", "from_b"]);
  });

  it("follows symlinks to directories that are not loops", async () => {
    // Create testDir/real/main.tf and testDir/link -> testDir/real (valid symlink, not a loop)
    const realDir = join(testDir, "real");
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, "main.tf"), `resource "aws_vpc" "linked" { cidr_block = "10.0.0.0/16" }`);
    await symlink(realDir, join(testDir, "link"));

    const results = await scanDirectory(testDir, "symlink-repo");
    // real/main.tf found via both paths but deduped by realpath
    expect(results).toHaveLength(1);
    expect(results[0].blocks[0].name).toBe("linked");
  });
});

describe("scanDirectory parallel parsing", () => {
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

  it("parses many files in parallel and returns all results", async () => {
    // Create 15 .tf files to verify concurrency limiter works with more than 10
    for (let i = 0; i < 15; i++) {
      await writeFile(
        join(testDir, `resource-${i}.tf`),
        `resource "aws_vpc" "vpc_${i}" { cidr_block = "10.${i}.0.0/16" }`,
      );
    }

    const results = await scanDirectory(testDir, "parallel-repo");
    expect(results).toHaveLength(15);
    const names = results.flatMap((r) => r.blocks.map((b) => b.name)).sort();
    expect(names).toHaveLength(15);
    for (let i = 0; i < 15; i++) {
      expect(names).toContain(`vpc_${i}`);
    }
  });

  it("returns empty array for directory with no .tf files", async () => {
    await writeFile(join(testDir, "readme.md"), "no terraform here");
    const results = await scanDirectory(testDir, "empty-repo");
    expect(results).toHaveLength(0);
  });
});

describe("extractUnresolvedRefs", () => {
  it("detects dynamic indexing expressions", () => {
    const strings = ['${data[local.type].my_resource.value}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    expect(refs[0].reason).toBe("dynamic_index");
    expect(refs[0].expression).toContain("local.type");
  });

  it("detects computed map keys", () => {
    const strings = ['${var.roles[var.environment]}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    // var.roles[var.environment] matches dynamic_index because [var.environment] contains a dotted reference
    expect(refs[0].reason).toBe("dynamic_index");
  });

  it("detects function-based lookups", () => {
    const strings = ['${lookup(var.role_map, var.service_name, "")}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    expect(refs[0].reason).toBe("function_call");
  });

  it("detects conditional expressions", () => {
    const strings = ['${var.use_custom ? aws_iam_role.custom.arn : aws_iam_role.default.arn}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    expect(refs[0].reason).toBe("conditional");
  });

  it("detects splat expressions", () => {
    const strings = ['${aws_subnet.private.*.id}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    expect(refs[0].reason).toBe("splat");
  });

  it("detects [*] splat syntax", () => {
    const strings = ['${aws_subnet.private[*].id}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    expect(refs[0].reason).toBe("splat");
  });

  it("ignores plain static references", () => {
    const strings = ['${aws_iam_role.my_role.arn}', '${var.region}', 'static-string'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(0);
  });

  it("deduplicates identical expressions", () => {
    const strings = [
      '${lookup(var.map, "key")}',
      '${lookup(var.map, "key")}',
      '${lookup(var.map, "key")}',
    ];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
  });

  it("handles multiple different unresolved refs", () => {
    const strings = [
      '${data[local.type].resource.value}',
      '${lookup(var.arns, var.name)}',
      '${var.enabled ? aws_s3_bucket.a.id : aws_s3_bucket.b.id}',
    ];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(3);
    const reasons = refs.map((r) => r.reason);
    expect(reasons).toContain("dynamic_index");
    expect(reasons).toContain("function_call");
    expect(reasons).toContain("conditional");
  });

  it("detects each.key based indexing", () => {
    const strings = ['${var.configs[each.key].role_arn}'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    // each.key in brackets matches dynamic_index pattern (dotted ref inside brackets)
    expect(refs[0].reason).toBe("dynamic_index");
  });

  it("handles embedded interpolations in longer strings", () => {
    const strings = ['arn:aws:iam::${data[local.account_type].account.id}:role/service'];
    const refs = extractUnresolvedRefs(strings);
    expect(refs).toHaveLength(1);
    expect(refs[0].reason).toBe("dynamic_index");
  });
});
