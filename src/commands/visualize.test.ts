import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const GATEKEEPER_DIRS = "examples/gatekeeper/infra-central examples/gatekeeper/service-app-api examples/gatekeeper/service-app-analytics";
const OUTPUT_DIR = join(process.cwd(), "tmp/tests/visualize-cmd-test");

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

describe("visualize command", () => {
  afterEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("writes DOT files to output directory", () => {
    const { exitCode } = runCli(`visualize ${GATEKEEPER_DIRS} --preset gatekeeper -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(OUTPUT_DIR, "graph.dot"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "graph-before.dot"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "graph-after.dot"))).toBe(true);
  });

  it("generates valid DOT graph-before.dot with subgraphs", () => {
    runCli(`visualize ${GATEKEEPER_DIRS} --preset gatekeeper -o ${OUTPUT_DIR}`);
    const dot = readFileSync(join(OUTPUT_DIR, "graph-before.dot"), "utf-8");
    expect(dot).toContain("digraph");
    expect(dot).toContain("subgraph");
  });

  it("generates valid DOT graph-after.dot", () => {
    runCli(`visualize ${GATEKEEPER_DIRS} --preset gatekeeper -o ${OUTPUT_DIR}`);
    const dot = readFileSync(join(OUTPUT_DIR, "graph-after.dot"), "utf-8");
    expect(dot).toContain("digraph");
  });

  it("basic graph.dot is a valid DOT graph", () => {
    runCli(`visualize ${GATEKEEPER_DIRS} --preset gatekeeper -o ${OUTPUT_DIR}`);
    const dot = readFileSync(join(OUTPUT_DIR, "graph.dot"), "utf-8");
    expect(dot).toContain("digraph");
    expect(dot).toContain("rankdir");
  });

  it("works with state-dir option", () => {
    const { exitCode } = runCli(`visualize ${GATEKEEPER_DIRS} --preset gatekeeper --state-dir examples/gatekeeper/state -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(OUTPUT_DIR, "graph.dot"))).toBe(true);
  });

  it("works without preset", () => {
    const { exitCode } = runCli(`visualize ${GATEKEEPER_DIRS} -o ${OUTPUT_DIR}`);
    expect(exitCode).toBe(0);
    expect(existsSync(join(OUTPUT_DIR, "graph.dot"))).toBe(true);
  });

  it("fails with invalid path", () => {
    const { exitCode } = runCli(`visualize /nonexistent/path -o ${OUTPUT_DIR}`);
    expect(exitCode).not.toBe(0);
  });
});
