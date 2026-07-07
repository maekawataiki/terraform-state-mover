import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const GATEKEEPER_DIRS = "examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics";

let outDir: string;

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("tsx", ["src/cli.ts", ...args.split(/\s+/)], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: "production" },
      shell: true,
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

describe("plan command (subprocess)", () => {
  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "tfmover-plan-"));
  });

  afterAll(() => {
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("generates plan files and outputs summary", () => {
    const { stdout, exitCode, stderr } = runCli(`plan ${GATEKEEPER_DIRS} --state-dir examples/gatekeeper/state -o ${outDir}`);
    expect(exitCode, `CLI failed with stderr: ${stderr}`).toBe(0);

    // Stdout validation
    expect(stdout).toContain("Migration Plan");
    expect(stdout).toContain("Steps:");
    expect(stdout).toContain("Cross-namespace edges:");

    // File existence
    expect(existsSync(join(outDir, "plan.json"))).toBe(true);
    expect(existsSync(join(outDir, "migrate.sh"))).toBe(true);
    expect(existsSync(join(outDir, "migrate.hcl"))).toBe(true);

    // Content validation
    const plan = JSON.parse(readFileSync(join(outDir, "plan.json"), "utf-8"));
    expect(plan).toHaveProperty("steps");
    expect(Array.isArray(plan.steps)).toBe(true);

    const script = readFileSync(join(outDir, "migrate.sh"), "utf-8");
    expect(script).toContain("terraform");
  });

  it("fails with invalid path", () => {
    const { exitCode } = runCli(`plan /nonexistent/path -o ${outDir}`);
    expect(exitCode).not.toBe(0);
  });
});
