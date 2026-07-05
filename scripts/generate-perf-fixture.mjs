#!/usr/bin/env node
/**
 * Generate a large-scale Terraform fixture for performance benchmarking.
 *
 * Creates N services × M resources per service in a gatekeeper pattern:
 * - infra-central: contains IAM roles for all services
 * - service-{name}: contains Lambda/DB/S3 resources referencing central roles by ARN
 *
 * Usage:
 *   node scripts/generate-perf-fixture.mjs [services=50] [resources-per-service=10]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SERVICES = parseInt(process.argv[2] || "50", 10);
const RESOURCES_PER_SERVICE = parseInt(process.argv[3] || "10", 10);
const OUTPUT_DIR = join(process.cwd(), "tmp/perf-fixture");
const ACCOUNT_ID = "111111111111";

async function main() {
  console.log(`Generating fixture: ${SERVICES} services × ${RESOURCES_PER_SERVICE} resources`);
  console.log(`Total resources: ~${SERVICES * RESOURCES_PER_SERVICE + SERVICES * 2} (services + central)`);
  console.log(`Output: ${OUTPUT_DIR}`);

  // --- infra-central ---
  const centralDir = join(OUTPUT_DIR, "infra-central");
  await mkdir(centralDir, { recursive: true });

  await writeFile(join(centralDir, "versions.tf"), `
terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
`);

  // Generate IAM roles for each service
  const roleBlocks = [];
  for (let i = 0; i < SERVICES; i++) {
    const svc = serviceName(i);
    for (let j = 0; j < 2; j++) {
      const roleSuffix = j === 0 ? "lambda_exec" : "db_access";
      roleBlocks.push(`
resource "aws_iam_role" "${svc}_${roleSuffix}" {
  name               = "${svc}-${roleSuffix.replace(/_/g, "-")}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}
`);
    }
  }

  // Split into multiple files to simulate real repos
  const ROLES_PER_FILE = 20;
  for (let chunk = 0; chunk < Math.ceil(roleBlocks.length / ROLES_PER_FILE); chunk++) {
    const slice = roleBlocks.slice(chunk * ROLES_PER_FILE, (chunk + 1) * ROLES_PER_FILE);
    await writeFile(join(centralDir, `roles-${chunk}.tf`), slice.join("\n"));
  }

  // Platform resources that should stay
  await writeFile(join(centralDir, "platform.tf"), `
resource "aws_iam_role" "platform_deployer" {
  name               = "platform-deployer"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "eks_cluster_role" {
  name               = "eks-cluster-role"
  assume_role_policy = "{}"
}

resource "aws_iam_policy" "boundary_policy" {
  name   = "service-boundary"
  policy = "{}"
}
`);

  // --- State file for infra-central ---
  const stateDir = join(OUTPUT_DIR, "state");
  await mkdir(stateDir, { recursive: true });

  const stateResources = [];
  for (let i = 0; i < SERVICES; i++) {
    const svc = serviceName(i);
    for (const suffix of ["lambda-exec", "db-access"]) {
      stateResources.push({
        type: "aws_iam_role",
        name: `${svc}_${suffix.replace(/-/g, "_")}`,
        instances: [{ attributes: { arn: `arn:aws:iam::${ACCOUNT_ID}:role/${svc}-${suffix}` } }],
      });
    }
  }
  await writeFile(join(stateDir, "infra-central.tfstate.json"), JSON.stringify({
    version: 4,
    resources: stateResources,
  }));

  // --- Service repos ---
  for (let i = 0; i < SERVICES; i++) {
    const svc = serviceName(i);
    const svcDir = join(OUTPUT_DIR, `service-${svc}`);
    await mkdir(svcDir, { recursive: true });

    await writeFile(join(svcDir, "versions.tf"), `
terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
`);

    const resources = [];
    for (let j = 0; j < RESOURCES_PER_SERVICE; j++) {
      const resType = RESOURCE_TYPES[j % RESOURCE_TYPES.length];
      resources.push(generateResource(resType, svc, j));
    }
    await writeFile(join(svcDir, "main.tf"), resources.join("\n"));
  }

  console.log("Done.");
}

function serviceName(i) {
  const names = [
    "orders", "payments", "auth", "analytics", "notifications",
    "search", "inventory", "shipping", "billing", "messaging",
    "gateway", "catalog", "reviews", "recommendations", "pricing",
    "scheduler", "monitoring", "logging", "events", "workflows",
    "users", "profiles", "media", "storage", "compute",
    "networking", "security", "compliance", "reporting", "dashboard",
    "api", "frontend", "backend", "worker", "queue",
    "cache", "database", "ml", "data", "etl",
    "streaming", "realtime", "batch", "cron", "webhook",
    "email", "sms", "push", "chat", "voice",
  ];
  if (i < names.length) return names[i];
  return `service-${i}`;
}

const RESOURCE_TYPES = [
  "lambda", "lambda2", "s3", "dynamodb", "sqs",
  "sns", "cloudwatch", "apigateway", "stepfunctions", "kinesis",
];

function generateResource(type, svc, idx) {
  const roleName = `${svc}-lambda-exec`;
  const roleArn = `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`;

  switch (type) {
    case "lambda":
      return `
resource "aws_lambda_function" "${svc}_handler_${idx}" {
  function_name = "${svc}-handler-${idx}"
  role          = "${roleArn}"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "lambda.zip"
  memory_size   = 256
  timeout       = 30
}
`;
    case "lambda2":
      return `
resource "aws_lambda_function" "${svc}_worker_${idx}" {
  function_name = "${svc}-worker-${idx}"
  role          = "${roleArn}"
  handler       = "worker.handler"
  runtime       = "python3.12"
  filename      = "lambda.zip"
  memory_size   = 512
  timeout       = 300
}
`;
    case "s3":
      return `
resource "aws_s3_bucket" "${svc}_data_${idx}" {
  bucket = "${svc}-data-${idx}-${ACCOUNT_ID}"
}
`;
    case "dynamodb":
      return `
resource "aws_dynamodb_table" "${svc}_table_${idx}" {
  name         = "${svc}-table-${idx}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
}
`;
    case "sqs":
      return `
resource "aws_sqs_queue" "${svc}_queue_${idx}" {
  name                       = "${svc}-queue-${idx}"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400
}
`;
    case "sns":
      return `
resource "aws_sns_topic" "${svc}_topic_${idx}" {
  name = "${svc}-topic-${idx}"
}
`;
    case "cloudwatch":
      return `
resource "aws_cloudwatch_log_group" "${svc}_logs_${idx}" {
  name              = "/app/${svc}/${idx}"
  retention_in_days = 14
}
`;
    case "apigateway":
      return `
resource "aws_apigatewayv2_api" "${svc}_api_${idx}" {
  name          = "${svc}-api-${idx}"
  protocol_type = "HTTP"
}
`;
    case "stepfunctions":
      return `
resource "aws_sfn_state_machine" "${svc}_workflow_${idx}" {
  name     = "${svc}-workflow-${idx}"
  role_arn = "${roleArn}"
  definition = jsonencode({
    StartAt = "Start"
    States = { Start = { Type = "Pass", End = true } }
  })
}
`;
    case "kinesis":
      return `
resource "aws_kinesis_stream" "${svc}_stream_${idx}" {
  name             = "${svc}-stream-${idx}"
  shard_count      = 1
  retention_period = 24
}
`;
    default:
      return `
resource "aws_cloudwatch_log_group" "${svc}_misc_${idx}" {
  name = "/misc/${svc}/${idx}"
}
`;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
