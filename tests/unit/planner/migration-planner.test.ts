import { describe, it, expect } from "vitest";
import { generateMigrationSteps, generateShellScript, createMigrationPlan, generateTfmigrateHcl } from "../../../src/planner/migration-planner.js";
import type { DependencyGraph, GraphNode, GraphEdge, CutEdge } from "../../../src/types.js";

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): DependencyGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return { nodes: nodeMap, edges };
}

describe("migration-planner", () => {
  const vpc: GraphNode = { id: "r:resource.aws_vpc.main", type: "resource", resourceType: "aws_vpc", name: "main", repo: "infra", filePath: "vpc.tf" };
  const lambda: GraphNode = { id: "r:resource.aws_lambda_function.api", type: "resource", resourceType: "aws_lambda_function", name: "api", repo: "app", filePath: "lambda.tf" };
  const edge: GraphEdge = { from: lambda.id, to: vpc.id, type: "arn", label: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-123" };

  describe("generateMigrationSteps", () => {
    it("generates state_mv commands with different source and target", () => {
      const graph = makeGraph([vpc, lambda], [edge]);
      const cutEdges: CutEdge[] = [{
        edge,
        fromNamespace: "service-api",
        toNamespace: "platform",
        score: 5,
      }];
      const steps = generateMigrationSteps(graph, cutEdges);
      const mvSteps = steps.filter((s) => s.type === "state_mv");
      expect(mvSteps.length).toBeGreaterThanOrEqual(1);
      expect(mvSteps[0].command).toContain("terraform state mv");
      expect(mvSteps[0].command).toContain("-state=");
      expect(mvSteps[0].command).toContain("-state-out=");
    });

    it("generates import commands", () => {
      const graph = makeGraph([vpc, lambda], [edge]);
      const cutEdges: CutEdge[] = [{
        edge,
        fromNamespace: "service-api",
        toNamespace: "platform",
        score: 5,
      }];
      const steps = generateMigrationSteps(graph, cutEdges);
      const importSteps = steps.filter((s) => s.type === "import");
      expect(importSteps.length).toBeGreaterThanOrEqual(1);
      expect(importSteps[0].command).toContain("terraform import");
    });

    it("generates code_rewrite steps for ARN edges", () => {
      const graph = makeGraph([vpc, lambda], [edge]);
      const cutEdges: CutEdge[] = [{
        edge,
        fromNamespace: "service-api",
        toNamespace: "platform",
        score: 5,
      }];
      const steps = generateMigrationSteps(graph, cutEdges);
      const rewriteSteps = steps.filter((s) => s.type === "code_rewrite");
      expect(rewriteSteps.length).toBeGreaterThanOrEqual(1);
    });

    it("always includes a verify step", () => {
      const graph = makeGraph([vpc, lambda], [edge]);
      const steps = generateMigrationSteps(graph, []);
      const verifySteps = steps.filter((s) => s.type === "verify");
      expect(verifySteps).toHaveLength(1);
      expect(verifySteps[0].command).toBe("terraform plan");
    });
  });

  describe("generateShellScript", () => {
    it("generates a valid shell script", () => {
      const steps = [
        { type: "state_mv" as const, command: "terraform state mv 'aws_vpc.main' 'aws_vpc.main'", description: "Move VPC" },
        { type: "verify" as const, command: "terraform plan", description: "Verify" },
      ];
      const script = generateShellScript(steps);
      expect(script).toContain("#!/bin/bash");
      expect(script).toContain("set -euo pipefail");
      expect(script).toContain("terraform state mv");
      expect(script).toContain("terraform plan");
    });
  });

  describe("createMigrationPlan", () => {
    it("produces a complete plan with JSON and shell output", () => {
      const graph = makeGraph([vpc, lambda], [edge]);
      const plan = createMigrationPlan(graph);
      expect(plan.steps.length).toBeGreaterThanOrEqual(1);
      expect(plan.shellScript).toContain("#!/bin/bash");
      expect(plan.tfmigrateHcl).toBeDefined();
      expect(() => JSON.parse(plan.json)).not.toThrow();
    });

    it("handles empty graph", () => {
      const graph = makeGraph([], []);
      const plan = createMigrationPlan(graph);
      expect(plan.steps).toHaveLength(1); // just verify step
      expect(plan.crossNamespaceEdges).toHaveLength(0);
    });
  });

  describe("generateTfmigrateHcl", () => {
    it("generates tfmigrate-compatible HCL", () => {
      const graph = makeGraph([vpc, lambda], [edge]);
      const cutEdges: CutEdge[] = [{
        edge,
        fromNamespace: "service-api",
        toNamespace: "platform",
        score: 5,
      }];
      const hcl = generateTfmigrateHcl(graph, cutEdges);
      expect(hcl).toContain('migration "multi_state"');
      expect(hcl).toContain('from_dir = "app"');
      expect(hcl).toContain('to_dir   = "platform"');
      expect(hcl).toContain("mv aws_lambda_function.api aws_lambda_function.api");
    });

    it("groups moves by from_dir/to_dir pair", () => {
      const role1: GraphNode = { id: "r:resource.aws_iam_role.a", type: "resource", resourceType: "aws_iam_role", name: "a", repo: "ops", filePath: "a.tf" };
      const role2: GraphNode = { id: "r:resource.aws_iam_role.b", type: "resource", resourceType: "aws_iam_role", name: "b", repo: "ops", filePath: "b.tf" };
      const svc: GraphNode = { id: "r:resource.aws_lambda_function.f", type: "resource", resourceType: "aws_lambda_function", name: "f", repo: "svc", filePath: "f.tf" };
      const e1: GraphEdge = { from: role1.id, to: svc.id, type: "arn", label: "arn1" };
      const e2: GraphEdge = { from: role2.id, to: svc.id, type: "arn", label: "arn2" };
      const graph = makeGraph([role1, role2, svc], [e1, e2]);
      const cutEdges: CutEdge[] = [
        { edge: e1, fromNamespace: "service-a", toNamespace: "service-f", score: 3 },
        { edge: e2, fromNamespace: "service-b", toNamespace: "service-f", score: 3 },
      ];
      const hcl = generateTfmigrateHcl(graph, cutEdges);
      // Both should be in same migration block since same from_dir/to_dir
      const blocks = hcl.split('migration "multi_state"').length - 1;
      expect(blocks).toBe(1);
      expect(hcl).toContain("mv aws_iam_role.a aws_iam_role.a");
      expect(hcl).toContain("mv aws_iam_role.b aws_iam_role.b");
    });
  });
});
