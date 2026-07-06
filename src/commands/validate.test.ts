import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CLI = "tsx src/cli.ts";
const OUTPUT_DIR = join(process.cwd(), "tmp/tests/validate-cmd-test");

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`${CLI} ${args}`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "production" },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      exitCode: error.status ?? 1,
    };
  }
}

describe("validate command", () => {
  afterEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("fails with invalid file path", () => {
    const { exitCode, stderr } = runCli("validate /nonexistent/migrate.hcl");
    expect(exitCode).not.toBe(0);
  });

  it("fails when tfmigrate is not installed", () => {
    // Create a valid HCL file but tfmigrate likely not in PATH
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const hclFile = join(OUTPUT_DIR, "migrate.hcl");
    writeFileSync(hclFile, `
migration "state" "mv_role" {
  actions = [
    "mv aws_iam_role.api_role aws_iam_role.api_role",
  ]
}
`);
    const { exitCode, stderr } = runCli(`validate ${hclFile}`);
    // Should fail because tfmigrate is likely not installed in CI/local
    expect(exitCode).not.toBe(0);
  });

  it("accepts --tf-binary option", () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const hclFile = join(OUTPUT_DIR, "migrate.hcl");
    writeFileSync(hclFile, `
migration "state" "test" {
  actions = ["mv a.b c.d"]
}
`);
    // Even with custom binary, tfmigrate check fails first
    const { exitCode } = runCli(`validate ${hclFile} --tf-binary terraform`);
    expect(exitCode).not.toBe(0);
  });
});
