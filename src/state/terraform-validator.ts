import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface ValidationResult {
  directory: string;
  valid: boolean;
  output: string;
  error?: string;
}

export interface ShellRunner {
  run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: ShellRunner = {
  async run(command, args, cwd) {
    return execFileAsync(command, args, { cwd });
  },
};

export interface ValidateMigratedFilesOptions {
  migratedDir: string;
  tfBinary?: string;
  runner?: ShellRunner;
}

/**
 * Runs `terraform init -backend=false` then `terraform validate` in each
 * repo subdirectory under the migrated output dir.
 */
export async function validateMigratedFiles({
  migratedDir,
  tfBinary,
  runner = defaultRunner,
}: ValidateMigratedFilesOptions): Promise<ValidationResult[]> {
  const tf = tfBinary ?? "terraform";
  const results: ValidationResult[] = [];

  // Find repo subdirectories (one level deep)
  const entries = await readdir(migratedDir);
  const repoDirs: string[] = [];

  for (const entry of entries) {
    const entryPath = join(migratedDir, entry);
    const entryStat = await stat(entryPath);
    if (entryStat.isDirectory()) {
      repoDirs.push(entryPath);
    }
  }

  if (repoDirs.length === 0) {
    logger.warn("No subdirectories found in migrated dir — nothing to validate.");
    return results;
  }

  for (const dir of repoDirs) {
    const result = await validateDirectory({ directory: dir, tfBinary: tf, runner });
    results.push(result);
  }

  return results;
}

interface ValidateDirectoryOptions {
  directory: string;
  tfBinary: string;
  runner: ShellRunner;
}

async function validateDirectory({
  directory,
  tfBinary,
  runner,
}: ValidateDirectoryOptions): Promise<ValidationResult> {
  // Step 1: terraform init -backend=false
  try {
    await runner.run(tfBinary, ["init", "-backend=false"], directory);
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return {
      directory,
      valid: false,
      output: "",
      error: `terraform init failed: ${e.stderr ?? e.message ?? "Unknown error"}`,
    };
  }

  // Step 2: terraform validate
  try {
    const { stdout } = await runner.run(tfBinary, ["validate"], directory);
    return {
      directory,
      valid: true,
      output: stdout,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      directory,
      valid: false,
      output: e.stdout ?? "",
      error: e.stderr ?? e.message ?? "Unknown error",
    };
  }
}

export interface ValidateSourceDirsOptions {
  directories: string[];
  tfBinary?: string;
  runner?: ShellRunner;
}

/**
 * Runs `terraform init -backend=false` then `terraform validate` on each
 * source repo directory directly. Used to verify that source examples or
 * post-migration applied repos are valid HCL.
 */
export async function validateSourceDirs({
  directories,
  tfBinary,
  runner = defaultRunner,
}: ValidateSourceDirsOptions): Promise<ValidationResult[]> {
  const tf = tfBinary ?? "terraform";
  const results: ValidationResult[] = [];

  for (const dir of directories) {
    const result = await validateDirectory({ directory: dir, tfBinary: tf, runner });
    results.push(result);
  }

  return results;
}
