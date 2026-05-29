import type { GraphNode, Namespace, NamespaceConfig, ClassificationOverride } from "../types.js";

const FOUNDATION_TYPES = [
  "aws_organizations_organization",
  "aws_organizations_account",
  "aws_organizations_organizational_unit",
  "aws_organizations_policy",
  "aws_organizations_policy_attachment",
];

const FOUNDATION_PATTERNS = [/^aws_organizations_/];

const PLATFORM_TYPES = [
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
];

const SERVICE_TYPES = [
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
];

export function classifyResource(node: GraphNode, config?: NamespaceConfig): Namespace {
  // Check customClassifier first (takes precedence over overrides)
  if (config?.customClassifier) {
    const result = config.customClassifier(node);
    if (result !== null) return result;
  }

  // Check overrides first
  if (config?.overrides) {
    for (const override of config.overrides) {
      if (override.resourceType && override.resourceName) {
        if (node.resourceType === override.resourceType && node.name === override.resourceName) {
          return override.namespace;
        }
      } else if (override.resourceType && node.resourceType === override.resourceType) {
        return override.namespace;
      } else if (override.resourceName && node.name === override.resourceName) {
        return override.namespace;
      }
    }
  }

  // Foundation: organizations and SCPs
  if (FOUNDATION_TYPES.includes(node.resourceType)) return "foundation";
  if (FOUNDATION_PATTERNS.some((p) => p.test(node.resourceType))) return "foundation";
  if (node.resourceType === "aws_iam_policy" && /boundary|scp|permission.?boundary/i.test(node.name)) {
    return "foundation";
  }

  // Platform: shared infrastructure
  if (PLATFORM_TYPES.includes(node.resourceType)) return "platform";

  // Service: application-level resources
  if (SERVICE_TYPES.includes(node.resourceType)) {
    return `service-${node.name}`;
  }

  // IAM roles: classify by name convention
  if (node.resourceType === "aws_iam_role") {
    if (/platform|shared|infra/i.test(node.name)) return "platform";
    return `service-${node.name}`;
  }

  // Default to service namespace
  return `service-${node.name}`;
}

export function classifyGraph(
  nodes: Map<string, GraphNode>,
  config?: NamespaceConfig,
): Map<string, Namespace> {
  const result = new Map<string, Namespace>();
  for (const [id, node] of nodes) {
    const ns = classifyResource(node, config);
    node.namespace = ns;
    result.set(id, ns);
  }
  return result;
}
