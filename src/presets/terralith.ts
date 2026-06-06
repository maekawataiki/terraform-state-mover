import type { NamespaceConfig, Namespace, GraphNode } from "../types.js";

const NETWORKING_TYPES = new Set([
  "aws_vpc",
  "aws_subnet",
  "aws_internet_gateway",
  "aws_nat_gateway",
  "aws_route_table",
  "aws_route_table_association",
  "aws_security_group",
]);

const COMPUTE_TYPES = new Set([
  "aws_eks_cluster",
  "aws_eks_node_group",
  "aws_ecs_cluster",
]);

const DATA_TYPES = new Set([
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_dynamodb_table",
  "aws_elasticache_cluster",
]);

const SERVICE_COMPUTE_TYPES = new Set([
  "aws_lambda_function",
  "aws_ecs_service",
  "aws_ecs_task_definition",
]);

const EDGE_TYPES = new Set([
  "aws_cloudfront_distribution",
  "aws_route53_zone",
  "aws_route53_record",
]);

/**
 * Normalize a service name to produce a consistent namespace slug.
 * Converts underscores to hyphens and lowercases.
 */
function normalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * Try to infer a service name from a resource name.
 * Looks for patterns like 'order_api', 'payment_processor', 'auth-service'.
 * Returns normalized service namespace or null if no pattern matches.
 */
function inferServiceFromName(name: string): Namespace | null {
  // Try to extract the first meaningful segment as service name
  // Match pattern: {service}_{purpose} or {service}-{purpose}
  const match = name.match(/^([a-z][a-z0-9]+?)[-_](api|processor|handler|worker|function|service|task|lambda|consumer|producer)/i);
  if (match) {
    return `service-${normalizeServiceName(match[1])}`;
  }

  // Try simpler prefix extraction: first segment before underscore/hyphen
  const simpleMatch = name.match(/^([a-z][a-z0-9]+?)[-_]/i);
  if (simpleMatch) {
    return `service-${normalizeServiceName(simpleMatch[1])}`;
  }

  return null;
}

/**
 * Try to extract service name from S3 bucket name pattern.
 * Common patterns: 'service-xxx-bucket', 'xxx-assets', 'xxx-data'.
 */
function inferServiceFromBucketName(name: string): Namespace {
  // Match pattern: service-{name}-* or {service}-{purpose}
  const servicePrefix = name.match(/^service[-_]([a-z][a-z0-9]+?)[-_]/i);
  if (servicePrefix) {
    return `service-${normalizeServiceName(servicePrefix[1])}`;
  }

  // Try first segment as service name
  const firstSegment = name.match(/^([a-z][a-z0-9]+?)[-_]/i);
  if (firstSegment) {
    return `service-${normalizeServiceName(firstSegment[1])}`;
  }

  return `service-${normalizeServiceName(name)}`;
}

/**
 * Classify a resource using Terralith layer-based decomposition.
 *
 * In the Terralith pattern, a monolithic state contains hundreds of resources
 * that should be split by logical boundary: networking, compute, data, and
 * individual services.
 */
export function classifyTerralithResource(node: GraphNode): Namespace | null {
  // Networking layer → platform
  if (NETWORKING_TYPES.has(node.resourceType)) {
    return "platform";
  }

  // Compute platform layer → platform
  if (COMPUTE_TYPES.has(node.resourceType)) {
    return "platform";
  }

  // Database/data layer → service-data
  if (DATA_TYPES.has(node.resourceType)) {
    return "service-data";
  }

  // Service compute (Lambda, ECS Service/Task) → infer service from name
  if (SERVICE_COMPUTE_TYPES.has(node.resourceType)) {
    const inferred = inferServiceFromName(node.name);
    if (inferred) {
      return inferred;
    }
    return `service-${normalizeServiceName(node.name)}`;
  }

  // S3 buckets → service-{name}
  if (node.resourceType === "aws_s3_bucket") {
    return inferServiceFromBucketName(node.name);
  }

  // Edge/CDN layer → platform
  if (EDGE_TYPES.has(node.resourceType)) {
    return "platform";
  }

  // IAM roles → classify by name pattern
  if (node.resourceType === "aws_iam_role") {
    // Platform-related roles
    if (/eks|ecs|platform/i.test(node.name)) {
      return "platform";
    }
    // Try to infer service from role name
    const inferred = inferServiceFromName(node.name);
    if (inferred) {
      return inferred;
    }
  }

  // Return null to fall through to the default repo-based classifier
  return null;
}

export const terralithConfig: NamespaceConfig = {
  customClassifier: classifyTerralithResource,
  groupByRepo: false,
};

export const terralithReportTemplate = `
## Terralith Context

- **Terralith (current)**: Monolithic state file with all resources in a single Terraform root module
- **Target**: Split by logical boundary into independent state files per layer/service
- **Key Principle**: Each state file should contain resources with the same blast radius and change frequency

### Decomposition Layers
1. **Platform (networking)**: VPC, subnets, NAT gateways, route tables, security groups
2. **Platform (compute)**: EKS/ECS clusters, shared compute infrastructure
3. **Platform (edge)**: CloudFront, Route53 — rarely changes
4. **Service-data**: RDS, DynamoDB, ElastiCache — stateful resources with careful lifecycle
5. **Service-{name}**: Lambda functions, ECS services/tasks, S3 buckets — per-service ownership

### Benefits After Split
- Plan/apply time drops from 10+ minutes to seconds per state
- Blast radius reduced to a single layer/service per deploy
- Teams can deploy independently without blocking each other
`;
