import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SPAGHETTI_DIRS = "examples/spaghetti/platform examples/spaghetti/network examples/spaghetti/services";
const GATEKEEPER_DIRS = "examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics examples/gatekeeper/infra-platform";
const OUTPUT_DIR = join(process.cwd(), "tmp/tests/migrate-cmd-test");

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("tsx", ["src/cli.ts", ...args.split(/\s+/)], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
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

describe("migrate command", () => {
  afterEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("runs dry-run and shows migration plan summary", () => {
    const { stdout, exitCode } = runCli(`migrate ${SPAGHETTI_DIRS} --preset spaghetti -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migration Plan");
    expect(stdout).toContain("Resources to move:");
    expect(stdout).toContain("ARNs to rewrite:");
  });

  it("writes output files to directory", () => {
    const { exitCode } = runCli(`migrate ${SPAGHETTI_DIRS} --preset spaghetti -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(OUTPUT_DIR, "migrate.hcl"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "migrate-plan.json"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "migrated"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "diffs"))).toBe(true);
  });

  it("generates rollback plan", () => {
    runCli(`migrate ${SPAGHETTI_DIRS} --preset spaghetti -o ${OUTPUT_DIR}`);
    expect(existsSync(join(OUTPUT_DIR, "rollback"))).toBe(true);
  });

  it("migrate-plan.json contains valid JSON with summary", () => {
    runCli(`migrate ${SPAGHETTI_DIRS} --preset spaghetti -o ${OUTPUT_DIR}`);
    const planContent = readFileSync(join(OUTPUT_DIR, "migrate-plan.json"), "utf-8");
    const plan = JSON.parse(planContent);
    expect(plan).toHaveProperty("summary");
    expect(plan.summary).toHaveProperty("resourcesMoved");
    expect(plan.summary).toHaveProperty("arnsRewritten");
  });

  it("generates unified diffs", () => {
    runCli(`migrate ${SPAGHETTI_DIRS} --preset spaghetti -o ${OUTPUT_DIR}`);
    const diffsDir = join(OUTPUT_DIR, "diffs");
    expect(existsSync(diffsDir)).toBe(true);
    if (existsSync(join(diffsDir, "migration.diff"))) {
      const diff = readFileSync(join(diffsDir, "migration.diff"), "utf-8");
      expect(diff.length).toBeGreaterThan(0);
    }
  });

  it("supports --namespace filter with matching namespace", () => {
    const { stdout, exitCode } = runCli(
      `migrate ${SPAGHETTI_DIRS} --preset spaghetti --namespace platform -o ${OUTPUT_DIR}`,
    );
    expect(exitCode).toBe(0);
    // May or may not find edges for this specific namespace
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("reports no edges when namespace has none", () => {
    const { stdout, exitCode } = runCli(
      `migrate ${GATEKEEPER_DIRS} --preset gatekeeper --namespace nonexistent-ns -o ${OUTPUT_DIR}`,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No cross-namespace dependencies");
  });

  it("reports no edges when gatekeeper has no graph edges", () => {
    const { stdout, exitCode } = runCli(
      `migrate ${GATEKEEPER_DIRS} --preset gatekeeper -o ${OUTPUT_DIR}`,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No cross-namespace dependencies");
  });

  it("supports --mode moved", () => {
    const { stdout, exitCode } = runCli(
      `migrate ${SPAGHETTI_DIRS} --preset spaghetti --mode moved -o ${OUTPUT_DIR}`,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migration Plan");
  });

  it("supports --mode tfmigrate", () => {
    const { stdout, exitCode } = runCli(
      `migrate ${SPAGHETTI_DIRS} --preset spaghetti --mode tfmigrate -o ${OUTPUT_DIR}`,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migration Plan");
  });

  it("fails with invalid path", () => {
    const { exitCode } = runCli(`migrate /nonexistent/path --preset gatekeeper -o ${OUTPUT_DIR}`);
    expect(exitCode).not.toBe(0);
  });
});
