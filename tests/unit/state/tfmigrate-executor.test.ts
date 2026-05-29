import { describe, it, expect } from "vitest";
import { checkPrerequisites, dryRunMigration, generateRollback } from "../../../src/state/tfmigrate-executor.js";
import type { ShellRunner } from "../../../src/state/tfmigrate-executor.js";
import type { MigrationPlan } from "../../../src/types.js";

describe("tfmigrate-executor", () => {
  describe("checkPrerequisites", () => {
    it("returns true for both when binaries exist", async () => {
      const runner: ShellRunner = {
        run: async () => ({ stdout: "v1.0.0", stderr: "" }),
      };
      const result = await checkPrerequisites({ dryRun: true, workingDir: "." }, runner);
      expect(result).toEqual({ terraform: true, tfmigrate: true });
    });

    it("returns false for terraform when binary is missing", async () => {
      const runner: ShellRunner = {
        run: async (cmd) => {
          if (cmd === "terraform") throw new Error("not found");
          return { stdout: "v0.3.0", stderr: "" };
        },
      };
      const result = await checkPrerequisites({ dryRun: true, workingDir: "." }, runner);
      expect(result.terraform).toBe(false);
      expect(result.tfmigrate).toBe(true);
    });

    it("returns false for tfmigrate when binary is missing", async () => {
      const runner: ShellRunner = {
        run: async (cmd) => {
          if (cmd === "tfmigrate") throw new Error("not found");
          return { stdout: "v1.5.0", stderr: "" };
        },
      };
      const result = await checkPrerequisites({ dryRun: true, workingDir: "." }, runner);
      expect(result.terraform).toBe(true);
      expect(result.tfmigrate).toBe(false);
    });

    it("uses custom tfBinary option", async () => {
      const calls: string[] = [];
      const runner: ShellRunner = {
        run: async (cmd) => {
          calls.push(cmd);
          return { stdout: "ok", stderr: "" };
        },
      };
      await checkPrerequisites({ dryRun: true, workingDir: ".", tfBinary: "tofu" }, runner);
      expect(calls).toContain("tofu");
      expect(calls).not.toContain("terraform");
    });
  });

  describe("dryRunMigration", () => {
    it("returns success when tfmigrate plan succeeds", async () => {
      const runner: ShellRunner = {
        run: async () => ({ stdout: "No changes. Your infrastructure matches the configuration.", stderr: "" }),
      };
      const result = await dryRunMigration("migrate.hcl", { dryRun: true, workingDir: "." }, runner);
      expect(result.success).toBe(true);
      expect(result.output).toContain("No changes");
    });

    it("returns failure when tfmigrate plan fails", async () => {
      const runner: ShellRunner = {
        run: async () => { throw { stderr: "Error: state mv failed", message: "exit 1" }; },
      };
      const result = await dryRunMigration("migrate.hcl", { dryRun: true, workingDir: "." }, runner);
      expect(result.success).toBe(false);
      expect(result.error).toContain("state mv failed");
    });

    it("populates step metadata", async () => {
      const runner: ShellRunner = {
        run: async () => ({ stdout: "ok", stderr: "" }),
      };
      const result = await dryRunMigration("my-plan.hcl", { dryRun: true, workingDir: "/tmp" }, runner);
      expect(result.step.command).toContain("my-plan.hcl");
      expect(result.step.type).toBe("verify");
    });
  });

  describe("generateRollback", () => {
    it("generates reversed state mv commands", () => {
      const plan: MigrationPlan = {
        steps: [
          {
            type: "state_mv",
            command: "terraform state mv -state=infra-central/terraform.tfstate -state-out=service-app-api/terraform.tfstate 'aws_iam_role.app_api_db_access' 'aws_iam_role.app_api_db_access'",
            description: "Move role from central to service",
            resource: "aws_iam_role.app_api_db_access",
            targetRepo: "service-app-api",
          },
          { type: "verify", command: "terraform plan", description: "Verify" },
        ],
        crossNamespaceEdges: [],
        shellScript: "",
        json: "{}",
        tfmigrateHcl: "",
      };

      const rollback = generateRollback(plan);
      expect(rollback).toContain("#!/bin/bash");
      expect(rollback).toContain("set -euo pipefail");
      expect(rollback).toContain("-state=service-app-api/terraform.tfstate -state-out=infra-central/terraform.tfstate");
    });

    it("reverses steps in reverse order", () => {
      const plan: MigrationPlan = {
        steps: [
          {
            type: "state_mv",
            command: "terraform state mv -state=a/terraform.tfstate -state-out=b/terraform.tfstate 'r1' 'r1'",
            description: "Step 1",
          },
          {
            type: "state_mv",
            command: "terraform state mv -state=c/terraform.tfstate -state-out=d/terraform.tfstate 'r2' 'r2'",
            description: "Step 2",
          },
          { type: "verify", command: "terraform plan", description: "Verify" },
        ],
        crossNamespaceEdges: [],
        shellScript: "",
        json: "{}",
        tfmigrateHcl: "",
      };

      const rollback = generateRollback(plan);
      const step2Idx = rollback.indexOf("-state=d/terraform.tfstate");
      const step1Idx = rollback.indexOf("-state=b/terraform.tfstate");
      // Step 2 should appear before Step 1 in rollback (reversed)
      expect(step2Idx).toBeLessThan(step1Idx);
    });
  });
});
