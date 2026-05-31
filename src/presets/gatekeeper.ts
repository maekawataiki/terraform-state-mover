import type { NamespaceConfig, Namespace, GraphNode } from "../types.js";
import type { ClassificationOverride } from "../types.js";

const gatekeeperOverrides: ClassificationOverride[] = [
  // Permission boundaries → foundation
  { resourceType: "aws_iam_policy", resourceName: "web_tier_boundary", namespace: "foundation" },
  { resourceType: "aws_iam_policy", resourceName: "data_tier_boundary", namespace: "foundation" },
  // Control Tower resources → foundation
  { resourceType: "aws_controltower_control", namespace: "foundation" },
  { resourceType: "aws_controltower_landing_zone", namespace: "foundation" },
  // Organizations → foundation
  { resourceType: "aws_organizations_policy", namespace: "foundation" },
  { resourceType: "aws_organizations_policy_attachment", namespace: "foundation" },
];

export interface GatekeeperModelOptions {
  centralRepoName?: string;
}

const DEFAULT_CENTRAL_REPO = "infra-central";

export const gatekeeperModelConfig: NamespaceConfig = {
  overrides: gatekeeperOverrides,
  customClassifier: classifyGatekeeperResource,
};

/**
 * Normalize a service name to produce a consistent namespace slug.
 * Converts underscores to hyphens and lowercases.
 */
function normalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * Classify a resource using Gatekeeper Model naming conventions.
 *
 * In the Gatekeeper Model, the central repo contains IAM roles that *should*
 * belong to service repos. This classifier identifies which service each role
 * belongs to by matching name patterns against known service repo names.
 */
export function classifyGatekeeperResource(node: GraphNode, options?: GatekeeperModelOptions): Namespace | null {
  const centralRepo = options?.centralRepoName ?? DEFAULT_CENTRAL_REPO;

  // Permission boundaries → foundation
  if (node.resourceType === "aws_iam_policy" && /boundary|scp/i.test(node.name)) {
    return "foundation";
  }

  // EKS cluster roles → platform
  if (node.resourceType === "aws_iam_role" && /eks[-_]?(cluster|node)[-_]?role/i.test(node.name)) {
    return "platform";
  }

  // Service roles following {service}-* naming → service-{service}
  // Use greedy match for multi-segment service names (e.g., app_api_lambda_exec → app-api)
  if (node.resourceType === "aws_iam_role") {
    // Match pattern: {service_name}_{suffix} where suffix is a known role purpose
    const roleSuffixes = /[-_](rds[-_]?access|lambda[-_]?exec|s3[-_]?access|kinesis[-_]?access|sqs[-_]?access|sns[-_]?access|dynamodb[-_]?access|db[-_]?access|processor[-_]?role|processor|exec|role|reader|writer|access)$/i;
    const suffixMatch = node.name.match(roleSuffixes);
    if (suffixMatch) {
      const servicePart = node.name.slice(0, suffixMatch.index);
      return `service-${normalizeServiceName(servicePart)}`;
    }
  }

  // Central repo roles → classify by naming convention
  if (node.repo === centralRepo && node.resourceType === "aws_iam_role") {
    const serviceMatch = node.name.match(/^([a-z][\w-]+?)[-_]/);
    if (serviceMatch) {
      return `service-${normalizeServiceName(serviceMatch[1])}`;
    }
  }

  // Control Tower → foundation
  if (node.resourceType.startsWith("aws_controltower_")) {
    return "foundation";
  }

  // Return null to fall through to the default repo-based classifier
  return null;
}

export const gatekeeperModelReportTemplate = `
## Gatekeeper Model Context

- **Gatekeeper Model (current)**: A central repo owns all IAM roles with blanket Deny SCPs
- **Target Model**: Service repos own their own IAM roles with Permission Boundary guardrails
- **Key Principle**: Permission Boundaries replace SCPs as the primary access control mechanism

### Migration Phases
1. Foundation layer: SCPs + Permission Boundaries remain in the central repo
2. Platform layer: EKS/VPC/shared infra in a platform repo
3. Service layer: Each service owns its IAM roles within boundaries
`;
