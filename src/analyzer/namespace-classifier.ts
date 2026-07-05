import type { GraphNode, Namespace, NamespaceConfig } from "../types.js";
import {
  FOUNDATION_TYPES,
  FOUNDATION_PATTERNS,
  PLATFORM_TYPES,
  SERVICE_TYPES,
} from "./resource-types.js";

/** Well-known prefixes for inferring namespace from repo names */
const FOUNDATION_REPO_PATTERNS = [/^infra-foundation/, /^org-/, /^scp-/];
const PLATFORM_REPO_PATTERNS = [/^infra-platform/, /^infra-shared/, /^platform-/];
const SERVICE_REPO_PATTERNS = [/^service-/, /^svc-/, /^app-/];

/**
 * Infer namespace from a repo name using naming conventions.
 * Returns null if no convention matches.
 */
function inferNamespaceFromRepo(repo: string): Namespace | null {
  if (FOUNDATION_REPO_PATTERNS.some((p) => p.test(repo))) return "foundation";
  if (PLATFORM_REPO_PATTERNS.some((p) => p.test(repo))) return "platform";
  if (SERVICE_REPO_PATTERNS.some((p) => p.test(repo))) return repoToServiceNamespace(repo);
  return null;
}

/**
 * Derive the service namespace name for a repo.
 * Strips common prefixes to produce a clean name.
 * e.g., "service-orders" → "service-orders" (not "service-service-orders")
 */
function repoToServiceNamespace(repo: string): Namespace {
  if (repo.startsWith("service-")) return repo as Namespace;
  if (repo.startsWith("svc-")) return `service-${repo.slice(4)}` as Namespace;
  if (repo.startsWith("app-")) return `service-${repo.slice(4)}` as Namespace;
  return `service-${repo}`;
}

export function classifyResource(node: GraphNode, config?: NamespaceConfig): Namespace {
  const groupByRepo = config?.groupByRepo ?? true;

  // Check customClassifier first (takes precedence over everything)
  if (config?.customClassifier) {
    const result = config.customClassifier(node);
    if (result !== null) return result;
  }

  // Check overrides
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
  if (FOUNDATION_TYPES.has(node.resourceType)) return "foundation";
  if (FOUNDATION_PATTERNS.some((p) => p.test(node.resourceType))) return "foundation";
  if (node.resourceType === "aws_iam_policy" && /boundary|scp|permission.?boundary/i.test(node.name)) {
    return "foundation";
  }

  // Platform: shared infrastructure
  if (PLATFORM_TYPES.has(node.resourceType)) return "platform";

  // --- Repo-based grouping (new default behavior) ---
  if (groupByRepo) {
    // Try repo naming conventions first
    const repoNs = inferNamespaceFromRepo(node.repo);
    if (repoNs) return repoNs;

    // Service-type resources: group by repo
    if (SERVICE_TYPES.has(node.resourceType)) {
      return repoToServiceNamespace(node.repo);
    }

    // IAM roles: classify by name convention, but fallback to repo
    if (node.resourceType === "aws_iam_role") {
      if (/platform|shared|infra/i.test(node.name)) return "platform";
      return repoToServiceNamespace(node.repo);
    }

    // Default: group by repo
    return repoToServiceNamespace(node.repo);
  }

  // --- Legacy per-resource behavior (groupByRepo: false) ---
  if (SERVICE_TYPES.has(node.resourceType)) {
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
