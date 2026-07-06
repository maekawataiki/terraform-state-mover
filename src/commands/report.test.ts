import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_DIR = join(process.cwd(), "tmp/tests/report-cmd-test");
const ANALYZE_DIR = join(OUTPUT_DIR, "analyze-out");

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

describe("report command", () => {
  const graphJsonPath = join(ANALYZE_DIR, "graph.json");

  beforeAll(() => {
    mkdirSync(ANALYZE_DIR, { recursive: true });
    // Generate graph.json via analyze command
    runCli(
      `analyze examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics --preset gatekeeper --state-dir examples/gatekeeper/state -o ${ANALYZE_DIR}`,
    );
  });

  afterAll(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("writes report with Diagnosis section to output directory", () => {
    const reportDir = join(OUTPUT_DIR, "report-out");
    const { exitCode } = runCli(`report ${graphJsonPath} --preset gatekeeper -o ${reportDir}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(reportDir, "report.md"))).toBe(true);
    const report = readFileSync(join(reportDir, "report.md"), "utf-8");
    expect(report).toContain("Diagnosis");
  });

  it("report contains anti-pattern analysis", () => {
    const reportDir = join(OUTPUT_DIR, "report-patterns");
    const { exitCode } = runCli(`report ${graphJsonPath} --preset gatekeeper -o ${reportDir}`);
    expect(exitCode).toBe(0);
    const report = readFileSync(join(reportDir, "report.md"), "utf-8");
    expect(report).toContain("Gatekeeper");
  });

  it("works without preset", () => {
    const reportDir = join(OUTPUT_DIR, "report-no-preset");
    const { exitCode } = runCli(`report ${graphJsonPath} -o ${reportDir}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(reportDir, "report.md"))).toBe(true);
    const report = readFileSync(join(reportDir, "report.md"), "utf-8");
    expect(report).toContain("Diagnosis");
  });

  it("fails with invalid file path", () => {
    const { exitCode } = runCli(`report /nonexistent/graph.json -o ${OUTPUT_DIR}/fail`);
    expect(exitCode).not.toBe(0);
  });

  it("fails with malformed JSON", () => {
    const badFile = join(OUTPUT_DIR, "bad.json");
    writeFileSync(badFile, "not json");
    const { exitCode } = runCli(`report ${badFile} -o ${OUTPUT_DIR}/fail`);
    expect(exitCode).not.toBe(0);
  });
});
