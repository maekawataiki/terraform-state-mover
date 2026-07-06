import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AnalyzeJsonOutput } from "./analyze.js";

const GATEKEEPER_ARGS = "analyze examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics examples/gatekeeper/infra-platform --preset gatekeeper --state-dir examples/gatekeeper/state";

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

describe("analyze --json", () => {
  it("outputs valid JSON to stdout", () => {
    const { stdout, exitCode } = runCli(`${GATEKEEPER_ARGS} --json`);
    expect(exitCode).toBe(0);

    const output: AnalyzeJsonOutput = JSON.parse(stdout);
    expect(output.version).toBe("0.1.0");
    expect(output.summary.resources).toBeGreaterThan(0);
    expect(output.summary.edges).toBeGreaterThan(0);
    expect(output.summary.repos.length).toBeGreaterThan(0);
    expect(Array.isArray(output.patterns)).toBe(true);
    expect(Array.isArray(output.warnings)).toBe(true);
    expect(Array.isArray(output.unresolvedRefs)).toBe(true);
  });

  it("detects gatekeeper pattern in JSON output", () => {
    const { stdout } = runCli(`${GATEKEEPER_ARGS} --json`);
    const output: AnalyzeJsonOutput = JSON.parse(stdout);

    const gatekeeper = output.patterns.find((p) => p.name === "Gatekeeper");
    expect(gatekeeper).toBeDefined();
    expect(gatekeeper!.severity).toBe("critical");
    expect(gatekeeper!.evidence.length).toBeGreaterThan(0);
  });

  it("includes cross-namespace edge count", () => {
    const { stdout } = runCli(`${GATEKEEPER_ARGS} --json`);
    const output: AnalyzeJsonOutput = JSON.parse(stdout);
    expect(output.summary.crossNamespaceEdges).toBeGreaterThanOrEqual(0);
  });

  it("includes repo list", () => {
    const { stdout } = runCli(`${GATEKEEPER_ARGS} --json`);
    const output: AnalyzeJsonOutput = JSON.parse(stdout);
    expect(output.summary.repos).toContain("infra-central");
    expect(output.summary.repos).toContain("service-app-api");
  });
});

describe("analyze --strict", () => {
  it("exits with code 1 when anti-patterns are detected", () => {
    const { exitCode, stderr } = runCli(`${GATEKEEPER_ARGS} --strict`);
    expect(exitCode).toBe(1);
  });

  it("exits with code 0 when no issues detected (empty repo)", () => {
    // Use a single clean repo with no anti-patterns
    const { exitCode } = runCli(`analyze examples/gatekeeper/service-app-api --strict`);
    expect(exitCode).toBe(0);
  });

  it("works with --json", () => {
    const { stdout, exitCode } = runCli(`${GATEKEEPER_ARGS} --json --strict`);
    expect(exitCode).toBe(1);

    // JSON should still be valid
    const output: AnalyzeJsonOutput = JSON.parse(stdout);
    expect(output.patterns.length).toBeGreaterThan(0);
  });
});

describe("analyze human output enhancements", () => {
  it("shows anti-pattern summary in human mode", () => {
    const { stdout, exitCode } = runCli(GATEKEEPER_ARGS);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Detected Anti-Patterns");
    expect(stdout).toContain("Gatekeeper");
  });

  it("shows cross-namespace edge count", () => {
    const { stdout } = runCli(GATEKEEPER_ARGS);
    expect(stdout).toContain("Cross-namespace edges:");
  });
});
