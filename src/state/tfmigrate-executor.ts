import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MigrationStep, MigrationPlan } from "../types.js";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  success: boolean;
  step: MigrationStep;
  output: string;
  error?: string;
}

export interface ExecutorOptions {
  dryRun: boolean;
  workingDir: string;
  tfBinary?: string;
}

export interface ShellRunner {
  run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: ShellRunner = {
  async run(command, args, cwd) {
    return execFileAsync(command, args, { cwd });
  },
};

export function checkPrerequisites(
  opts: ExecutorOptions,
  runner: ShellRunner = defaultRunner,
): Promise<{ terraform: boolean; tfmigrate: boolean }> {
  const tfBinary = opts.tfBinary ?? "terraform";
  return Promise.all([
    runner.run(tfBinary, ["version"], opts.workingDir).then(() => true).catch(() => false),
    runner.run("tfmigrate", ["--version"], opts.workingDir).then(() => true).catch(() => false),
  ]).then(([terraform, tfmigrate]) => ({ terraform, tfmigrate }));
}

export async function dryRunMigration(
  hclPath: string,
  opts: ExecutorOptions,
  runner: ShellRunner = defaultRunner,
): Promise<ExecutionResult> {
  const step: MigrationStep = {
    type: "verify",
    command: `tfmigrate plan ${hclPath}`,
    description: `Dry-run migration: ${hclPath}`,
  };

  try {
    const { stdout } = await runner.run("tfmigrate", ["plan", hclPath], opts.workingDir);
    return { success: true, step, output: stdout };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return { success: false, step, output: "", error: e.stderr ?? e.message ?? "Unknown error" };
  }
}

export function generateRollback(plan: MigrationPlan): string {
  const lines = ["#!/bin/bash", "set -euo pipefail", "", "# Rollback migration", ""];

  const stateMovSteps = plan.steps.filter((s) => s.type === "state_mv" && s.command);
  for (const step of stateMovSteps.reverse()) {
    // Reverse the state mv: swap -state and -state-out
    const reversed = step.command!
      .replace(/-state=([^\s]+)\s+-state-out=([^\s]+)/, "-state=$2 -state-out=$1");
    lines.push(`# Rollback: ${step.description}`);
    lines.push(reversed);
    lines.push("");
  }

  return lines.join("\n");
}
