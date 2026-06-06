/**
 * Integration test: Multi-repo Terraform migration scenario
 *
 * Reproduces the Gatekeeper Model structure:
 * - infra-central: Centralized IAM (blanket Deny, all roles defined here)
 * - service-app-api: An API service repo that references infra-central roles via hardcoded ARNs
 * - service-app-analytics: An analytics service repo with cross-repo ARN dependencies
 * - infra-platform: EKS cluster definitions, VPC, shared observability
 *
 * Tests the full analysis → classification → cut-finding → migration-plan pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { scanCrossplaneDirectory } from "../../src/parser/crossplane-parser.js";
import { buildGraph, detectCycles } from "../../src/analyzer/dependency-graph.js";
import { toGraphviz } from "../../src/reporter/graphviz.js";
import { detectArns, getUnresolvedArns, groupByService } from "../../src/analyzer/arn-detector.js";
import { classifyGraph } from "../../src/analyzer/namespace-classifier.js";
import { findCrossNamespaceEdges } from "../../src/planner/cut-finder.js";
import { createMigrationPlan } from "../../src/planner/migration-planner.js";
import { rewriteArns } from "../../src/planner/code-rewriter.js";
import { generateMarkdownReport } from "../../src/reporter/markdown-reporter.js";
import type { NamespaceConfig } from "../../src/types.js";

describe("Multi-repo migration scenario", () => {
  let testDir: string;
  let infraCentralDir: string;
  let serviceAppApiDir: string;
  let serviceAppAnalyticsDir: string;
  let infraPlatformDir: string;
  let crossplaneDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "tf-multi-repo-"));

    // Create repo directories
    infraCentralDir = join(testDir, "infra-central");
    serviceAppApiDir = join(testDir, "service-app-api");
    serviceAppAnalyticsDir = join(testDir, "service-app-analytics");
    infraPlatformDir = join(testDir, "infra-platform");
    crossplaneDir = join(testDir, "crossplane-compositions");

    await mkdir(join(infraCentralDir, "iam"), { recursive: true });
    await mkdir(join(infraCentralDir, "scp"), { recursive: true });
    await mkdir(join(serviceAppApiDir, "terraform"), { recursive: true });
    await mkdir(join(serviceAppAnalyticsDir, "terraform"), { recursive: true });
    await mkdir(join(infraPlatformDir, "clusters", "cluster-prod-1"), { recursive: true });
    await mkdir(join(infraPlatformDir, "vpc"), { recursive: true });
    await mkdir(crossplaneDir, { recursive: true });

    // ──────────────────────────────────────────
    // infra-central: Centralized IAM definitions
    // ──────────────────────────────────────────

    // SCP (Layer 1)
    await writeFile(join(infraCentralDir, "scp", "deny-iam-without-boundary.tf"), `
resource "aws_organizations_policy" "deny_iam_without_boundary" {
  name        = "deny-iam-without-boundary"
  description = "Deny CreateRole without Permission Boundary"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyCreateRoleWithoutBoundary"
      Effect    = "Deny"
      Action    = ["iam:CreateRole"]
      Resource  = "*"
      Condition = {
        StringNotLike = {
          "iam:PermissionsBoundary" = "arn:aws:iam::*:policy/*-tier-boundary"
        }
      }
    }]
  })
}

resource "aws_organizations_policy_attachment" "deny_iam_dev_ou" {
  policy_id = aws_organizations_policy.deny_iam_without_boundary.id
  target_id = "ou-xxxx-dev"
}
`);

    // Permission Boundary (Layer 2)
    await writeFile(join(infraCentralDir, "iam", "permission-boundaries.tf"), `
resource "aws_iam_policy" "web_tier_boundary" {
  name   = "web-tier-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AllowWebServices"
        Effect   = "Allow"
        Action   = [
          "lambda:*",
          "apigateway:*",
          "dynamodb:*",
          "s3:*",
          "cloudwatch:*",
          "logs:*"
        ]
        Resource = "*"
      },
      {
        Sid      = "DenyIAMWrite"
        Effect   = "Deny"
        Action   = [
          "iam:CreateUser",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:AttachRolePolicy",
          "organizations:*"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_policy" "data_tier_boundary" {
  name   = "data-tier-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AllowDataServices"
        Effect   = "Allow"
        Action   = [
          "rds:*",
          "elasticache:*",
          "s3:*",
          "kinesis:*",
          "glue:*"
        ]
        Resource = "*"
      },
      {
        Sid      = "DenyIAMWrite"
        Effect   = "Deny"
        Action   = ["iam:*", "organizations:*"]
        Resource = "*"
      }
    ]
  })
}
`);

    // Service-specific IAM roles (the problematic centralization)
    await writeFile(join(infraCentralDir, "iam", "app-api-roles.tf"), `
resource "aws_iam_role" "app_api_db_access" {
  name                 = "app-api-db-access"
  permissions_boundary = aws_iam_policy.data_tier_boundary.arn
  assume_role_policy   = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "app_api_rds" {
  role       = aws_iam_role.app_api_db_access.name
  policy_arn = "arn:aws:iam::111111111111:policy/app-api-rds-policy"
}

resource "aws_iam_role" "app_api_lambda" {
  name                 = "app-api-lambda-exec"
  permissions_boundary = aws_iam_policy.web_tier_boundary.arn
  assume_role_policy   = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}
`);

    await writeFile(join(infraCentralDir, "iam", "app-analytics-roles.tf"), `
resource "aws_iam_role" "app_analytics_s3_access" {
  name                 = "app-analytics-s3-access"
  permissions_boundary = aws_iam_policy.web_tier_boundary.arn
  assume_role_policy   = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "app_analytics_kinesis" {
  name                 = "app-analytics-stream-consumer"
  permissions_boundary = aws_iam_policy.data_tier_boundary.arn
  assume_role_policy   = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}
`);

    // ──────────────────────────────────────────
    // service-app-api: References infra-central roles via hardcoded ARNs
    // ──────────────────────────────────────────

    await writeFile(join(serviceAppApiDir, "terraform", "main.tf"), `
# Hardcoded ARN dependency on infra-central (the anti-pattern)
resource "aws_db_instance" "main" {
  identifier     = "app-api-db"
  engine         = "aurora-postgresql"
  instance_class = "db.r6g.large"

  # This ARN is defined in infra-central but hardcoded here
  # Cannot recreate in staging because ARN is account-specific
  iam_database_authentication_enabled = true
}

resource "aws_lambda_function" "processor" {
  function_name = "app-api-processor"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  role          = "arn:aws:iam::111111111111:role/app-api-lambda-exec"

  environment {
    variables = {
      DB_HOST = aws_db_instance.main.endpoint
    }
  }
}

resource "aws_s3_bucket" "articles" {
  bucket = "articles-prod"
}

# Cross-service dependency: app-analytics reads from this bucket
resource "aws_s3_bucket_policy" "articles_cross_access" {
  bucket = aws_s3_bucket.articles.id
  policy = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::111111111111:role/app-analytics-s3-access" }
      Action    = ["s3:GetObject"]
      Resource  = "arn:aws:s3:::articles-prod/*"
    }]
  })
}
`);

    await writeFile(join(serviceAppApiDir, "terraform", "irsa.tf"), `
# IRSA (IAM Roles for Service Accounts) - references infra-central role
resource "kubernetes_service_account" "app_api" {
  metadata {
    name      = "app-api"
    namespace = "app-api"
    annotations = {
      "eks.amazonaws.com/role-arn" = "arn:aws:iam::111111111111:role/app-api-db-access"
    }
  }
}
`);

    // ──────────────────────────────────────────
    // service-app-analytics: Another service with cross-repo deps
    // ──────────────────────────────────────────

    await writeFile(join(serviceAppAnalyticsDir, "terraform", "main.tf"), `
resource "aws_kinesis_stream" "events" {
  name             = "analytics-events"
  shard_count      = 8
  retention_period = 168
}

resource "aws_s3_bucket" "models" {
  bucket = "models-prod"
}

resource "aws_lambda_function" "optimizer" {
  function_name = "app-analytics-optimizer"
  runtime       = "python3.12"
  handler       = "handler.lambda_handler"
  role          = "arn:aws:iam::111111111111:role/app-analytics-stream-consumer"

  environment {
    variables = {
      STREAM_ARN = aws_kinesis_stream.events.arn
      # Cross-service: reads articles from app-api bucket
      ARTICLES_BUCKET = "arn:aws:s3:::articles-prod"
    }
  }
}
`);

    await writeFile(join(serviceAppAnalyticsDir, "terraform", "irsa.tf"), `
resource "kubernetes_service_account" "app_analytics" {
  metadata {
    name      = "app-analytics"
    namespace = "app-analytics"
    annotations = {
      "eks.amazonaws.com/role-arn" = "arn:aws:iam::111111111111:role/app-analytics-s3-access"
    }
  }
}
`);

    // ──────────────────────────────────────────
    // infra-platform: EKS clusters, VPC, shared infra
    // ──────────────────────────────────────────

    await writeFile(join(infraPlatformDir, "vpc", "main.tf"), `
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "main-vpc"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "ap-northeast-1a"
}

resource "aws_subnet" "private_c" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "ap-northeast-1c"
}

resource "aws_nat_gateway" "main" {
  allocation_id = "eipalloc-xxx"
  subnet_id     = aws_subnet.private_a.id
}
`);

    await writeFile(join(infraPlatformDir, "clusters", "cluster-prod-1", "cluster.tf"), `
resource "aws_eks_cluster" "cluster_prod_1" {
  name     = "cluster-prod-1"
  role_arn = "arn:aws:iam::111111111111:role/eks-cluster-role"
  version  = "1.30"

  vpc_config {
    subnet_ids = [
      "subnet-aaa",
      "subnet-bbb"
    ]
    endpoint_private_access = true
    endpoint_public_access  = true
  }
}

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.cluster_prod_1.name
  node_group_name = "general"
  node_role_arn   = "arn:aws:iam::111111111111:role/eks-node-role"
  subnet_ids      = ["subnet-aaa", "subnet-bbb"]

  scaling_config {
    desired_size = 10
    max_size     = 50
    min_size     = 5
  }

  instance_types = ["m6i.2xlarge"]
}
`);

    // ──────────────────────────────────────────
    // crossplane-compositions: Crossplane resources
    // ──────────────────────────────────────────

    await writeFile(join(crossplaneDir, "database-composition.yaml"), `apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: rds-with-iam
spec:
  compositeTypeRef:
    apiVersion: database.example.io/v1alpha1
    kind: XDatabase
  resources:
    - name: iam-role
      base:
        apiVersion: iam.aws.upbound.io/v1beta1
        kind: Role
        metadata:
          name: crossplane-rds-role
        spec:
          forProvider:
            roleArn: arn:aws:iam::111111111111:role/app-api-db-access
            assumeRolePolicy: |
              {"Version":"2012-10-17"}
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        metadata:
          name: crossplane-rds-db
        spec:
          forProvider:
            dbInstanceClass: db.r6g.large
            engine: aurora-postgresql
`);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("scans all repos and builds a unified dependency graph", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    expect(files.length).toBeGreaterThanOrEqual(7);

    const graph = buildGraph(files);

    // Should have nodes from all repos
    const repos = new Set([...graph.nodes.values()].map((n) => n.repo));
    expect(repos).toContain("infra-central");
    expect(repos).toContain("service-app-api");
    expect(repos).toContain("service-app-analytics");
    expect(repos).toContain("infra-platform");

    // Should have edges (at minimum intra-repo references)
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it("detects hardcoded ARN dependencies across repos", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const arnRefs = detectArns(files);

    // Should detect IAM role ARNs
    const iamArns = arnRefs.filter((r) => r.service === "iam");
    expect(iamArns.length).toBeGreaterThan(0);

    // Should detect S3 ARNs
    const s3Arns = arnRefs.filter((r) => r.service === "s3");
    expect(s3Arns.length).toBeGreaterThan(0);

    // Group by service to verify classification
    const grouped = groupByService(arnRefs);
    expect(grouped.has("iam")).toBe(true);
    expect(grouped.has("s3")).toBe(true);
  });

  it("identifies cross-repo ARN references (the Gatekeeper anti-pattern)", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const arnRefs = detectArns(files);

    // ARNs in service repos that point to infra-central defined roles
    const crossRepoRefs = arnRefs.filter((r) =>
      r.repo !== "infra-central" &&
      r.service === "iam" &&
      r.arn.includes("111111111111"),
    );

    // service-app-api uses: app-api-db-access, app-api-lambda-exec, app-analytics-s3-access
    // service-app-analytics uses: app-analytics-stream-consumer, app-analytics-s3-access
    // infra-platform uses: eks-cluster-role, eks-node-role
    expect(crossRepoRefs.length).toBeGreaterThanOrEqual(4);
  });

  it("classifies resources into correct namespaces", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const graph = buildGraph(files);
    const config: NamespaceConfig = {
      overrides: [
        { resourceType: "aws_iam_policy", resourceName: "web_tier_boundary", namespace: "foundation" },
        { resourceType: "aws_iam_policy", resourceName: "data_tier_boundary", namespace: "foundation" },
      ],
    };

    const classifications = classifyGraph(graph.nodes, config);

    // SCP should be foundation
    for (const [id, ns] of classifications) {
      const node = graph.nodes.get(id)!;
      if (node.resourceType.startsWith("aws_organizations_")) {
        expect(ns).toBe("foundation");
      }
    }

    // VPC/EKS should be platform
    for (const [id, ns] of classifications) {
      const node = graph.nodes.get(id)!;
      if (node.resourceType === "aws_vpc" || node.resourceType === "aws_eks_cluster") {
        expect(ns).toBe("platform");
      }
    }

    // Lambda/RDS should be service-*
    for (const [id, ns] of classifications) {
      const node = graph.nodes.get(id)!;
      if (node.resourceType === "aws_lambda_function" || node.resourceType === "aws_db_instance") {
        expect(ns).toMatch(/^service-/);
      }
    }
  });

  it("finds cross-namespace edges (cuts needed for migration)", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const graph = buildGraph(files);
    const config: NamespaceConfig = {
      overrides: [
        { resourceType: "aws_iam_policy", resourceName: "web_tier_boundary", namespace: "foundation" },
        { resourceType: "aws_iam_policy", resourceName: "data_tier_boundary", namespace: "foundation" },
      ],
    };

    const cuts = findCrossNamespaceEdges(graph, config);

    // There should be cross-namespace edges (intra-repo references between
    // foundation/platform/service layers)
    // e.g., IAM roles referencing boundary policies
    expect(cuts.length).toBeGreaterThan(0);

    // Cuts should be scored
    for (const cut of cuts) {
      expect(cut.score).toBeGreaterThan(0);
      expect(cut.fromNamespace).not.toBe(cut.toNamespace);
    }
  });

  it("generates a complete migration plan", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const graph = buildGraph(files);
    const config: NamespaceConfig = {
      overrides: [
        { resourceType: "aws_iam_policy", resourceName: "web_tier_boundary", namespace: "foundation" },
        { resourceType: "aws_iam_policy", resourceName: "data_tier_boundary", namespace: "foundation" },
      ],
    };

    const plan = createMigrationPlan(graph, config);

    // Should have steps
    expect(plan.steps.length).toBeGreaterThan(0);

    // Should have a verification step
    expect(plan.steps.some((s) => s.type === "verify")).toBe(true);

    // Shell script should be valid bash
    expect(plan.shellScript).toContain("#!/bin/bash");
    expect(plan.shellScript).toContain("set -euo pipefail");
    expect(plan.shellScript).toContain("terraform");

    // JSON output should be parseable
    const parsed = JSON.parse(plan.json);
    expect(parsed.steps).toBeDefined();
    expect(parsed.crossNamespaceEdges).toBeDefined();
  });

  it("generates code rewrites to replace hardcoded ARNs", async () => {
    const content = `
resource "aws_lambda_function" "processor" {
  function_name = "app-api-processor"
  role          = "arn:aws:iam::111111111111:role/app-api-lambda-exec"
}
`;
    const arnRefs = [{
      arn: "arn:aws:iam::111111111111:role/app-api-lambda-exec",
      service: "iam",
      filePath: "main.tf",
      repo: "service-app-api",
      resolved: true,
    }];

    // Test data source mode
    const dsResult = rewriteArns(content, "main.tf", arnRefs, "data_source");
    expect(dsResult.diffs).toHaveLength(1);
    expect(dsResult.diffs[0].modified).toContain("data.aws_iam_role.");
    expect(dsResult.diffs[0].modified).not.toContain("arn:aws:iam::111111111111");
    expect(dsResult.dataSourceDeclarations.length).toBeGreaterThan(0);
    expect(dsResult.dataSourceDeclarations[0]).toContain("data \"aws_iam_role\"");

    // Test variable mode
    const varResult = rewriteArns(content, "main.tf", arnRefs, "variable");
    expect(varResult.diffs).toHaveLength(1);
    expect(varResult.diffs[0].modified).toContain("var.");
    expect(varResult.diffs[0].modified).not.toContain("arn:aws:iam::111111111111");
    expect(varResult.variableDeclarations.length).toBeGreaterThan(0);
    expect(varResult.variableDeclarations[0]).toContain("variable");
  });

  it("produces Graphviz output for visualization", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const graph = buildGraph(files);
    const dot = toGraphviz(graph);

    expect(dot).toContain("digraph terraform");
    expect(dot).toContain("infra-central");
    expect(dot).toContain("service-app-api");
    expect(dot).toContain("service-app-analytics");
    expect(dot).toContain("infra-platform");
  });

  it("no false cross-repo ARN cycles after direction fix", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    const graph = buildGraph(files);
    const cycles = detectCycles(graph);

    // After the direction fix, cross-repo ARN edges are unidirectional
    // (consumer→definer only), so false bidirectional cycles are eliminated
    const hasCrossRepoCycle = cycles.some((cycle) => {
      const repos = cycle.map((id) => graph.nodes.get(id)?.repo).filter(Boolean);
      return new Set(repos).size > 1;
    });
    expect(hasCrossRepoCycle).toBe(false);
  });

  it("end-to-end: full pipeline from scan to migration script", async () => {
    // 1. Scan all repos
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
    ];

    // 2. Build graph
    const graph = buildGraph(files);
    expect(graph.nodes.size).toBeGreaterThan(10);

    // 3. Detect ARNs
    const arnRefs = detectArns(files);
    expect(arnRefs.length).toBeGreaterThan(0);

    // 4. Classify
    const config: NamespaceConfig = {
      overrides: [
        { resourceType: "aws_iam_policy", resourceName: "web_tier_boundary", namespace: "foundation" },
        { resourceType: "aws_iam_policy", resourceName: "data_tier_boundary", namespace: "foundation" },
      ],
    };
    const classifications = classifyGraph(graph.nodes, config);
    const namespaces = new Set(classifications.values());
    expect(namespaces.has("foundation")).toBe(true);
    expect(namespaces.has("platform")).toBe(true);

    // 5. Find cuts
    const cuts = findCrossNamespaceEdges(graph, config);

    // 6. Generate plan
    const plan = createMigrationPlan(graph, config);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.shellScript).toContain("terraform");

    // 7. The plan should reflect the target state:
    //    - service roles should move from infra-central to service repos
    //    - foundation (SCP, boundaries) stays in infra-central
    //    - platform (VPC, EKS) goes to infra-platform
    const stateMovSteps = plan.steps.filter((s) => s.type === "state_mv");
    const codeRewriteSteps = plan.steps.filter((s) => s.type === "code_rewrite");

    // There should be state moves for cross-namespace resources
    expect(stateMovSteps.length).toBeGreaterThan(0);
  });

  it("includes Crossplane resources in the dependency graph", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
      ...await scanCrossplaneDirectory(crossplaneDir, "crossplane-compositions"),
    ];

    const graph = buildGraph(files);

    // Should include crossplane repo
    const repos = new Set([...graph.nodes.values()].map((n) => n.repo));
    expect(repos).toContain("crossplane-compositions");

    // Should have crossplane nodes
    const crossplaneNodes = [...graph.nodes.values()].filter(
      (n) => n.repo === "crossplane-compositions",
    );
    expect(crossplaneNodes.length).toBeGreaterThan(0);
  });

  it("detects ARNs from Crossplane resources", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanCrossplaneDirectory(crossplaneDir, "crossplane-compositions"),
    ];

    const arnRefs = detectArns(files);
    const crossplaneArns = arnRefs.filter((r) => r.repo === "crossplane-compositions");
    expect(crossplaneArns.length).toBeGreaterThan(0);
    expect(crossplaneArns.some((r) => r.arn.includes("app-api-db-access"))).toBe(true);
  });

  it("generates markdown report including crossplane resources", async () => {
    const files = [
      ...await scanDirectory(infraCentralDir, "infra-central"),
      ...await scanDirectory(serviceAppApiDir, "service-app-api"),
      ...await scanDirectory(serviceAppAnalyticsDir, "service-app-analytics"),
      ...await scanDirectory(infraPlatformDir, "infra-platform"),
      ...await scanCrossplaneDirectory(crossplaneDir, "crossplane-compositions"),
    ];

    const graph = buildGraph(files);
    const arnRefs = detectArns(files);
    const plan = createMigrationPlan(graph);

    const report = generateMarkdownReport({ graph, arnRefs, plan });

    expect(report).toContain("# Migration Analysis Report");
    expect(report).toContain("## Summary");
    // Should mention crossplane repo in the report tables
    const crossplaneNodes = [...graph.nodes.values()].filter(
      (n) => n.repo === "crossplane-compositions",
    );
    expect(crossplaneNodes.length).toBeGreaterThan(0);
    // The report should include repos count that includes crossplane
    expect(report).toContain("Repositories | 5");
  });
});
