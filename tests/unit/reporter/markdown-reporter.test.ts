import { describe, it, expect } from "vitest";
import { generateMarkdownReport } from "../../../src/reporter/markdown-reporter.js";
import type { DependencyGraph, ArnReference, MigrationPlan, GraphNode, GraphEdge, ParsedFile } from "../../../src/types.js";

function createTestGraph(): DependencyGraph {
  const nodes = new Map<string, GraphNode>([
    ["repo-a:resource.aws_iam_role.my_role", {
      id: "repo-a:resource.aws_iam_role.my_role", type: "resource",
      resourceType: "aws_iam_role", name: "my_role", repo: "repo-a", filePath: "main.tf",
    }],
    ["repo-b:resource.aws_lambda_function.handler", {
      id: "repo-b:resource.aws_lambda_function.handler", type: "resource",
      resourceType: "aws_lambda_function", name: "handler", repo: "repo-b", filePath: "main.tf",
    }],
    ["repo-a:resource.aws_vpc.main", {
      id: "repo-a:resource.aws_vpc.main", type: "resource",
      resourceType: "aws_vpc", name: "main", repo: "repo-a", filePath: "vpc.tf",
    }],
  ]);
  const edges: GraphEdge[] = [
    { from: "repo-b:resource.aws_lambda_function.handler", to: "repo-a:resource.aws_iam_role.my_role", type: "arn", label: "arn:aws:iam::111:role/my_role" },
  ];
  return { nodes, edges };
}

function createTestPlan(): MigrationPlan {
  return {
    steps: [
      { type: "state_mv", command: "terraform state mv ...", description: "Move role", resource: "aws_iam_role.my_role" },
      { type: "code_rewrite", description: "Rewrite ARN", resource: "aws_lambda_function.handler" },
      { type: "verify", command: "terraform plan", description: "Verify" },
    ],
    crossNamespaceEdges: [{
      edge: { from: "repo-b:resource.aws_lambda_function.handler", to: "repo-a:resource.aws_iam_role.my_role", type: "arn" },
      fromNamespace: "service-handler",
      toNamespace: "foundation",
      score: 5,
    }],
    shellScript: "#!/bin/bash\nset -euo pipefail\n",
    json: "{}",
    tfmigrateHcl: "",
  };
}

describe("MarkdownReporter", () => {
  it("generates a report with diagnosis section", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const report = generateMarkdownReport({ graph, arnRefs: [], plan });

    expect(report).toContain("# Migration Analysis Report");
    expect(report).toContain("## Diagnosis");
  });

  it("detects Spaghetti pattern from cross-repo ARN refs", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const arnRefs: ArnReference[] = [{
      arn: "arn:aws:iam::111:role/my_role",
      service: "iam",
      filePath: "main.tf",
      repo: "repo-b",
      resolved: true,
      definingResource: graph.nodes.get("repo-a:resource.aws_iam_role.my_role"),
    }];

    const report = generateMarkdownReport({ graph, arnRefs, plan });

    expect(report).toContain("Spaghetti State");
    expect(report).toContain("hardcoded ARN");
    expect(report).toContain("Hardcoded ARN Dependencies");
    expect(report).toContain("repo-b");
    expect(report).toContain("repo-a");
  });

  it("includes Before/After comparison table", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const arnRefs: ArnReference[] = [{
      arn: "arn:aws:iam::111:role/my_role",
      service: "iam",
      filePath: "main.tf",
      repo: "repo-b",
      resolved: true,
      definingResource: graph.nodes.get("repo-a:resource.aws_iam_role.my_role"),
    }];

    const report = generateMarkdownReport({ graph, arnRefs, plan });

    expect(report).toContain("After Migration");
    expect(report).toContain("Before");
    expect(report).toContain("After");
    expect(report).toContain("Max blast radius");
  });

  it("includes state split plan with change frequency", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const report = generateMarkdownReport({ graph, arnRefs: [], plan });

    expect(report).toContain("## State Split Plan");
    expect(report).toContain("platform");
    expect(report).toContain("Change Frequency");
  });

  it("includes recommended migration order", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const report = generateMarkdownReport({ graph, arnRefs: [], plan });

    expect(report).toContain("Recommended Order");
    expect(report).toContain("aws_iam_role.my_role");
  });

  it("includes migration steps count", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const report = generateMarkdownReport({ graph, arnRefs: [], plan });

    expect(report).toContain("## Migration Steps");
    expect(report).toContain("State moves: 1");
    expect(report).toContain("Code rewrites: 1");
  });

  it("appends template suffix when provided", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const report = generateMarkdownReport({
      graph, arnRefs: [], plan,
      templateSuffix: "## Custom Section\n\nCustom content here.",
    });

    expect(report).toContain("## Custom Section");
    expect(report).toContain("Custom content here.");
  });

  it("detects God Module pattern from parsedFiles", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const body = ["{", ...Array.from({ length: 12 }, (_, i) => `  var${i} = "val${i}"`), "}"].join("\n");
    const parsedFiles: ParsedFile[] = [{
      filePath: "main.tf",
      repo: "repo-a",
      blocks: [{
        type: "module",
        resourceType: "mega_service",
        name: "mega_service",
        body,
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo-a",
      }],
    }];

    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });
    expect(report).toContain("God Module");
    expect(report).toContain("mega_service");
  });

  it("detects Environment Copypasta pattern", () => {
    const nodes = new Map<string, GraphNode>([
      ["prod:resource.aws_ecs_cluster.prod_app", {
        id: "prod:resource.aws_ecs_cluster.prod_app", type: "resource",
        resourceType: "aws_ecs_cluster", name: "prod_app", repo: "prod", filePath: "main.tf",
      }],
      ["stg:resource.aws_ecs_cluster.stg_app", {
        id: "stg:resource.aws_ecs_cluster.stg_app", type: "resource",
        resourceType: "aws_ecs_cluster", name: "stg_app", repo: "stg", filePath: "main.tf",
      }],
      ["dev:resource.aws_ecs_cluster.dev_app", {
        id: "dev:resource.aws_ecs_cluster.dev_app", type: "resource",
        resourceType: "aws_ecs_cluster", name: "dev_app", repo: "dev", filePath: "main.tf",
      }],
    ]);
    const graph: DependencyGraph = { nodes, edges: [] };
    const plan = createTestPlan();

    const report = generateMarkdownReport({ graph, arnRefs: [], plan });
    expect(report).toContain("Environment Copypasta");
    expect(report).toContain("app");
  });

  it("detects Orphaned Resources pattern", () => {
    const nodes = new Map<string, GraphNode>([
      ["repo-a:resource.aws_s3_bucket.orphan", {
        id: "repo-a:resource.aws_s3_bucket.orphan", type: "resource",
        resourceType: "aws_s3_bucket", name: "orphan", repo: "repo-a", filePath: "main.tf",
      }],
      ["repo-a:resource.aws_iam_role.connected1", {
        id: "repo-a:resource.aws_iam_role.connected1", type: "resource",
        resourceType: "aws_iam_role", name: "connected1", repo: "repo-a", filePath: "main.tf",
      }],
      ["repo-a:resource.aws_iam_policy.connected2", {
        id: "repo-a:resource.aws_iam_policy.connected2", type: "resource",
        resourceType: "aws_iam_policy", name: "connected2", repo: "repo-a", filePath: "main.tf",
      }],
      ["repo-a:resource.aws_vpc.connected3", {
        id: "repo-a:resource.aws_vpc.connected3", type: "resource",
        resourceType: "aws_vpc", name: "connected3", repo: "repo-a", filePath: "main.tf",
      }],
    ]);
    const edges: GraphEdge[] = [
      { from: "repo-a:resource.aws_iam_role.connected1", to: "repo-a:resource.aws_iam_policy.connected2", type: "reference" },
      { from: "repo-a:resource.aws_vpc.connected3", to: "repo-a:resource.aws_iam_role.connected1", type: "reference" },
    ];
    const graph: DependencyGraph = { nodes, edges };
    const plan = createTestPlan();

    const report = generateMarkdownReport({ graph, arnRefs: [], plan });
    expect(report).toContain("Orphaned Resources");
    expect(report).toContain("aws_s3_bucket.orphan");
  });

  it("detects Implicit Provider Coupling pattern", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const parsedFiles: ParsedFile[] = [{
      filePath: "main.tf",
      repo: "multi-account",
      blocks: [
        {
          type: "resource" as const,
          resourceType: "aws_s3_bucket",
          name: "prod_data",
          body: '{\n  provider = aws.prod\n  bucket = "prod-data"\n}',
          stringLiterals: [],
          arns: [],
          filePath: "main.tf",
          repo: "multi-account",
        },
        {
          type: "resource" as const,
          resourceType: "aws_s3_bucket",
          name: "staging_data",
          body: '{\n  provider = aws.staging\n  bucket = "staging-data"\n}',
          stringLiterals: [],
          arns: [],
          filePath: "main.tf",
          repo: "multi-account",
        },
      ],
    }];

    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });
    expect(report).toContain("Implicit Provider Coupling");
    expect(report).toContain("multi-account");
  });

  it("detects count on dynamic collections", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const parsedFiles: ParsedFile[] = [{
      filePath: "main.tf",
      repo: "repo-a",
      blocks: [{
        type: "resource",
        resourceType: "aws_iam_user",
        name: "team",
        body: '{\n  count = length(var.users)\n  name  = var.users[count.index]\n}',
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo-a",
      }],
    }];

    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });
    expect(report).toContain("Count on Dynamic Collection");
    expect(report).toContain("aws_iam_user.team");
    expect(report).toContain("for_each");
  });

  it("detects depends_on on module", () => {
    const graph = createTestGraph();
    const plan = createTestPlan();
    const parsedFiles: ParsedFile[] = [{
      filePath: "main.tf",
      repo: "repo-a",
      blocks: [{
        type: "module",
        resourceType: "app",
        name: "app",
        body: '{\n  source     = "./modules/app"\n  vpc_id     = "vpc-123"\n  depends_on = [aws_rds_cluster.main]\n}',
        stringLiterals: [],
        arns: [],
        filePath: "main.tf",
        repo: "repo-a",
      }],
    }];

    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });
    expect(report).toContain("Depends On Module");
    expect(report).toContain("app");
    expect(report).toContain("Pass the actual attribute");
  });

  it("detects Circular Remote State pattern", () => {
    const nodes = new Map<string, GraphNode>([
      ["repo-a:resource.aws_vpc.main", {
        id: "repo-a:resource.aws_vpc.main", type: "resource",
        resourceType: "aws_vpc", name: "main", repo: "repo-a", filePath: "main.tf",
      }],
      ["repo-a:data.terraform_remote_state.b", {
        id: "repo-a:data.terraform_remote_state.b", type: "data",
        resourceType: "terraform_remote_state", name: "b", repo: "repo-a", filePath: "main.tf",
      }],
      ["repo-b:resource.aws_subnet.main", {
        id: "repo-b:resource.aws_subnet.main", type: "resource",
        resourceType: "aws_subnet", name: "main", repo: "repo-b", filePath: "main.tf",
      }],
      ["repo-b:data.terraform_remote_state.a", {
        id: "repo-b:data.terraform_remote_state.a", type: "data",
        resourceType: "terraform_remote_state", name: "a", repo: "repo-b", filePath: "main.tf",
      }],
    ]);
    const edges: GraphEdge[] = [
      { from: "repo-a:resource.aws_vpc.main", to: "repo-a:data.terraform_remote_state.b", type: "remote_state", label: "b" },
      { from: "repo-a:data.terraform_remote_state.b", to: "repo-b:resource.aws_subnet.main", type: "remote_state", label: "a" },
      { from: "repo-b:resource.aws_subnet.main", to: "repo-b:data.terraform_remote_state.a", type: "remote_state", label: "a" },
      { from: "repo-b:data.terraform_remote_state.a", to: "repo-a:resource.aws_vpc.main", type: "remote_state", label: "b" },
    ];
    const graph: DependencyGraph = { nodes, edges };
    const plan = createTestPlan();

    const report = generateMarkdownReport({ graph, arnRefs: [], plan });
    expect(report).toContain("Circular Remote State");
    expect(report).toContain("remote_state");
  });
});
