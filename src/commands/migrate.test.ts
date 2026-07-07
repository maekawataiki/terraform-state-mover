import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SPAGHETTI_DIRS = "examples/spaghetti/platform examples/spaghetti/network examples/spaghetti/services";
const GATEKEEPER_DIRS = "examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics examples/gatekeeper/infra-platform";

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

describe("migrate command (subprocess)", () => {
  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "tfmover-mig-"));
  });

  afterAll(() => {
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("generates full migration output for spaghetti preset", () => {
    const { stdout, exitCode, stderr } = runCli(`migrate ${SPAGHETTI_DIRS} --preset spaghetti -o ${outDir}`);
    expect(exitCode, `CLI failed with stderr: ${stderr}`).toBe(0);

    // Stdout validation
    expect(stdout).toContain("Migration Plan");
    expect(stdout).toContain("Resources to move:");
    expect(stdout).toContain("ARNs to rewrite:");

    // File existence
    expect(existsSync(join(outDir, "migrate.hcl"))).toBe(true);
    expect(existsSync(join(outDir, "migrate-plan.json"))).toBe(true);
    expect(existsSync(join(outDir, "migrated"))).toBe(true);
    expect(existsSync(join(outDir, "diffs"))).toBe(true);
    expect(existsSync(join(outDir, "rollback"))).toBe(true);

    // Content validation
    const plan = JSON.parse(readFileSync(join(outDir, "migrate-plan.json"), "utf-8"));
    expect(plan).toHaveProperty("summary");
    expect(plan.summary).toHaveProperty("resourcesMoved");
    expect(plan.summary).toHaveProperty("arnsRewritten");
  });

  it("reports no edges for gatekeeper example", () => {
    const { stdout, exitCode } = runCli(`migrate ${GATEKEEPER_DIRS} --preset gatekeeper -o ${outDir}`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No cross-namespace dependencies");
  });

  it("fails with invalid path", () => {
    const { exitCode } = runCli(`migrate /nonexistent/path --preset gatekeeper -o ${outDir}`);
    expect(exitCode).not.toBe(0);
  });
});
