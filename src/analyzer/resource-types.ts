/**
 * Centralized AWS resource type registry.
 *
 * This module is the single source of truth for:
 * 1. ARN service → primary Terraform resource type mapping
 * 2. Namespace classification type sets (foundation, platform, service)
 * 3. Migration importance scores
 *
 * Other modules import from here instead of maintaining their own lists.
 */

// ---------------------------------------------------------------------------
// ARN service → primary Terraform resource type
// Used by: dependency-graph.ts (ARN definer resolution), code-rewriter.ts (data source generation)
// ---------------------------------------------------------------------------

export const ARN_SERVICE_TO_RESOURCE_TYPE: Record<string, string> = {
  // Identity & Access
  iam: "aws_iam_role",
  // Compute
  lambda: "aws_lambda_function",
  ecs: "aws_ecs_cluster",
  eks: "aws_eks_cluster",
  ec2: "aws_instance",
  states: "aws_sfn_state_machine",
  // Storage
  s3: "aws_s3_bucket",
  dynamodb: "aws_dynamodb_table",
  // Database
  rds: "aws_db_instance",
  elasticache: "aws_elasticache_cluster",
  redshift: "aws_redshift_cluster",
  // Messaging & Streaming
  sqs: "aws_sqs_queue",
  sns: "aws_sns_topic",
  kinesis: "aws_kinesis_stream",
  firehose: "aws_kinesis_firehose_delivery_stream",
  // Networking & CDN
  elasticloadbalancing: "aws_lb",
  cloudfront: "aws_cloudfront_distribution",
  // API
  apigateway: "aws_api_gateway_rest_api",
  "execute-api": "aws_apigatewayv2_api",
  // Monitoring & Logging
  logs: "aws_cloudwatch_log_group",
  events: "aws_cloudwatch_event_rule",
  // Security & Secrets
  kms: "aws_kms_key",
  secretsmanager: "aws_secretsmanager_secret",
  ssm: "aws_ssm_parameter",
  acm: "aws_acm_certificate",
  wafv2: "aws_wafv2_web_acl",
  // Auth
  "cognito-idp": "aws_cognito_user_pool",
  // Containers
  ecr: "aws_ecr_repository",
  // CI/CD
  codecommit: "aws_codecommit_repository",
  codebuild: "aws_codebuild_project",
  codepipeline: "aws_codepipeline",
  // Analytics
  glue: "aws_glue_catalog_database",
};

// ---------------------------------------------------------------------------
// Namespace classification type sets
// Used by: namespace-classifier.ts
// ---------------------------------------------------------------------------

/** Organization-level resources (SCPs, accounts, OUs) */
export const FOUNDATION_TYPES = new Set([
  "aws_organizations_organization",
  "aws_organizations_account",
  "aws_organizations_organizational_unit",
  "aws_organizations_policy",
  "aws_organizations_policy_attachment",
]);

export const FOUNDATION_PATTERNS: RegExp[] = [/^aws_organizations_/];

/** Shared infrastructure: networking, compute clusters, CDN */
export const PLATFORM_TYPES = new Set([
  "aws_vpc",
  "aws_subnet",
  "aws_internet_gateway",
  "aws_nat_gateway",
  "aws_route_table",
  "aws_route_table_association",
  "aws_eks_cluster",
  "aws_eks_node_group",
  "aws_ecs_cluster",
  "aws_elasticache_cluster",
  "aws_cloudfront_distribution",
]);

/** Per-service compute and data resources */
export const SERVICE_TYPES = new Set([
  "aws_lambda_function",
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_sqs_queue",
  "aws_sns_topic",
  "aws_dynamodb_table",
  "aws_s3_bucket",
  "aws_ecs_service",
  "aws_ecs_task_definition",
  "aws_api_gateway_rest_api",
  "aws_apigatewayv2_api",
]);

// ---------------------------------------------------------------------------
// Migration importance scores
// Used by: cut-finder.ts
// Higher score = higher migration priority
// ---------------------------------------------------------------------------

export const DEFAULT_IMPORTANCE_SCORES: Record<string, number> = {
  // Foundational infra — many services depend on these
  aws_vpc: 5,
  aws_eks_cluster: 5,
  // Stateful resources — high risk of data loss
  aws_db_instance: 4,
  aws_rds_cluster: 4,
  aws_dynamodb_table: 4,
  aws_elasticache_cluster: 4,
  // IAM — most common gatekeeper resource
  aws_iam_role: 3,
  aws_iam_policy: 3,
  // Stateless / easily recreatable
  aws_lambda_function: 2,
  aws_s3_bucket: 2,
  aws_sqs_queue: 2,
  aws_sns_topic: 2,
};
