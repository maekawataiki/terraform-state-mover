import type { NamespaceConfig, Namespace, GraphNode } from "../types.js";

/**
 * Extract provider alias from a resource block body.
 * Looks for `provider = aws.{alias}` patterns.
 * Returns null if default provider (no alias).
 */
function extractProviderAlias(body: string): string | null {
  const match = body.match(/provider\s*=\s*aws\.([a-z_][a-z0-9_-]*)/i);
  return match ? match[1] : null;
}

/**
 * Map of account-environment alias patterns to their namespace category.
 * Used to group provider aliases into logical account boundaries.
 */
const SHARED_ALIAS_PATTERNS = [/^shared/i, /^common/i, /^mgmt/i, /^management/i, /^central/i, /^org/i];
const PROD_ALIAS_PATTERNS = [/^prod/i, /^production/i, /^live/i];
const STAGING_ALIAS_PATTERNS = [/^stag/i, /^preprod/i, /^uat/i];
const DEV_ALIAS_PATTERNS = [/^dev/i, /^sandbox/i, /^test/i];
const NETWORK_ALIAS_PATTERNS = [/^network/i, /^transit/i, /^hub/i, /^connectivity/i];
const SECURITY_ALIAS_PATTERNS = [/^security/i, /^audit/i, /^log[-_]?archive/i, /^guardduty/i];

/**
 * Map a provider alias to a namespace.
 * Groups aliases into account boundary namespaces.
 */
function aliasToNamespace(alias: string): Namespace {
  if (SHARED_ALIAS_PATTERNS.some((p) => p.test(alias))) return "platform";
  if (NETWORK_ALIAS_PATTERNS.some((p) => p.test(alias))) return "platform";
  if (SECURITY_ALIAS_PATTERNS.some((p) => p.test(alias))) return "foundation";
  if (PROD_ALIAS_PATTERNS.some((p) => p.test(alias))) return `service-${alias}`;
  if (STAGING_ALIAS_PATTERNS.some((p) => p.test(alias))) return `service-${alias}`;
  if (DEV_ALIAS_PATTERNS.some((p) => p.test(alias))) return `service-${alias}`;
  // Unknown alias → treat as its own service boundary
  return `service-${alias}`;
}

/**
 * Shared resource types that typically live in a shared services account.
 * These are classified as platform even without a shared provider alias,
 * when found alongside multi-account configurations.
 */
const SHARED_RESOURCE_TYPES = new Set([
  "aws_ecr_repository",
  "aws_route53_zone",
  "aws_acm_certificate",
  "aws_codecommit_repository",
  "aws_codepipeline",
]);

/**
 * Classify a resource for the Cross-Account pattern.
 *
 * In the cross-account pattern, a single Terraform state manages resources
 * across multiple AWS accounts via provider aliases. This classifier groups
 * resources by their provider alias boundary to enable splitting into
 * per-account states.
 *
 * The key insight: resources with `provider = aws.prod` should live in a
 * separate state from those with `provider = aws.staging` — each account
 * should have its own state lifecycle.
 */
export function classifyCrossAccountResource(node: GraphNode): Namespace | null {
  // Attempt to extract provider alias from block body
  // GraphNode doesn't carry body — we rely on the resource type and name heuristics
  // when body isn't available. For accurate classification, we use the
  // custom classifier with access to block body via the presets config.

  // ECR, Route53 zones, ACM → typically shared account
  if (SHARED_RESOURCE_TYPES.has(node.resourceType)) {
    return "platform";
  }

  // IAM roles: classify by name convention
  if (node.resourceType === "aws_iam_role") {
    if (/cross[-_]?account|shared|common/i.test(node.name)) return "platform";
    if (/prod/i.test(node.name)) return "service-prod";
    if (/stag/i.test(node.name)) return "service-staging";
    if (/dev/i.test(node.name)) return "service-dev";
  }

  // Route53 records → classify by name (shared DNS is platform)
  if (node.resourceType === "aws_route53_record") {
    return "platform";
  }

  // ECS/EKS clusters and services → classify by name pattern
  if (node.resourceType === "aws_ecs_cluster" || node.resourceType === "aws_ecs_service") {
    if (/prod/i.test(node.name)) return "service-prod";
    if (/stag/i.test(node.name)) return "service-staging";
    if (/dev/i.test(node.name)) return "service-dev";
  }

  // S3 buckets → classify by name convention
  if (node.resourceType === "aws_s3_bucket") {
    if (/shared|config|common/i.test(node.name)) return "platform";
    if (/prod/i.test(node.name)) return "service-prod";
    if (/stag/i.test(node.name)) return "service-staging";
    if (/dev/i.test(node.name)) return "service-dev";
  }

  return null;
}

/**
 * Create a custom classifier that has access to block bodies for provider alias extraction.
 * This is used as a higher-priority classifier that runs before name-based heuristics.
 */
export function createProviderAliasClassifier(blockBodies: Map<string, string>): (node: GraphNode) => Namespace | null {
  return (node: GraphNode): Namespace | null => {
    const body = blockBodies.get(node.id);
    if (body) {
      const alias = extractProviderAlias(body);
      if (alias) {
        return aliasToNamespace(alias);
      }
    }
    // Fall through to name-based heuristics
    return classifyCrossAccountResource(node);
  };
}

export { extractProviderAlias, aliasToNamespace };

export const crossAccountConfig: NamespaceConfig = {
  customClassifier: classifyCrossAccountResource,
  groupByRepo: false,
};

export const crossAccountReportTemplate = `
## Cross-Account Context

- **Cross-Account (current)**: Single state manages resources across multiple AWS accounts via provider aliases
- **Target**: Separate state per account boundary (shared, prod, staging, dev)
- **Key Principle**: Each AWS account should have its own Terraform state with its own provider configuration

### Why This Matters
- Provider alias coupling means one \`terraform apply\` needs credentials for ALL accounts
- Blast radius: a mistake in staging config can break prod resources in the same plan
- No independent lifecycle: can't deploy to staging without planning against prod
- IAM role assumption chains become fragile and hard to audit

### Migration Strategy
1. Identify all provider aliases and their assume_role configurations
2. Group resources by their provider alias → each alias becomes a separate state
3. Shared resources (ECR, Route53 zones, ACM) move to a "shared-services" state
4. Per-environment resources (ECS, S3, IAM) move to per-account states
5. Cross-account references become outputs + variables (same as spaghetti fix)

### Account Boundary Model
| Provider Alias | Target State | Responsibility |
|---|---|---|
| \`aws\` (default) | management-account | Organization, Control Tower |
| \`aws.shared\` | shared-services | ECR, Route53, shared S3 |
| \`aws.prod\` | prod-account | Production workloads |
| \`aws.staging\` | staging-account | Pre-production testing |
`;
