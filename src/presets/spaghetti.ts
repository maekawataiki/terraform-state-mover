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

/**
 * Normalize a service name to produce a consistent namespace slug.
 * Converts underscores to hyphens and lowercases.
 */
function normalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * Infer namespace from a remote state block name.
 * Remote state names often indicate what they reference:
 * 'network', 'platform', 'vpc' → platform
 * Service-like names → service-{name}
 */
function inferNamespaceFromRemoteStateName(name: string): Namespace {
  const normalized = name.toLowerCase();

  if (/network|vpc|subnet|infra[-_]?network/i.test(normalized)) {
    return "platform";
  }

  if (/platform|shared|core|common|infra[-_]?platform/i.test(normalized)) {
    return "platform";
  }

  if (/foundation|org|scp|control[-_]?tower/i.test(normalized)) {
    return "foundation";
  }

  return `service-${normalizeServiceName(name)}`;
}

/**
 * Classify a resource for the Spaghetti State pattern.
 *
 * In the Spaghetti State pattern, repos are tightly coupled through
 * terraform_remote_state data sources and hardcoded ARN references.
 * This classifier groups resources by their natural ownership boundary
 * to enable replacement of remote_state with var/output interfaces.
 */
export function classifySpaghettiResource(node: GraphNode): Namespace | null {
  // data.terraform_remote_state → classify to the namespace they reference
  if (node.type === "data" && node.resourceType === "terraform_remote_state") {
    return inferNamespaceFromRemoteStateName(node.name);
  }

  // VPC/networking resources → platform
  if (NETWORKING_TYPES.has(node.resourceType)) {
    return "platform";
  }

  // IAM roles with 'platform' in name → platform
  if (node.resourceType === "aws_iam_role" && /platform/i.test(node.name)) {
    return "platform";
  }

  // Resources with a repo → classify to service-{repo} (repo-based grouping)
  if (node.repo) {
    // Detect platform-like repo names
    if (/^(infra[-_]?(platform|network|shared)|platform|network)/i.test(node.repo)) {
      return "platform";
    }

    // Detect foundation-like repo names
    if (/^(infra[-_]?(foundation|central)|org[-_]|scp[-_])/i.test(node.repo)) {
      return "foundation";
    }

    // Service repos → service-{repo}
    const serviceMatch = node.repo.match(/^(?:service[-_]|svc[-_]|app[-_])(.+)$/i);
    if (serviceMatch) {
      return `service-${normalizeServiceName(serviceMatch[1])}`;
    }

    return `service-${normalizeServiceName(node.repo)}`;
  }

  // Return null to fall through to the default classifier
  return null;
}

export const spaghettiConfig: NamespaceConfig = {
  customClassifier: classifySpaghettiResource,
  groupByRepo: true,
};

export const spaghettiReportTemplate = `
## Spaghetti State Context

- **Spaghetti State (current)**: Cross-state dependencies via \`terraform_remote_state\` and hardcoded ARNs
- **Target**: Replace \`data.terraform_remote_state\` with explicit \`var\`/\`output\` interfaces
- **Key Principle**: Each state should declare outputs for its consumers, not expose its entire state

### Why This Matters
- \`terraform_remote_state\` exposes the entire state to consumers — any output rename breaks downstream
- Hardcoded ARNs create invisible coupling — no dependency graph tooling can track them
- Cascade failures: changing one state forces re-plan of all consumers
- Circular references (A→B→A) make safe deployment ordering impossible

### Migration Strategy
1. Identify all \`data.terraform_remote_state\` consumers and what attributes they read
2. Create explicit \`variable\` declarations in consumer repos
3. Create \`output\` declarations in provider repos
4. Wire via CI/CD or Terragrunt dependency blocks
5. Remove \`data.terraform_remote_state\` blocks
`;
