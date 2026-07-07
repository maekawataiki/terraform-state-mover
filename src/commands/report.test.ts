import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testBase: string;
let graphJsonPath: string;

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

describe("report command (subprocess)", () => {
  beforeAll(() => {
    testBase = mkdtempSync(join(tmpdir(), "tfmover-rpt-"));
    // Generate graph.json via analyze command
    const analyzeDir = join(testBase, "analyze");
    runCli(
      `analyze examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics --preset gatekeeper --state-dir examples/gatekeeper/state -o ${analyzeDir}`,
    );
    graphJsonPath = join(analyzeDir, "graph.json");
  });

  afterAll(() => {
    if (existsSync(testBase)) {
      rmSync(testBase, { recursive: true, force: true });
    }
  });

  it("generates report with Diagnosis section", () => {
    const reportDir = join(testBase, "report");
    const { exitCode, stderr } = runCli(`report ${graphJsonPath} --preset gatekeeper -o ${reportDir}`);
    expect(exitCode, `CLI failed with stderr: ${stderr}`).toBe(0);
    expect(existsSync(join(reportDir, "report.md"))).toBe(true);
    const report = readFileSync(join(reportDir, "report.md"), "utf-8");
    expect(report).toContain("Diagnosis");
    expect(report).toContain("Gatekeeper");
  });

  it("fails with invalid file path", () => {
    const { exitCode } = runCli(`report /nonexistent/graph.json -o ${testBase}`);
    expect(exitCode).not.toBe(0);
  });

  it("fails with malformed JSON", () => {
    const badFile = join(testBase, "bad.json");
    writeFileSync(badFile, "not json");
    const { exitCode } = runCli(`report ${badFile} -o ${testBase}`);
    expect(exitCode).not.toBe(0);
  });
});
