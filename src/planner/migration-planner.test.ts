import { describe, it, expect } from "vitest";
import { topologicalSort, buildResourceIdMap, generateMigrationSteps, generateShellScript, createMigrationPlan, generateTfmigrateHcl } from "./migration-planner.js";
import type { DependencyGraph, GraphNode, GraphEdge, CutEdge } from "../types.js";
import type { StateFile } from "../state/state-reader.js";

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): DependencyGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return { nodes: nodeMap, edges };
}

describe("topologicalSort", () => {
  it("returns single node unchanged", () => {
    const node: GraphNode = { id: "a", type: "resource", resourceType: "aws_vpc", name: "main", repo: "r", filePath: "f" };
    const graph = makeGraph([node], []);
    const result = topologicalSort(graph, ["a"]);
    expect(result).toEqual(["a"]);
  });

  it("orders dependencies before dependents", () => {
    const a: GraphNode = { id: "a", type: "resource", resourceType: "aws_iam_role", name: "a", repo: "r", filePath: "f" };
    const b: GraphNode = { id: "b", type: "resource", resourceType: "aws_lambda_function", name: "b", repo: "r", filePath: "f" };
    const c: GraphNode = { id: "c", type: "resource", resourceType: "aws_s3_bucket", name: "c", repo: "r", filePath: "f" };
    // b depends on a, c depends on b → move order: a, b, c (reversed topo for "move deps first")
    const edges: GraphEdge[] = [
      { from: b.id, to: a.id, type: "reference" },
      { from: c.id, to: b.id, type: "reference" },
    ];
    const graph = makeGraph([a, b, c], edges);
    const result = topologicalSort(graph, ["a", "b", "c"]);

    // a should come before b, b before c (dependencies first)
    const idxA = result.indexOf("a");
    const idxB = result.indexOf("b");
    const idxC = result.indexOf("c");
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it("handles independent nodes (no edges)", () => {
    const a: GraphNode = { id: "a", type: "resource", resourceType: "aws_vpc", name: "a", repo: "r", filePath: "f" };
    const b: GraphNode = { id: "b", type: "resource", resourceType: "aws_vpc", name: "b", repo: "r", filePath: "f" };
    const graph = makeGraph([a, b], []);
    const result = topologicalSort(graph, ["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("only considers edges between moved nodes", () => {
    const a: GraphNode = { id: "a", type: "resource", resourceType: "aws_iam_role", name: "a", repo: "r", filePath: "f" };
    const b: GraphNode = { id: "b", type: "resource", resourceType: "aws_vpc", name: "b", repo: "r", filePath: "f" };
    const c: GraphNode = { id: "c", type: "resource", resourceType: "aws_lambda_function", name: "c", repo: "r", filePath: "f" };
    // a→b, b→c, but only moving a and c
    const edges: GraphEdge[] = [
      { from: a.id, to: b.id, type: "reference" },
      { from: b.id, to: c.id, type: "reference" },
    ];
    const graph = makeGraph([a, b, c], edges);
    const result = topologicalSort(graph, ["a", "c"]);
    // No direct edge between a and c in the move set, so order is arbitrary
    expect(result).toHaveLength(2);
    expect(result).toContain("a");
    expect(result).toContain("c");
  });

  it("handles cycles gracefully (includes all nodes)", () => {
    const a: GraphNode = { id: "a", type: "resource", resourceType: "aws_vpc", name: "a", repo: "r", filePath: "f" };
    const b: GraphNode = { id: "b", type: "resource", resourceType: "aws_vpc", name: "b", repo: "r", filePath: "f" };
    const edges: GraphEdge[] = [
      { from: a.id, to: b.id, type: "reference" },
      { from: b.id, to: a.id, type: "reference" },
    ];
    const graph = makeGraph([a, b], edges);
    const result = topologicalSort(graph, ["a", "b"]);
    expect(result).toHaveLength(2);
  });
});

describe("buildResourceIdMap", () => {
  it("maps repo:address to resource ID", () => {
    const stateFiles: StateFile[] = [{
      repo: "infra",
      resources: [
        { address: "aws_iam_role.worker", type: "aws_iam_role", name: "worker", arn: "arn:aws:iam::123:role/worker", attributes: { id: "worker" } },
      ],
    }];
    const map = buildResourceIdMap(stateFiles);
    expect(map.get("infra:aws_iam_role.worker")).toBe("worker");
  });

  it("prefers ID over ARN (import uses terraform resource ID)", () => {
    const stateFiles: StateFile[] = [{
      repo: "app",
      resources: [
        { address: "aws_s3_bucket.data", type: "aws_s3_bucket", name: "data", arn: "arn:aws:s3:::my-bucket", attributes: { id: "my-bucket" } },
      ],
    }];
    const map = buildResourceIdMap(stateFiles);
    expect(map.get("app:aws_s3_bucket.data")).toBe("my-bucket");
  });

  it("falls back to id when no ARN", () => {
    const stateFiles: StateFile[] = [{
      repo: "app",
      resources: [
        { address: "aws_vpc.main", type: "aws_vpc", name: "main", attributes: { id: "vpc-123456" } },
      ],
    }];
    const map = buildResourceIdMap(stateFiles);
    expect(map.get("app:aws_vpc.main")).toBe("vpc-123456");
  });

  it("handles multiple repos", () => {
    const stateFiles: StateFile[] = [
      { repo: "infra", resources: [{ address: "aws_vpc.main", type: "aws_vpc", name: "main", arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-1", attributes: {} }] },
      { repo: "app", resources: [{ address: "aws_lambda_function.api", type: "aws_lambda_function", name: "api", arn: "arn:aws:lambda:us-east-1:123:function:api", attributes: {} }] },
    ];
    const map = buildResourceIdMap(stateFiles);
    expect(map.size).toBe(2);
    expect(map.get("infra:aws_vpc.main")).toContain("vpc");
    expect(map.get("app:aws_lambda_function.api")).toContain("lambda");
  });
});

describe("generateMigrationSteps with stateFiles", () => {
  const vpc: GraphNode = { id: "infra:resource.aws_vpc.main", type: "resource", resourceType: "aws_vpc", name: "main", repo: "infra", filePath: "vpc.tf" };
  const lambda: GraphNode = { id: "app:resource.aws_lambda_function.api", type: "resource", resourceType: "aws_lambda_function", name: "api", repo: "app", filePath: "lambda.tf" };
  const edge: GraphEdge = { from: lambda.id, to: vpc.id, type: "arn", label: "arn:aws:ec2:us-east-1:123:vpc/vpc-123" };

  it("resolves resource IDs from state in import commands", () => {
    const graph = makeGraph([vpc, lambda], [edge]);
    const cutEdges: CutEdge[] = [{
      edge,
      fromNamespace: "service-app",
      toNamespace: "platform",
      score: 5,
    }];
    const stateFiles: StateFile[] = [{
      repo: "infra",
      resources: [{ address: "aws_vpc.main", type: "aws_vpc", name: "main", arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-123", attributes: {} }],
    }];
    const steps = generateMigrationSteps(graph, cutEdges, { stateFiles });
    const importSteps = steps.filter((s) => s.type === "import");
    expect(importSteps.length).toBeGreaterThanOrEqual(1);
    expect(importSteps[0].command).toContain("arn:aws:ec2:us-east-1:123:vpc/vpc-123");
    expect(importSteps[0].command).not.toContain("<RESOURCE_ID>");
  });

  it("falls back to placeholder when no state available", () => {
    const graph = makeGraph([vpc, lambda], [edge]);
    const cutEdges: CutEdge[] = [{
      edge,
      fromNamespace: "service-app",
      toNamespace: "platform",
      score: 5,
    }];
    const steps = generateMigrationSteps(graph, cutEdges);
    const importSteps = steps.filter((s) => s.type === "import");
    expect(importSteps[0].command).toContain("<RESOURCE_ID>");
  });

  it("deduplicates state_mv for same resource with multiple cut edges", () => {
    const role: GraphNode = { id: "ops:resource.aws_iam_role.shared", type: "resource", resourceType: "aws_iam_role", name: "shared", repo: "ops", filePath: "r.tf" };
    const svc1: GraphNode = { id: "a:resource.aws_lambda_function.f1", type: "resource", resourceType: "aws_lambda_function", name: "f1", repo: "a", filePath: "f.tf" };
    const svc2: GraphNode = { id: "b:resource.aws_lambda_function.f2", type: "resource", resourceType: "aws_lambda_function", name: "f2", repo: "b", filePath: "f.tf" };
    const e1: GraphEdge = { from: role.id, to: svc1.id, type: "arn", label: "arn1" };
    const e2: GraphEdge = { from: role.id, to: svc2.id, type: "arn", label: "arn2" };
    const graph = makeGraph([role, svc1, svc2], [e1, e2]);
    const cutEdges: CutEdge[] = [
      { edge: e1, fromNamespace: "service-shared", toNamespace: "service-f1", score: 3 },
      { edge: e2, fromNamespace: "service-shared", toNamespace: "service-f2", score: 3 },
    ];
    const steps = generateMigrationSteps(graph, cutEdges);
    const mvSteps = steps.filter((s) => s.type === "state_mv");
    // Same resource (role) should only be moved once
    expect(mvSteps).toHaveLength(1);
    expect(mvSteps[0].resource).toBe("aws_iam_role.shared");
  });
});

describe("migration-planner (legacy)", () => {
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
        { type: "state_mv" as const, command: "terraform state mv -state='source/terraform.tfstate' -state-out='target/terraform.tfstate' 'aws_vpc.main' 'aws_vpc.main'", description: "Move VPC from source to target" },
        { type: "verify" as const, command: "terraform plan", description: "Verify" },
      ];
      const script = generateShellScript(steps);
      expect(script).toContain("#!/bin/bash");
      expect(script).toContain("set -euo pipefail");
      expect(script).toContain("terraform state mv");
      expect(script).toContain("state pull");
      expect(script).toContain("state push");
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
