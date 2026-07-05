import { describe, it, expect } from "vitest";
import { generateRollbackPlan } from "./rollback-generator.js";
import type { MigrateResult } from "../types.js";

function createEmptyResult(): MigrateResult {
  return {
    moves: [],
    variableDeclarations: [],
    outputDeclarations: [],
    movedBlocks: [],
    importBlocks: [],
    removedBlocks: [],
    fileWrites: [],
    tfmigrateHcl: "",
    summary: {
      resourcesMoved: 0,
      arnsRewritten: 0,
      outputsGenerated: 0,
      filesModified: 0,
    },
  };
}

describe("generateRollbackPlan", () => {
  it("generates reverse removed blocks from import blocks", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      importBlocks: [
        { to: "aws_iam_role.api_role", id: "api-role-id", repo: "service-api" },
        { to: "aws_iam_policy.api_policy", id: "api-policy-id", repo: "service-api" },
      ],
      summary: { resourcesMoved: 2, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
    };

    const rollback = generateRollbackPlan(result);

    // Should generate removed blocks for service-api (reverse of imports)
    const removedFile = rollback.fileWrites.find((fw) => fw.filePath.includes("rollback-removed.tf"));
    expect(removedFile).toBeDefined();
    expect(removedFile!.filePath).toBe("service-api/rollback-removed.tf");
    expect(removedFile!.content).toContain("from = aws_iam_role.api_role");
    expect(removedFile!.content).toContain("from = aws_iam_policy.api_policy");
    expect(removedFile!.content).toContain("destroy = false");
    expect(removedFile!.operation).toBe("create");
  });

  it("generates reverse import blocks from removed blocks", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      removedBlocks: [
        { from: "aws_iam_role.api_role", repo: "infra-central", destroy: false },
        { from: "aws_iam_role.analytics_role", repo: "infra-central", destroy: false },
      ],
      summary: { resourcesMoved: 2, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
    };

    const rollback = generateRollbackPlan(result);

    // Should generate import blocks for infra-central (reverse of removals)
    const importFile = rollback.fileWrites.find((fw) => fw.filePath.includes("rollback-imports.tf"));
    expect(importFile).toBeDefined();
    expect(importFile!.filePath).toBe("infra-central/rollback-imports.tf");
    expect(importFile!.content).toContain("to = aws_iam_role.api_role");
    expect(importFile!.content).toContain("to = aws_iam_role.analytics_role");
    expect(importFile!.content).toContain('id = "<RESOURCE_ID>"');
    expect(importFile!.operation).toBe("create");
  });

  it("returns empty rollback for empty migration", () => {
    const result = createEmptyResult();

    const rollback = generateRollbackPlan(result);

    expect(rollback.fileWrites).toHaveLength(0);
    expect(rollback.tfmigrateHcl).toBe("");
    expect(rollback.description).toContain("reverses 0 resource moves");
  });

  it("generates tfmigrate HCL with reversed state_mv commands", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      moves: [
        {
          sourceFilePath: "/infra-central/iam.tf",
          targetFilePath: "/service-api/iam.tf",
          block: { type: "resource", resourceType: "aws_iam_role", name: "api_role", body: "", stringLiterals: [], arns: [], filePath: "/infra-central/iam.tf", repo: "infra-central" },
          sourceRepo: "infra-central",
          targetRepo: "service-api",
        },
        {
          sourceFilePath: "/infra-central/iam.tf",
          targetFilePath: "/service-payments/iam.tf",
          block: { type: "resource", resourceType: "aws_iam_role", name: "payments_role", body: "", stringLiterals: [], arns: [], filePath: "/infra-central/iam.tf", repo: "infra-central" },
          sourceRepo: "infra-central",
          targetRepo: "service-payments",
        },
      ],
      summary: { resourcesMoved: 2, arnsRewritten: 0, outputsGenerated: 0, filesModified: 4 },
    };

    const rollback = generateRollbackPlan(result);

    expect(rollback.tfmigrateHcl).toContain("migration \"multi_state\"");
    // Reversed: target → source
    expect(rollback.tfmigrateHcl).toContain('state_mv "service-api" "infra-central" "aws_iam_role.api_role"');
    expect(rollback.tfmigrateHcl).toContain('state_mv "service-payments" "infra-central" "aws_iam_role.payments_role"');
  });

  it("generates fileWrites with correct paths and operations for multiple repos", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      importBlocks: [
        { to: "aws_iam_role.api_role", id: "role-123", repo: "service-api" },
        { to: "aws_iam_role.payments_role", id: "role-456", repo: "service-payments" },
      ],
      removedBlocks: [
        { from: "aws_iam_role.api_role", repo: "infra-central", destroy: false },
        { from: "aws_iam_role.payments_role", repo: "infra-central", destroy: false },
      ],
      summary: { resourcesMoved: 2, arnsRewritten: 0, outputsGenerated: 0, filesModified: 4 },
    };

    const rollback = generateRollbackPlan(result);

    // Should have: 1 import file (infra-central), 2 removed files (service-api, service-payments), 1 rollback.sh
    expect(rollback.fileWrites).toHaveLength(4);

    const importFile = rollback.fileWrites.find((fw) => fw.filePath === "infra-central/rollback-imports.tf");
    expect(importFile).toBeDefined();
    expect(importFile!.operation).toBe("create");

    const apiRemoved = rollback.fileWrites.find((fw) => fw.filePath === "service-api/rollback-removed.tf");
    expect(apiRemoved).toBeDefined();
    expect(apiRemoved!.operation).toBe("create");

    const paymentsRemoved = rollback.fileWrites.find((fw) => fw.filePath === "service-payments/rollback-removed.tf");
    expect(paymentsRemoved).toBeDefined();
    expect(paymentsRemoved!.operation).toBe("create");
  });

  it("includes instructional steps in the rollback plan", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      importBlocks: [
        { to: "aws_iam_role.api_role", id: "role-123", repo: "service-api" },
      ],
      removedBlocks: [
        { from: "aws_iam_role.api_role", repo: "infra-central", destroy: false },
      ],
      summary: { resourcesMoved: 1, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
    };

    const rollback = generateRollbackPlan(result);

    expect(rollback.steps).toContain("Run terraform apply in both repos to execute rollback");
    expect(rollback.steps).toContain("Run terraform plan in both repos to verify: expect no changes");
    expect(rollback.steps.some((s) => s.includes("re-import resources"))).toBe(true);
    expect(rollback.steps.some((s) => s.includes("drop resources without destroying"))).toBe(true);
  });

  it("resolves resource IDs from forward migration's import blocks", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      importBlocks: [
        { to: "aws_iam_role.api_role", id: "api-role-prod", repo: "service-api" },
      ],
      removedBlocks: [
        { from: "aws_iam_role.api_role", repo: "infra-central", destroy: false },
      ],
      summary: { resourcesMoved: 1, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
    };

    const rollback = generateRollbackPlan(result);

    // The reverse import (back into infra-central) should use the real ID
    const importFile = rollback.fileWrites.find((fw) => fw.filePath.includes("rollback-imports.tf"));
    expect(importFile).toBeDefined();
    expect(importFile!.content).toContain('id = "api-role-prod"');
    expect(importFile!.content).not.toContain("<RESOURCE_ID>");
  });

  it("generates rollback.sh with correct execution order", () => {
    const result: MigrateResult = {
      ...createEmptyResult(),
      importBlocks: [
        { to: "aws_iam_role.api_role", id: "api-role-prod", repo: "service-api" },
      ],
      removedBlocks: [
        { from: "aws_iam_role.api_role", repo: "infra-central", destroy: false },
      ],
      summary: { resourcesMoved: 1, arnsRewritten: 0, outputsGenerated: 0, filesModified: 2 },
    };

    const rollback = generateRollbackPlan(result);

    const rollbackScript = rollback.fileWrites.find((fw) => fw.filePath === "rollback.sh");
    expect(rollbackScript).toBeDefined();
    expect(rollbackScript!.content).toContain("#!/bin/bash");
    expect(rollbackScript!.content).toContain("set -euo pipefail");
    // Step 1: release from target
    expect(rollbackScript!.content).toContain("Release resources from target state");
    expect(rollbackScript!.content).toContain('terraform -chdir="service-api" apply');
    // Step 2: re-import into source
    expect(rollbackScript!.content).toContain("Re-import resources into source state");
    expect(rollbackScript!.content).toContain('terraform -chdir="infra-central" apply');
    // Step 3: verify
    expect(rollbackScript!.content).toContain("plan -detailed-exitcode");
  });
});
