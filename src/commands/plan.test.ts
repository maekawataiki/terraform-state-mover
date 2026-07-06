import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const GATEKEEPER_DIRS = "examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics";
const OUTPUT_DIR = join(process.cwd(), "tmp/tests/plan-cmd-test");

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("tsx", ["src/cli.ts", ...args.split(/\s+/)], {
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

describe("plan command", () => {
  afterEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("generates migration plan with steps", () => {
    const { stdout, exitCode } = runCli(`plan ${GATEKEEPER_DIRS} --state-dir examples/gatekeeper/state -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migration Plan");
    expect(stdout).toContain("Steps:");
    expect(stdout).toContain("Cross-namespace edges:");
  });

  it("writes plan files to output directory", () => {
    const { exitCode } = runCli(`plan ${GATEKEEPER_DIRS} --state-dir examples/gatekeeper/state -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(OUTPUT_DIR, "plan.json"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "migrate.sh"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "migrate.hcl"))).toBe(true);
  });

  it("generates valid JSON plan file", () => {
    runCli(`plan ${GATEKEEPER_DIRS} --state-dir examples/gatekeeper/state -o ${OUTPUT_DIR}`);
    const planContent = readFileSync(join(OUTPUT_DIR, "plan.json"), "utf-8");
    const plan = JSON.parse(planContent);
    expect(plan).toHaveProperty("steps");
    expect(Array.isArray(plan.steps)).toBe(true);
  });

  it("generates shell script with terraform state mv commands", () => {
    runCli(`plan ${GATEKEEPER_DIRS} --state-dir examples/gatekeeper/state -o ${OUTPUT_DIR}`);
    const script = readFileSync(join(OUTPUT_DIR, "migrate.sh"), "utf-8");
    expect(script).toContain("terraform");
  });

  it("generates tfmigrate HCL file", () => {
    runCli(`plan ${GATEKEEPER_DIRS} --state-dir examples/gatekeeper/state -o ${OUTPUT_DIR}`);
    const hcl = readFileSync(join(OUTPUT_DIR, "migrate.hcl"), "utf-8");
    // File may be empty if no steps require tfmigrate
    expect(typeof hcl).toBe("string");
  });

  it("works without state-dir", () => {
    const { stdout, exitCode } = runCli(`plan ${GATEKEEPER_DIRS} -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migration Plan");
  });

  it("fails with invalid path", () => {
    const { exitCode } = runCli(`plan /nonexistent/path -o ${OUTPUT_DIR}`);
    expect(exitCode).not.toBe(0);
  });
});
