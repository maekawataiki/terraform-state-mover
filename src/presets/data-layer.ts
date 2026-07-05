import type { NamespaceConfig, Namespace, GraphNode } from "../types.js";

/**
 * Stateful data-layer resources that should be isolated for blast radius control.
 * These have strict lifecycle requirements: backup, retention, point-in-time recovery.
 */
const DATA_STORE_TYPES = new Set([
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_rds_cluster_instance",
  "aws_dynamodb_table",
  "aws_elasticache_cluster",
  "aws_elasticache_replication_group",
  "aws_redshift_cluster",
  "aws_opensearch_domain",
  "aws_docdb_cluster",
  "aws_neptune_cluster",
  "aws_keyspaces_table",
  "aws_timestream_database",
]);

/**
 * Data pipeline and streaming resources — adjacent to data stores,
 * often co-deployed with them.
 */
const DATA_PIPELINE_TYPES = new Set([
  "aws_kinesis_stream",
  "aws_kinesis_firehose_delivery_stream",
  "aws_glue_catalog_database",
  "aws_glue_crawler",
  "aws_glue_job",
  "aws_athena_workgroup",
  "aws_dms_replication_instance",
  "aws_dms_replication_task",
]);

/**
 * Data access supporting resources — security groups, parameter groups,
 * subnet groups that are tightly coupled to the data layer.
 */
const DATA_SUPPORT_PATTERNS = [
  /^aws_db_subnet_group$/,
  /^aws_db_parameter_group$/,
  /^aws_rds_cluster_parameter_group$/,
  /^aws_elasticache_subnet_group$/,
  /^aws_elasticache_parameter_group$/,
  /^aws_redshift_subnet_group$/,
  /^aws_redshift_parameter_group$/,
  /^aws_docdb_cluster_parameter_group$/,
  /^aws_docdb_subnet_group$/,
  /^aws_neptune_cluster_parameter_group$/,
  /^aws_neptune_subnet_group$/,
];

/**
 * Compute resources — stateless, fast to recreate, independent lifecycle.
 */
const COMPUTE_TYPES = new Set([
  "aws_lambda_function",
  "aws_lambda_event_source_mapping",
  "aws_lambda_permission",
  "aws_ecs_service",
  "aws_ecs_task_definition",
  "aws_ecs_cluster",
  "aws_eks_cluster",
  "aws_eks_node_group",
  "aws_instance",
  "aws_launch_template",
  "aws_autoscaling_group",
  "aws_apprunner_service",
]);

/**
 * Networking — rarely changes, shared across data + compute.
 */
const NETWORKING_TYPES = new Set([
  "aws_vpc",
  "aws_subnet",
  "aws_internet_gateway",
  "aws_nat_gateway",
  "aws_route_table",
  "aws_route_table_association",
  "aws_security_group",
  "aws_security_group_rule",
  "aws_lb",
  "aws_lb_target_group",
  "aws_lb_listener",
]);

/**
 * Normalize a service name to produce a consistent namespace slug.
 */
function normalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * Try to infer a service name from resource name for the compute layer.
 */
function inferServiceFromName(name: string): string | null {
  const match = name.match(/^([a-z][a-z0-9]+?)[-_](api|processor|handler|worker|function|service|task|lambda|consumer|producer)/i);
  if (match) return normalizeServiceName(match[1]);

  const simpleMatch = name.match(/^([a-z][a-z0-9]+?)[-_]/i);
  if (simpleMatch) return normalizeServiceName(simpleMatch[1]);

  return null;
}

/**
 * Classify a resource for the Data-Layer separation pattern.
 *
 * In this pattern, stateful resources (databases, caches, streams) are
 * separated from stateless compute (Lambda, ECS, EKS) into different
 * state files with distinct lifecycle management:
 *
 * - **data layer**: strict change management, backups, point-in-time recovery
 * - **compute layer**: fast deploy cycles, auto-scaling, canary deployments
 * - **network layer**: rarely changes, shared foundation
 *
 * This prevents an application deployment from accidentally modifying
 * database configuration, and allows data teams to manage schema changes
 * independently of application releases.
 */
export function classifyDataLayerResource(node: GraphNode): Namespace | null {
  // Data stores → service-data
  if (DATA_STORE_TYPES.has(node.resourceType)) {
    return "service-data";
  }

  // Data pipelines → service-data
  if (DATA_PIPELINE_TYPES.has(node.resourceType)) {
    return "service-data";
  }

  // Data support resources (parameter groups, subnet groups) → service-data
  if (DATA_SUPPORT_PATTERNS.some((p) => p.test(node.resourceType))) {
    return "service-data";
  }

  // KMS keys used for data encryption → service-data
  if (node.resourceType === "aws_kms_key" || node.resourceType === "aws_kms_alias") {
    if (/rds|db|dynamo|redis|cache|encrypt/i.test(node.name)) {
      return "service-data";
    }
  }

  // Secrets for database credentials → service-data
  if (node.resourceType === "aws_secretsmanager_secret") {
    if (/db|database|rds|redis|password|credential/i.test(node.name)) {
      return "service-data";
    }
  }

  // Networking → platform
  if (NETWORKING_TYPES.has(node.resourceType)) {
    return "platform";
  }

  // Compute resources → service-compute or infer service name
  if (COMPUTE_TYPES.has(node.resourceType)) {
    const service = inferServiceFromName(node.name);
    if (service) return `service-${service}`;
    return "service-compute";
  }

  // IAM roles: classify by name convention
  if (node.resourceType === "aws_iam_role") {
    if (/rds|db|migration|replication/i.test(node.name)) return "service-data";
    if (/lambda|ecs|task|exec/i.test(node.name)) return "service-compute";
    if (/platform|shared|infra/i.test(node.name)) return "platform";
  }

  // IAM policies for data access
  if (node.resourceType === "aws_iam_policy") {
    if (/rds|dynamodb|s3[-_]?(read|write)|data[-_]?access/i.test(node.name)) return "service-data";
  }

  // S3 buckets: data vs application
  if (node.resourceType === "aws_s3_bucket") {
    if (/data|lake|warehouse|backup|archive|etl|analytics/i.test(node.name)) return "service-data";
    if (/deploy|artifact|static|asset|web/i.test(node.name)) return "service-compute";
  }

  // CloudWatch alarms/metrics for data resources → service-data
  if (node.resourceType === "aws_cloudwatch_metric_alarm") {
    if (/rds|dynamodb|redis|cache|replication/i.test(node.name)) return "service-data";
  }

  // Return null to fall through to the default classifier
  return null;
}

export const dataLayerConfig: NamespaceConfig = {
  customClassifier: classifyDataLayerResource,
  groupByRepo: false,
};

export const dataLayerReportTemplate = `
## Data-Layer Separation Context

- **Current**: Stateful data resources (RDS, DynamoDB, ElastiCache) co-located with compute (Lambda, ECS) in same state
- **Target**: Separate data-layer state with strict lifecycle management
- **Key Principle**: Data resources have fundamentally different change velocity and risk profile than compute

### Why This Matters
- Database schema changes need careful rollout — not the same CI/CD as application deploys
- A botched app deploy should not be able to destroy your database
- Data resources need different backup/retention policies enforced at state level
- Blast radius: \`terraform destroy\` on compute should never touch data

### Layer Model
| Layer | Namespace | Change Velocity | Risk | Examples |
|---|---|---|---|---|
| Network | platform | Monthly | Medium | VPC, subnets, NAT, ALB |
| Data | service-data | Weekly (careful) | **High** | RDS, DynamoDB, ElastiCache, Kinesis |
| Compute | service-compute | Daily/hourly | Low | Lambda, ECS, EKS workloads |

### Migration Strategy
1. Identify all stateful data resources in the monolith state
2. Move data resources + their support resources (parameter groups, subnet groups, KMS keys) together
3. Create output interfaces for data endpoints (connection strings, ARNs)
4. Compute layer references data layer via variables
5. Apply different CI/CD policies: data layer needs manual approval, compute can auto-deploy
`;
