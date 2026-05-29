/**
 * Integration test: Anti-pattern detection for the 5 new patterns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { buildGraph } from "../../src/analyzer/dependency-graph.js";
import { createMigrationPlan } from "../../src/planner/migration-planner.js";
import { generateMarkdownReport } from "../../src/reporter/markdown-reporter.js";

describe("Anti-pattern detection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "tf-antipattern-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("detects God Module from parsed files", async () => {
    const dir = join(testDir, "god-module");
    await mkdir(dir, { recursive: true });
    const assignments = Array.from({ length: 12 }, (_, i) => `  var_${i} = "value_${i}"`).join("\n");
    await writeFile(join(dir, "main.tf"), `module "mega" {\n  source = "./modules/mega"\n${assignments}\n}\n`);

    const parsedFiles = await scanDirectory(dir, "god-module");
    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("God Module");
    expect(report).toContain("mega");
  });

  it("detects Environment Copypasta across repos", async () => {
    for (const env of ["prod", "stg", "dev"]) {
      const dir = join(testDir, env);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "main.tf"), `resource "aws_ecs_cluster" "${env}_app" {\n  name = "${env}-cluster"\n}\n`);
    }

    const parsedFiles = [
      ...(await scanDirectory(join(testDir, "prod"), "prod")),
      ...(await scanDirectory(join(testDir, "stg"), "stg")),
      ...(await scanDirectory(join(testDir, "dev"), "dev")),
    ];
    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("Environment Copypasta");
  });

  it("detects Orphaned Resources", async () => {
    const dir = join(testDir, "orphan");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `
resource "aws_s3_bucket" "lonely" {
  bucket = "lonely-bucket"
}

resource "aws_iam_role" "worker" {
  name = "worker"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy_attachment" "worker_attach" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_lambda_function" "processor" {
  function_name = "processor"
  role          = aws_iam_role.worker.arn
}
`);

    const parsedFiles = await scanDirectory(dir, "orphan");
    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("Orphaned Resources");
    expect(report).toContain("aws_s3_bucket.lonely");
  });

  it("detects Implicit Provider Coupling", async () => {
    const dir = join(testDir, "multi-account");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `
resource "aws_s3_bucket" "prod_data" {
  provider = aws.prod
  bucket   = "prod-data"
}

resource "aws_s3_bucket" "staging_data" {
  provider = aws.staging
  bucket   = "staging-data"
}
`);

    const parsedFiles = await scanDirectory(dir, "multi-account");
    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("Implicit Provider Coupling");
    expect(report).toContain("multi-account");
  });

  it("detects count on dynamic collections", async () => {
    const dir = join(testDir, "count-pattern");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `
variable "users" {
  type    = list(string)
  default = ["alice", "bob", "charlie"]
}

resource "aws_iam_user" "team" {
  count = length(var.users)
  name  = var.users[count.index]
}

resource "aws_s3_bucket" "user_data" {
  count  = length(var.users)
  bucket = "data-\${var.users[count.index]}"
}
`);

    const parsedFiles = await scanDirectory(dir, "count-pattern");
    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("Count on Dynamic Collection");
    expect(report).toContain("aws_iam_user.team");
    expect(report).toContain("aws_s3_bucket.user_data");
    expect(report).toContain("for_each");
  });

  it("detects depends_on on module", async () => {
    const dir = join(testDir, "depends-on-module");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tf"), `
resource "aws_rds_cluster" "main" {
  cluster_identifier = "prod-db"
  engine             = "aurora-postgresql"
  master_username    = "admin"
  master_password    = "changeme"
}

module "app" {
  source     = "./modules/app"
  vpc_id     = "vpc-123"
  depends_on = [aws_rds_cluster.main]
}

module "worker" {
  source     = "./modules/worker"
  queue_url  = "https://sqs.us-east-1.amazonaws.com/123/queue"
  depends_on = [module.app, aws_rds_cluster.main]
}
`);

    const parsedFiles = await scanDirectory(dir, "depends-on-module");
    const graph = buildGraph(parsedFiles);
    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("Depends On Module");
    expect(report).toContain("app");
    expect(report).toContain("worker");
    expect(report).toContain("Pass the actual attribute");
  });

  it("detects Circular Remote State", async () => {
    // Create a scenario where remote_state references form a cycle within the graph
    const dir = join(testDir, "circular-rs");
    await mkdir(dir, { recursive: true });

    // Resource A references remote_state B, and resource B references remote_state A
    await writeFile(join(dir, "main.tf"), `
data "terraform_remote_state" "state_b" {
  backend = "s3"
  config = { bucket = "state", key = "b" }
}

data "terraform_remote_state" "state_a" {
  backend = "s3"
  config = { bucket = "state", key = "a" }
}

resource "aws_vpc" "a" {
  cidr_block = data.terraform_remote_state.state_b.outputs.cidr
}

resource "aws_subnet" "b" {
  vpc_id     = data.terraform_remote_state.state_a.outputs.vpc_id
  cidr_block = "10.0.1.0/24"
}
`);

    const parsedFiles = await scanDirectory(dir, "circular-rs");
    const graph = buildGraph(parsedFiles);

    // Manually add remote_state edges that create a cycle (simulating cross-state references)
    // In real scenarios this would be detected across repos but we wire it here for the test
    graph.edges.push(
      { from: "circular-rs:data.terraform_remote_state.state_b", to: "circular-rs:resource.aws_subnet.b", type: "remote_state", label: "state_b" },
      { from: "circular-rs:data.terraform_remote_state.state_a", to: "circular-rs:resource.aws_vpc.a", type: "remote_state", label: "state_a" },
    );

    const plan = createMigrationPlan(graph);
    const report = generateMarkdownReport({ graph, arnRefs: [], plan, parsedFiles });

    expect(report).toContain("Circular Remote State");
  });
});
