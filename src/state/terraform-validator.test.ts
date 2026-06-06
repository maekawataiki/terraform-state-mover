import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { validateMigratedFiles } from "./terraform-validator.js";
import type { ShellRunner } from "./terraform-validator.js";

describe("terraform-validator", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  function createMockRunner(responses: Map<string, { stdout: string; stderr: string } | Error>): ShellRunner {
    return {
      async run(command: string, args: string[], cwd: string) {
        const key = `${args.join(" ")}@${cwd}`;
        for (const [pattern, response] of responses) {
          if (key.includes(pattern)) {
            if (response instanceof Error) {
              throw response;
            }
            return response;
          }
        }
        return { stdout: "", stderr: "" };
      },
    };
  }

  describe("validateMigratedFiles", () => {
    it("returns success for all valid directories", async () => {
      const migratedDir = join(testDir, "migrated");
      await mkdir(join(migratedDir, "service-api"), { recursive: true });
      await mkdir(join(migratedDir, "infra-central"), { recursive: true });
      await writeFile(join(migratedDir, "service-api", "main.tf"), "resource \"aws_iam_role\" \"test\" {}");
      await writeFile(join(migratedDir, "infra-central", "main.tf"), "resource \"aws_s3_bucket\" \"test\" {}");

      const runner = createMockRunner(new Map([
        ["init -backend=false", { stdout: "Initializing...", stderr: "" }],
        ["validate", { stdout: "Success! The configuration is valid.", stderr: "" }],
      ]));

      const results = await validateMigratedFiles({ migratedDir, runner });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.valid)).toBe(true);
      expect(results[0].output).toBe("Success! The configuration is valid.");
    });

    it("returns failure when terraform validate fails", async () => {
      const migratedDir = join(testDir, "migrated");
      await mkdir(join(migratedDir, "service-api"), { recursive: true });
      await writeFile(join(migratedDir, "service-api", "main.tf"), "invalid hcl");

      const serviceApiDir = join(migratedDir, "service-api");
      const runner: ShellRunner = {
        async run(_command: string, args: string[], cwd: string) {
          if (args[0] === "init") {
            return { stdout: "Initializing...", stderr: "" };
          }
          if (args[0] === "validate" && cwd === serviceApiDir) {
            const err = new Error("Validation failed") as Error & { stderr: string; stdout: string };
            err.stderr = "Error: Unsupported block type";
            err.stdout = "";
            throw err;
          }
          return { stdout: "", stderr: "" };
        },
      };

      const results = await validateMigratedFiles({ migratedDir, runner });

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].error).toBe("Error: Unsupported block type");
    });

    it("returns failure when terraform init fails", async () => {
      const migratedDir = join(testDir, "migrated");
      await mkdir(join(migratedDir, "service-api"), { recursive: true });
      await writeFile(join(migratedDir, "service-api", "main.tf"), "resource \"aws_iam_role\" \"test\" {}");

      const runner: ShellRunner = {
        async run(_command: string, args: string[]) {
          if (args[0] === "init") {
            const err = new Error("Init failed") as Error & { stderr: string };
            err.stderr = "Error: Failed to install provider";
            throw err;
          }
          return { stdout: "", stderr: "" };
        },
      };

      const results = await validateMigratedFiles({ migratedDir, runner });

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].error).toContain("terraform init failed");
      expect(results[0].error).toContain("Failed to install provider");
    });

    it("handles missing terraform binary gracefully", async () => {
      const migratedDir = join(testDir, "migrated");
      await mkdir(join(migratedDir, "service-api"), { recursive: true });
      await writeFile(join(migratedDir, "service-api", "main.tf"), "resource \"aws_iam_role\" \"test\" {}");

      const runner: ShellRunner = {
        async run() {
          const err = new Error("ENOENT") as Error & { stderr: string; code: string };
          err.code = "ENOENT";
          err.stderr = "";
          throw err;
        },
      };

      const results = await validateMigratedFiles({ migratedDir, runner });

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].error).toContain("terraform init failed");
    });

    it("returns empty array when no subdirectories exist", async () => {
      const migratedDir = join(testDir, "migrated");
      await mkdir(migratedDir, { recursive: true });
      // No subdirs — only a plain file
      await writeFile(join(migratedDir, "readme.txt"), "no repos here");

      const runner = createMockRunner(new Map());

      const results = await validateMigratedFiles({ migratedDir, runner });

      expect(results).toHaveLength(0);
    });

    it("uses custom tfBinary when provided", async () => {
      const migratedDir = join(testDir, "migrated");
      await mkdir(join(migratedDir, "repo-a"), { recursive: true });
      await writeFile(join(migratedDir, "repo-a", "main.tf"), "");

      const capturedCommands: string[] = [];
      const runner: ShellRunner = {
        async run(command: string, args: string[]) {
          capturedCommands.push(command);
          return { stdout: "ok", stderr: "" };
        },
      };

      await validateMigratedFiles({ migratedDir, tfBinary: "/usr/local/bin/tofu", runner });

      expect(capturedCommands.every((c) => c === "/usr/local/bin/tofu")).toBe(true);
    });
  });
});
