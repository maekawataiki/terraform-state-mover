import type {
  DependencyGraph,
  ArnReference,
  Namespace,
  ParsedFile,
  DetectedPattern,
  PatternThresholds,
} from "../types.js";
import { getOrCreate } from "../utils/map-utils.js";

export type { DetectedPattern, PatternThresholds } from "../types.js";

// ---------------------------------------------------------------------------
// Pattern detection context — shared by all pattern detectors
// ---------------------------------------------------------------------------

export interface PatternContext {
  graph: DependencyGraph;
  arnRefs: ArnReference[];
  classifications: Map<string, Namespace>;
  cycles: string[][];
  parsedFiles?: ParsedFile[];
  thresholds: PatternThresholds;
  repos: Set<string>;
}

/** A pattern detector function. Returns detected patterns (may return empty). */
export type PatternDetector = (ctx: PatternContext) => DetectedPattern[];

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: PatternThresholds = {
  terralithMinResources: 15,
  terralithMinResourcesWithDiversity: 8,
  terralithMinNamespaces: 3,
  terralithCriticalThreshold: 30,
  godModuleMinAssignments: 10,
};

// ---------------------------------------------------------------------------
// Pattern registry — each detector is a standalone function
// ---------------------------------------------------------------------------

export const detectGatekeeper: PatternDetector = (ctx) => {
  const { graph, classifications, repos } = ctx;
  if (repos.size <= 1) return [];

  const repoNamespaceMismatch = new Map<string, string[]>();
  for (const [id, node] of graph.nodes) {
    const ns = classifications.get(id) || "";
    if (ns.startsWith("service-") && node.resourceType === "aws_iam_role") {
      getOrCreate(repoNamespaceMismatch, node.repo, () => []).push(`${node.resourceType}.${node.name}`);
    }
  }

  const patterns: DetectedPattern[] = [];
  for (const [repo, roles] of repoNamespaceMismatch) {
    const otherReposExist = [...graph.nodes.values()].some((n) => n.repo !== repo);
    if (roles.length >= 2 && otherReposExist) {
      patterns.push({
        name: "Gatekeeper",
        severity: "critical",
        description: `${roles.length} service-specific IAM roles centralized in \`${repo}\`. Services cannot deploy independently.`,
        evidence: roles.slice(0, 5),
      });
    }
  }
  return patterns;
};

export const detectSpaghetti: PatternDetector = (ctx) => {
  const { arnRefs } = ctx;
  const crossRepoArns = arnRefs.filter((r) => r.definingResource && r.definingResource.repo !== r.repo);
  if (crossRepoArns.length === 0) return [];

  return [{
    name: "Spaghetti State",
    severity: crossRepoArns.length >= 3 ? "critical" : "warning",
    description: `${crossRepoArns.length} hardcoded ARN references cross repo boundaries. Staging reproduction impossible.`,
    evidence: crossRepoArns.slice(0, 5).map((r) => `${r.repo} → \`${r.arn.split(":").pop()}\``),
  }];
};

export const detectRemoteStateCoupling: PatternDetector = (ctx) => {
  const { graph } = ctx;
  const remoteStateEdges = graph.edges.filter((e) => e.type === "remote_state");
  if (remoteStateEdges.length === 0) return [];

  return [{
    name: "Remote State Coupling",
    severity: remoteStateEdges.length >= 3 ? "warning" : "info",
    description: `${remoteStateEdges.length} terraform_remote_state references create tight coupling between states.`,
    evidence: remoteStateEdges.slice(0, 5).map((e) => {
      const from = graph.nodes.get(e.from);
      const to = graph.nodes.get(e.to);
      return `${from?.repo} → ${to?.repo} (${e.label})`;
    }),
  }];
};

export const detectTerralith: PatternDetector = (ctx) => {
  const { graph, classifications, repos, thresholds: t } = ctx;
  const patterns: DetectedPattern[] = [];

  for (const repo of repos) {
    const repoNodes = [...graph.nodes.values()].filter((n) => n.repo === repo);
    const repoNamespaces = new Set(repoNodes.map((n) => classifications.get(n.id)));
    if (repoNodes.length >= t.terralithMinResources || (repoNodes.length >= t.terralithMinResourcesWithDiversity && repoNamespaces.size >= t.terralithMinNamespaces)) {
      patterns.push({
        name: "Terralith",
        severity: repoNodes.length >= t.terralithCriticalThreshold ? "critical" : "warning",
        description: `\`${repo}\` contains ${repoNodes.length} resources spanning ${repoNamespaces.size} namespaces in a single state.`,
        evidence: [`Resources: ${repoNodes.length}`, `Namespaces: ${repoNamespaces.size}`, `Blast radius: all ${repoNodes.length} resources on any change`],
      });
    }
  }
  return patterns;
};

export const detectCycles: PatternDetector = (ctx) => {
  const { cycles } = ctx;
  if (cycles.length === 0) return [];

  return [{
    name: "Circular Dependency",
    severity: "critical",
    description: `${cycles.length} circular dependency chain(s) detected. Migration order cannot be determined safely.`,
    evidence: cycles.slice(0, 3).map((c) => c.map((id) => id.split(":").pop()).join(" → ")),
  }];
};

export const detectGodModule: PatternDetector = (ctx) => {
  const { parsedFiles, thresholds: t } = ctx;
  if (!parsedFiles) return [];
  const patterns: DetectedPattern[] = [];

  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "module") continue;
      let assignments: number;
      if (block.rawBody) {
        assignments = block.rawBody.split("\n").filter((l) => l.includes("=")).length;
      } else {
        try {
          const parsed = JSON.parse(block.body);
          const configs = Array.isArray(parsed) ? parsed[0] : parsed;
          assignments = Object.keys(configs || {}).filter((k) => k !== "source").length;
        } catch {
          assignments = block.body.split("\n").filter((l) => l.includes("=")).length;
        }
      }
      if (assignments >= t.godModuleMinAssignments) {
        patterns.push({
          name: "God Module",
          severity: "warning",
          description: `Module \`${block.name}\` in \`${block.filePath}\` has ${assignments} variable assignments. Consider splitting.`,
          evidence: [`File: ${block.filePath}`, `Assignments: ${assignments}`],
        });
      }
    }
  }
  return patterns;
};

export const detectEnvironmentCopypasta: PatternDetector = (ctx) => {
  const { graph } = ctx;
  const envPrefixes = /^(prod|stg|dev|staging|production)[_-]|[_-](prod|stg|dev|staging|production)$/;
  const normalizedNames = new Map<string, { id: string; name: string; dir: string }[]>();

  for (const [id, node] of graph.nodes) {
    const normalized = node.name.replace(envPrefixes, "");
    if (normalized !== node.name) {
      getOrCreate(normalizedNames, normalized, () => []).push({ id, name: node.name, dir: node.repo });
    }
  }

  const patterns: DetectedPattern[] = [];
  for (const [normalized, group] of normalizedNames) {
    const uniqueDirs = new Set(group.map((g) => g.dir));
    if (group.length >= 3 || (group.length >= 2 && uniqueDirs.size >= 2)) {
      patterns.push({
        name: "Environment Copypasta",
        severity: "warning",
        description: `${group.length} resources share base name \`${normalized}\` with only env prefix/suffix differences.`,
        evidence: group.slice(0, 5).map((g) => `${g.name} (${g.dir})`),
      });
    }
  }
  return patterns;
};

export const detectOrphanedResources: PatternDetector = (ctx) => {
  const { graph } = ctx;
  const connectedNodes = new Set<string>();
  for (const edge of graph.edges) {
    connectedNodes.add(edge.from);
    connectedNodes.add(edge.to);
  }
  const orphans = [...graph.nodes.values()].filter((n) => !connectedNodes.has(n.id));
  if (orphans.length === 0) return [];

  return [{
    name: "Orphaned Resources",
    severity: "info",
    description: `${orphans.length} resource(s) have no edges — completely disconnected from the graph.`,
    evidence: orphans.slice(0, 5).map((n) => `${n.resourceType}.${n.name} (${n.repo})`),
  }];
};

export const detectCountOnCollection: PatternDetector = (ctx) => {
  const { parsedFiles } = ctx;
  if (!parsedFiles) return [];
  const patterns: DetectedPattern[] = [];

  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "resource") continue;
      const bodyText = block.rawBody || block.body;
      if (/count\s*=\s*length\(/.test(bodyText)) {
        patterns.push({
          name: "Count on Dynamic Collection",
          severity: "warning",
          description: `Resource \`${block.resourceType}.${block.name}\` in \`${block.filePath}\` uses \`count = length(...)\`. Removing an item from the middle causes all subsequent resources to be destroyed and recreated.`,
          evidence: [`File: ${block.filePath}`, `Resource: ${block.resourceType}.${block.name}`, `Suggestion: Use \`for_each\` instead for stable resource addressing`],
        });
      }
    }
  }
  return patterns;
};

export const detectDependsOnModule: PatternDetector = (ctx) => {
  const { parsedFiles } = ctx;
  if (!parsedFiles) return [];
  const patterns: DetectedPattern[] = [];

  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "module") continue;
      const bodyText = block.rawBody || block.body;
      const hasDependsOn = /depends_on\s*=/.test(bodyText) || bodyText.includes("\"depends_on\"");
      if (hasDependsOn) {
        patterns.push({
          name: "Depends On Module",
          severity: "warning",
          description: `Module \`${block.name}\` in \`${block.filePath}\` uses \`depends_on\`. This forces Terraform to treat the entire module as opaque, disabling resource-level parallelism.`,
          evidence: [`File: ${block.filePath}`, `Module: ${block.name}`, `Suggestion: Pass the actual attribute (e.g. \`db_endpoint = aws_rds_cluster.main.endpoint\`) to establish the dependency implicitly`],
        });
      }
    }
  }
  return patterns;
};

export const detectProviderCoupling: PatternDetector = (ctx) => {
  const { parsedFiles } = ctx;
  if (!parsedFiles) return [];

  const repoProviderAliases = new Map<string, Set<string>>();
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      const bodyText = block.rawBody || block.body;
      const providerMatch = bodyText.match(/provider\s*=\s*aws\.([a-z_]+)/);
      if (providerMatch) {
        getOrCreate(repoProviderAliases, file.repo, () => new Set()).add(providerMatch[1]);
      }
      if (block.resourceType === "aws" && block.body.includes("assume_role") && block.body.includes("alias")) {
        const aliasMatch = block.body.match(/alias\s*=\s*"([^"]+)"/);
        if (aliasMatch) {
          getOrCreate(repoProviderAliases, file.repo, () => new Set()).add(aliasMatch[1]);
        }
      }
    }
  }

  const patterns: DetectedPattern[] = [];
  for (const [repo, aliases] of repoProviderAliases) {
    if (aliases.size >= 2) {
      patterns.push({
        name: "Implicit Provider Coupling",
        severity: "warning",
        description: `\`${repo}\` has ${aliases.size} provider aliases — multiple accounts in one state.`,
        evidence: [...aliases].map((a) => `provider alias: ${a}`),
      });
    }
  }
  return patterns;
};

export const detectCircularRemoteState: PatternDetector = (ctx) => {
  const { graph } = ctx;
  const remoteStateOnly = graph.edges.filter((e) => e.type === "remote_state");
  if (remoteStateOnly.length === 0) return [];

  const rsAdj = new Map<string, string[]>();
  const rsNodes = new Set<string>();
  for (const edge of remoteStateOnly) {
    rsNodes.add(edge.from);
    rsNodes.add(edge.to);
    getOrCreate(rsAdj, edge.from, () => []).push(edge.to);
  }

  const rsVisited = new Set<string>();
  const rsStack = new Set<string>();
  const rsPath: string[] = [];
  const rsCycles: string[][] = [];

  function rsDfs(node: string): void {
    rsVisited.add(node);
    rsStack.add(node);
    rsPath.push(node);
    for (const neighbor of rsAdj.get(node) || []) {
      if (!rsVisited.has(neighbor)) {
        rsDfs(neighbor);
      } else if (rsStack.has(neighbor)) {
        const start = rsPath.indexOf(neighbor);
        rsCycles.push(rsPath.slice(start));
      }
    }
    rsPath.pop();
    rsStack.delete(node);
  }

  for (const nodeId of rsNodes) {
    if (!rsVisited.has(nodeId)) rsDfs(nodeId);
  }

  if (rsCycles.length === 0) return [];
  return [{
    name: "Circular Remote State",
    severity: "critical",
    description: `${rsCycles.length} cycle(s) found in remote_state references alone. States cannot be applied in isolation.`,
    evidence: rsCycles.slice(0, 3).map((c) => c.map((id) => id.split(":").pop()).join(" → ")),
  }];
};

// ---------------------------------------------------------------------------
// Default registry — all built-in detectors
// ---------------------------------------------------------------------------

export const DEFAULT_PATTERN_DETECTORS: PatternDetector[] = [
  detectGatekeeper,
  detectSpaghetti,
  detectRemoteStateCoupling,
  detectTerralith,
  detectCycles,
  detectGodModule,
  detectEnvironmentCopypasta,
  detectOrphanedResources,
  detectCountOnCollection,
  detectDependsOnModule,
  detectProviderCoupling,
  detectCircularRemoteState,
];

// ---------------------------------------------------------------------------
// Main entry point — runs all registered detectors
// ---------------------------------------------------------------------------

export function detectPatterns(
  graph: DependencyGraph,
  arnRefs: ArnReference[],
  classifications: Map<string, Namespace>,
  cycles: string[][],
  parsedFiles?: ParsedFile[],
  thresholds?: Partial<PatternThresholds>,
  detectors?: PatternDetector[],
): DetectedPattern[] {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const repos = new Set([...graph.nodes.values()].map((n) => n.repo));

  const ctx: PatternContext = { graph, arnRefs, classifications, cycles, parsedFiles, thresholds: t, repos };
  const activeDetectors = detectors ?? DEFAULT_PATTERN_DETECTORS;

  const patterns: DetectedPattern[] = [];
  for (const detector of activeDetectors) {
    patterns.push(...detector(ctx));
  }

  // Suppress noisy/redundant detections
  const hasGatekeeper = patterns.some((p) => p.name === "Gatekeeper");
  const hasProviderCoupling = patterns.some((p) => p.name === "Implicit Provider Coupling");

  return patterns.filter((p) => {
    if (p.name === "Orphaned Resources") {
      const orphanCount = parseInt(p.description) || 0;
      if (orphanCount > graph.nodes.size * 0.4) return false;
    }
    if (p.name === "Terralith" && hasGatekeeper) return false;
    if (p.name === "Environment Copypasta" && hasProviderCoupling) return false;
    return true;
  }).sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
}
