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

describe("visualize command (subprocess)", () => {
  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "tfmover-vis-"));
  });

  afterAll(() => {
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("generates DOT files with preset and validates content", () => {
    const { exitCode, stderr } = runCli(`visualize ${GATEKEEPER_DIRS} --preset gatekeeper -o ${outDir}`);
    expect(exitCode, `CLI failed with stderr: ${stderr}`).toBe(0);

    // File existence
    expect(existsSync(join(outDir, "graph.dot"))).toBe(true);
    expect(existsSync(join(outDir, "graph-before.dot"))).toBe(true);
    expect(existsSync(join(outDir, "graph-after.dot"))).toBe(true);

    // Content validation
    const before = readFileSync(join(outDir, "graph-before.dot"), "utf-8");
    expect(before).toContain("digraph");
    expect(before).toContain("subgraph");

    const after = readFileSync(join(outDir, "graph-after.dot"), "utf-8");
    expect(after).toContain("digraph");

    const basic = readFileSync(join(outDir, "graph.dot"), "utf-8");
    expect(basic).toContain("digraph");
    expect(basic).toContain("rankdir");
  });

  it("fails with invalid path", () => {
    const { exitCode } = runCli(`visualize /nonexistent/path -o ${outDir}`);
    expect(exitCode).not.toBe(0);
  });
});
