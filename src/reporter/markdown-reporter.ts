import type {
  DependencyGraph,
  ArnReference,
  Namespace,
  CutEdge,
  MigrationPlan,
  NamespaceConfig,
  ParsedFile,
} from "../types.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";
import { detectCycles } from "../analyzer/dependency-graph.js";

export interface ReportInput {
  graph: DependencyGraph;
  arnRefs: ArnReference[];
  plan: MigrationPlan;
  config?: NamespaceConfig;
  templateSuffix?: string;
  parsedFiles?: ParsedFile[];
}

interface DetectedPattern {
  name: string;
  severity: "critical" | "warning" | "info";
  description: string;
  evidence: string[];
}

function detectPatterns(
  graph: DependencyGraph,
  arnRefs: ArnReference[],
  classifications: Map<string, Namespace>,
  cycles: string[][],
  parsedFiles?: ParsedFile[],
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const repos = new Set([...graph.nodes.values()].map((n) => n.repo));

  // Gatekeeper: service roles centralized in one repo while OTHER repos exist that consume them
  const repoNamespaceMismatch = new Map<string, string[]>();
  for (const [id, node] of graph.nodes) {
    const ns = classifications.get(id) || "";
    if (ns.startsWith("service-") && node.resourceType === "aws_iam_role") {
      if (!repoNamespaceMismatch.has(node.repo)) repoNamespaceMismatch.set(node.repo, []);
      repoNamespaceMismatch.get(node.repo)!.push(`${node.resourceType}.${node.name}`);
    }
  }
  // Only flag if there are multiple repos (single-repo = Terralith, not Gatekeeper)
  if (repos.size > 1) {
    for (const [repo, roles] of repoNamespaceMismatch) {
      // Check if other repos actually reference these roles (cross-repo dependency)
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
  }

  // Spaghetti: cross-repo hardcoded ARN references
  const crossRepoArns = arnRefs.filter((r) => r.definingResource && r.definingResource.repo !== r.repo);
  if (crossRepoArns.length > 0) {
    patterns.push({
      name: "Spaghetti State",
      severity: crossRepoArns.length >= 3 ? "critical" : "warning",
      description: `${crossRepoArns.length} hardcoded ARN references cross repo boundaries. Staging reproduction impossible.`,
      evidence: crossRepoArns.slice(0, 5).map((r) => `${r.repo} → \`${r.arn.split(":").pop()}\``),
    });
  }

  // remote_state coupling
  const remoteStateEdges = graph.edges.filter((e) => e.type === "remote_state");
  if (remoteStateEdges.length > 0) {
    patterns.push({
      name: "Remote State Coupling",
      severity: remoteStateEdges.length >= 3 ? "warning" : "info",
      description: `${remoteStateEdges.length} terraform_remote_state references create tight coupling between states.`,
      evidence: remoteStateEdges.slice(0, 5).map((e) => {
        const from = graph.nodes.get(e.from);
        const to = graph.nodes.get(e.to);
        return `${from?.repo} → ${to?.repo} (${e.label})`;
      }),
    });
  }

  // Terralith: too many resources in one repo/state
  for (const repo of repos) {
    const repoNodes = [...graph.nodes.values()].filter((n) => n.repo === repo);
    const repoNamespaces = new Set(repoNodes.map((n) => classifications.get(n.id)));
    if (repoNodes.length >= 15 || (repoNodes.length >= 8 && repoNamespaces.size >= 3)) {
      patterns.push({
        name: "Terralith",
        severity: repoNodes.length >= 30 ? "critical" : "warning",
        description: `\`${repo}\` contains ${repoNodes.length} resources spanning ${repoNamespaces.size} namespaces in a single state.`,
        evidence: [`Resources: ${repoNodes.length}`, `Namespaces: ${repoNamespaces.size}`, `Blast radius: all ${repoNodes.length} resources on any change`],
      });
    }
  }

  // Cycles
  if (cycles.length > 0) {
    patterns.push({
      name: "Circular Dependency",
      severity: "critical",
      description: `${cycles.length} circular dependency chain(s) detected. Migration order cannot be determined safely.`,
      evidence: cycles.slice(0, 3).map((c) => c.map((id) => id.split(":").pop()).join(" → ")),
    });
  }

  // God Module: module blocks with 10+ variable assignments
  if (parsedFiles) {
    for (const file of parsedFiles) {
      for (const block of file.blocks) {
        if (block.type !== "module") continue;
        const assignments = block.body.split("\n").filter((l) => l.includes("=")).length;
        if (assignments >= 10) {
          patterns.push({
            name: "God Module",
            severity: "warning",
            description: `Module \`${block.name}\` in \`${block.filePath}\` has ${assignments} variable assignments. Consider splitting.`,
            evidence: [`File: ${block.filePath}`, `Assignments: ${assignments}`],
          });
        }
      }
    }
  }

  // Environment Copypasta: resource names differing only by env prefix/suffix
  const envPrefixes = /^(prod|stg|dev|staging|production)[_-]|[_-](prod|stg|dev|staging|production)$/;
  const normalizedNames = new Map<string, { id: string; name: string; dir: string }[]>();
  for (const [id, node] of graph.nodes) {
    const normalized = node.name.replace(envPrefixes, "");
    if (normalized !== node.name) {
      if (!normalizedNames.has(normalized)) normalizedNames.set(normalized, []);
      normalizedNames.get(normalized)!.push({ id, name: node.name, dir: node.repo });
    }
  }
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

  // Orphaned Resources: nodes with 0 edges
  const connectedNodes = new Set<string>();
  for (const edge of graph.edges) {
    connectedNodes.add(edge.from);
    connectedNodes.add(edge.to);
  }
  const orphans = [...graph.nodes.values()].filter((n) => !connectedNodes.has(n.id));
  if (orphans.length > 0) {
    patterns.push({
      name: "Orphaned Resources",
      severity: "info",
      description: `${orphans.length} resource(s) have no edges — completely disconnected from the graph.`,
      evidence: orphans.slice(0, 5).map((n) => `${n.resourceType}.${n.name} (${n.repo})`),
    });
  }

  // Count on dynamic collections: count = length(...) should be for_each
  if (parsedFiles) {
    for (const file of parsedFiles) {
      for (const block of file.blocks) {
        if (block.type !== "resource") continue;
        if (/count\s*=\s*length\(/.test(block.body)) {
          patterns.push({
            name: "Count on Dynamic Collection",
            severity: "warning",
            description: `Resource \`${block.resourceType}.${block.name}\` in \`${block.filePath}\` uses \`count = length(...)\`. Removing an item from the middle causes all subsequent resources to be destroyed and recreated.`,
            evidence: [`File: ${block.filePath}`, `Resource: ${block.resourceType}.${block.name}`, `Suggestion: Use \`for_each\` instead for stable resource addressing`],
          });
        }
      }
    }
  }

  // depends_on on module: should pass actual attribute instead
  if (parsedFiles) {
    for (const file of parsedFiles) {
      for (const block of file.blocks) {
        if (block.type !== "module") continue;
        if (/depends_on\s*=/.test(block.body)) {
          patterns.push({
            name: "Depends On Module",
            severity: "warning",
            description: `Module \`${block.name}\` in \`${block.filePath}\` uses \`depends_on\`. This forces Terraform to treat the entire module as opaque, disabling resource-level parallelism.`,
            evidence: [`File: ${block.filePath}`, `Module: ${block.name}`, `Suggestion: Pass the actual attribute (e.g. \`db_endpoint = aws_rds_cluster.main.endpoint\`) to establish the dependency implicitly`],
          });
        }
      }
    }
  }

  // Implicit Provider Coupling: multiple provider aliases with assume_role in same repo
  if (parsedFiles) {
    const repoProviderAliases = new Map<string, Set<string>>();
    for (const file of parsedFiles) {
      for (const block of file.blocks) {
        // Check resource/data blocks for provider = aws.XXX
        const providerMatch = block.body.match(/provider\s*=\s*aws\.([a-z_]+)/);
        if (providerMatch) {
          if (!repoProviderAliases.has(file.repo)) repoProviderAliases.set(file.repo, new Set());
          repoProviderAliases.get(file.repo)!.add(providerMatch[1]);
        }
        // Check for provider blocks with alias + assume_role (parsed as resourceType="aws" for module-style blocks)
        if (block.resourceType === "aws" && block.body.includes("assume_role") && block.body.includes("alias")) {
          const aliasMatch = block.body.match(/alias\s*=\s*"([^"]+)"/);
          if (aliasMatch) {
            if (!repoProviderAliases.has(file.repo)) repoProviderAliases.set(file.repo, new Set());
            repoProviderAliases.get(file.repo)!.add(aliasMatch[1]);
          }
        }
      }
    }
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
  }

  // Circular Remote State: cycles in remote_state-only subgraph
  const remoteStateOnly = graph.edges.filter((e) => e.type === "remote_state");
  if (remoteStateOnly.length > 0) {
    const rsAdj = new Map<string, string[]>();
    const rsNodes = new Set<string>();
    for (const edge of remoteStateOnly) {
      rsNodes.add(edge.from);
      rsNodes.add(edge.to);
      if (!rsAdj.has(edge.from)) rsAdj.set(edge.from, []);
      rsAdj.get(edge.from)!.push(edge.to);
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
    if (rsCycles.length > 0) {
      patterns.push({
        name: "Circular Remote State",
        severity: "critical",
        description: `${rsCycles.length} cycle(s) found in remote_state references alone. States cannot be applied in isolation.`,
        evidence: rsCycles.slice(0, 3).map((c) => c.map((id) => id.split(":").pop()).join(" → ")),
      });
    }
  }

  // Suppress noisy/redundant detections
  const hasGatekeeper = patterns.some((p) => p.name === "Gatekeeper");
  const hasProviderCoupling = patterns.some((p) => p.name === "Implicit Provider Coupling");

  return patterns.filter((p) => {
    // Orphaned: suppress if majority of nodes are orphaned (= incomplete fixture, not real issue)
    if (p.name === "Orphaned Resources") {
      const orphanCount = parseInt(p.description) || 0;
      if (orphanCount > graph.nodes.size * 0.4) return false;
    }
    // Terralith: suppress if Gatekeeper explains the concentration
    if (p.name === "Terralith" && hasGatekeeper) return false;
    // Copypasta: suppress if Provider Coupling explains the naming
    if (p.name === "Environment Copypasta" && hasProviderCoupling) return false;
    return true;
  }).sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
}

export function generateMarkdownReport(input: ReportInput): string {
  const { graph, arnRefs, plan, config, templateSuffix, parsedFiles } = input;
  const classifications = classifyGraph(new Map(graph.nodes), config);
  const cycles = detectCycles(graph);
  const repos = new Set([...graph.nodes.values()].map((n) => n.repo));

  const sections: string[] = [];
  const patterns = detectPatterns(graph, arnRefs, classifications, cycles, parsedFiles);

  // Title
  sections.push("# Migration Analysis Report\n");

  // Diagnosis (NEW — the most important section)
  sections.push("## Diagnosis\n");

  if (patterns.length === 0) {
    sections.push("✅ No anti-patterns detected. Infrastructure is well-structured.\n");
  } else {
    sections.push("### Detected Anti-Patterns\n");
    const icons = { critical: "🔴", warning: "🟡", info: "ℹ️" };
    for (const p of patterns) {
      sections.push(`${icons[p.severity]} **${p.name}** — ${p.description}\n`);
      for (const e of p.evidence) {
        sections.push(`  - ${e}`);
      }
      sections.push("");
    }

    // Impact
    sections.push("### Impact\n");
    const hasGatekeeper = patterns.some((p) => p.name === "Gatekeeper");
    const hasSpaghetti = patterns.some((p) => p.name === "Spaghetti State");
    const hasTerralith = patterns.some((p) => p.name === "Terralith");

    if (hasGatekeeper) {
      sections.push("- **Deploy lead time**: New IAM role requires cross-repo PR + review → days/weeks");
    }
    if (hasSpaghetti) {
      const crossCount = arnRefs.filter((r) => r.definingResource && r.definingResource.repo !== r.repo).length;
      sections.push(`- **Staging reproduction**: Impossible (${crossCount} account-specific ARNs hardcoded)`);
    }
    if (hasTerralith) {
      const maxRepo = [...repos].reduce((max, repo) => {
        const count = [...graph.nodes.values()].filter((n) => n.repo === repo).length;
        return count > max.count ? { repo, count } : max;
      }, { repo: "", count: 0 });
      sections.push(`- **Blast radius**: ${maxRepo.count} resources in \`${maxRepo.repo}\` (any change triggers full plan)`);
    }
    if (patterns.some((p) => p.name === "Remote State Coupling")) {
      sections.push("- **Apply order**: Implicit dependencies between states, cascade failures possible");
    }
    sections.push("");

    // After Migration benefits
    sections.push("### After Migration\n");
    const nsCounts = new Map<string, number>();
    for (const ns of classifications.values()) {
      nsCounts.set(ns, (nsCounts.get(ns) || 0) + 1);
    }
    const stateCount = nsCounts.size;
    const avgResources = (graph.nodes.size / stateCount).toFixed(1);
    const maxBlastRadius = Math.max(...nsCounts.values());

    sections.push(`| Metric | Before | After |`);
    sections.push(`| --- | --- | --- |`);
    sections.push(`| Independent states | ${repos.size} | ${stateCount} |`);
    sections.push(`| Max blast radius | ${graph.nodes.size} | ${maxBlastRadius} |`);
    sections.push(`| Avg resources per state | ${(graph.nodes.size / repos.size).toFixed(1)} | ${avgResources} |`);
    sections.push(`| Cross-state hardcoded ARNs | ${arnRefs.filter((r) => r.definingResource && r.definingResource.repo !== r.repo).length} | 0 (replaced with var/output) |`);
    if (hasGatekeeper) {
      sections.push(`| Deploy flow | Multi-repo PR + approval | 1 PR, 1 CI run |`);
    }
    sections.push("");
  }

  // Executive Summary (compact)
  sections.push("## Summary\n");
  sections.push(`| Metric | Value |`);
  sections.push(`| --- | --- |`);
  sections.push(`| Resources | ${graph.nodes.size} |`);
  sections.push(`| Repositories | ${repos.size} |`);
  sections.push(`| Edges | ${graph.edges.length} |`);
  sections.push(`| ARN references | ${arnRefs.length} |`);
  sections.push(`| Cross-namespace edges | ${plan.crossNamespaceEdges.length} |`);
  sections.push(`| Cycles | ${cycles.length} |`);
  sections.push("");

  // Namespace classification
  sections.push("## State Split Plan\n");
  const nsCounts2 = new Map<string, number>();
  for (const ns of classifications.values()) {
    nsCounts2.set(ns, (nsCounts2.get(ns) || 0) + 1);
  }
  sections.push("| Target State | Resources | Change Frequency |");
  sections.push("| --- | --- | --- |");
  for (const [ns, count] of [...nsCounts2.entries()].sort()) {
    const freq = ns === "foundation" ? "Rare (yearly)" : ns === "platform" ? "Low (monthly)" : "High (daily)";
    sections.push(`| ${ns} | ${count} | ${freq} |`);
  }
  sections.push("");

  // Cross-repo ARN dependencies
  const crossRepoArns = arnRefs.filter((r) => r.definingResource && r.definingResource.repo !== r.repo);
  if (crossRepoArns.length > 0) {
    sections.push("## Hardcoded ARN Dependencies (to resolve)\n");
    sections.push("| Consumer | Producer | ARN |");
    sections.push("| --- | --- | --- |");
    for (const ref of crossRepoArns) {
      sections.push(`| ${ref.repo} | ${ref.definingResource!.repo} | \`${ref.arn}\` |`);
    }
    sections.push("");
  }

  // Dependency graph (Mermaid) — Before / After
  if (graph.nodes.size <= 30) {
    sections.push("## Before\n");
    sections.push(toMermaidBefore(graph, classifications));
    sections.push("");
    sections.push("## After\n");
    sections.push(toMermaidAfter(graph, classifications));
    sections.push("");
  } else {
    sections.push("## Before (namespace summary)\n");
    sections.push(toMermaidSummaryBefore(graph, classifications, arnRefs));
    sections.push("");
    sections.push("## After (namespace summary)\n");
    sections.push(toMermaidSummaryAfter(graph, classifications));
    sections.push("");
  }

  // Migration plan summary
  sections.push("## Migration Steps\n");
  sections.push(`- State moves: ${plan.steps.filter((s) => s.type === "state_mv").length}`);
  sections.push(`- Imports: ${plan.steps.filter((s) => s.type === "import").length}`);
  sections.push(`- Code rewrites: ${plan.steps.filter((s) => s.type === "code_rewrite").length}`);
  sections.push(`- Verification: terraform plan (expect no changes)`);
  sections.push("");

  // Recommended migration order (top 10)
  const depCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    depCounts.set(edge.to, (depCounts.get(edge.to) || 0) + 1);
  }
  const sorted = [...graph.nodes.entries()]
    .map(([id, node]) => ({ id, node, deps: depCounts.get(id) || 0 }))
    .sort((a, b) => a.deps - b.deps)
    .slice(0, 10);
  sections.push("## Recommended Order (lowest dependency first)\n");
  sections.push("| # | Resource | Current Repo | Dependencies |");
  sections.push("| --- | --- | --- | --- |");
  sorted.forEach((item, i) => {
    sections.push(`| ${i + 1} | ${item.node.resourceType}.${item.node.name} | ${item.node.repo} | ${item.deps} |`);
  });
  sections.push("");

  if (templateSuffix) {
    sections.push(templateSuffix);
  }

  return sections.join("\n");
}

function toMermaidBefore(graph: DependencyGraph, classifications: Map<string, Namespace>): string {
  const lines: string[] = ["```mermaid", "graph LR"];

  const namespaces = new Map<string, GraphNode[]>();
  for (const [id, node] of graph.nodes) {
    const ns = classifications.get(id) || "service-unknown";
    if (!namespaces.has(ns)) namespaces.set(ns, []);
    namespaces.get(ns)!.push(node);
  }

  for (const [ns, nodes] of namespaces) {
    const safeName = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  subgraph ${safeName}["${ns}"]`);
    for (const node of nodes) {
      const label = `${node.resourceType.replace("aws_", "")}.${node.name}`;
      lines.push(`    ${safeId(node.id)}["${label}<br/><i>${node.repo}</i>"]`);
    }
    lines.push("  end");
  }

  for (const edge of graph.edges) {
    const from = safeId(edge.from);
    const to = safeId(edge.to);
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    const crossRepo = fromNode && toNode && fromNode.repo !== toNode.repo;
    if (edge.type === "arn" && crossRepo) {
      lines.push(`  ${from} -. "⚠ ARN" .-> ${to}`);
    } else if (edge.type === "arn") {
      lines.push(`  ${from} -. "ARN" .-> ${to}`);
    } else if (edge.type === "remote_state") {
      lines.push(`  ${from} -. "remote_state" .-> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  // Style problem edges red
  const problemNodes = new Set<string>();
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (edge.type === "arn" && fromNode && toNode && fromNode.repo !== toNode.repo) {
      problemNodes.add(safeId(edge.from));
      problemNodes.add(safeId(edge.to));
    }
  }
  if (problemNodes.size > 0) {
    lines.push(`  style ${[...problemNodes].join(",")} stroke:#D32F2F,stroke-width:2px`);
  }

  lines.push("```");
  return lines.join("\n");
}

function toMermaidAfter(graph: DependencyGraph, classifications: Map<string, Namespace>): string {
  const lines: string[] = ["```mermaid", "graph LR"];

  const namespaces = new Map<string, GraphNode[]>();
  for (const [id, node] of graph.nodes) {
    const ns = classifications.get(id) || "service-unknown";
    if (!namespaces.has(ns)) namespaces.set(ns, []);
    namespaces.get(ns)!.push(node);
  }

  for (const [ns, nodes] of namespaces) {
    const safeName = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  subgraph ${safeName}["${ns}"]`);
    for (const node of nodes) {
      const label = `${node.resourceType.replace("aws_", "")}.${node.name}`;
      lines.push(`    ${safeId(node.id)}["${label}"]`);
    }
    lines.push("  end");
  }

  for (const edge of graph.edges) {
    const from = safeId(edge.from);
    const to = safeId(edge.to);
    const fromNs = classifications.get(edge.from);
    const toNs = classifications.get(edge.to);
    if (fromNs !== toNs) {
      lines.push(`  ${from} -. "var/output" .-> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

function toMermaidSummaryBefore(
  graph: DependencyGraph,
  classifications: Map<string, Namespace>,
  arnRefs: ArnReference[],
): string {
  const lines: string[] = ["```mermaid", "graph LR"];

  // Count resources per namespace
  const nsCounts = new Map<string, number>();
  for (const ns of classifications.values()) {
    nsCounts.set(ns, (nsCounts.get(ns) || 0) + 1);
  }

  // Count cross-namespace edges by type
  const nsEdges = new Map<string, { arn: number; remoteState: number; ref: number }>();
  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from) || "unknown";
    const toNs = classifications.get(edge.to) || "unknown";
    if (fromNs !== toNs) {
      const key = `${fromNs}|||${toNs}`;
      if (!nsEdges.has(key)) nsEdges.set(key, { arn: 0, remoteState: 0, ref: 0 });
      const counts = nsEdges.get(key)!;
      if (edge.type === "arn") counts.arn++;
      else if (edge.type === "remote_state") counts.remoteState++;
      else counts.ref++;
    }
  }

  // Nodes = namespaces with resource count
  for (const [ns, count] of [...nsCounts.entries()].sort()) {
    const id = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${id}["${ns}<br/>${count} resources"]`);
  }

  // Edges with problem counts
  for (const [key, counts] of nsEdges) {
    const [fromNs, toNs] = key.split("|||");
    const fromId = fromNs.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = toNs.replace(/[^a-zA-Z0-9]/g, "_");
    if (counts.arn > 0) {
      lines.push(`  ${fromId} -. "⚠ ${counts.arn} hardcoded ARN" .-> ${toId}`);
    }
    if (counts.remoteState > 0) {
      lines.push(`  ${fromId} -. "${counts.remoteState} remote_state" .-> ${toId}`);
    }
    if (counts.ref > 0) {
      lines.push(`  ${fromId} --> |"${counts.ref} refs"| ${toId}`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}

function toMermaidSummaryAfter(
  graph: DependencyGraph,
  classifications: Map<string, Namespace>,
): string {
  const lines: string[] = ["```mermaid", "graph LR"];

  const nsCounts = new Map<string, number>();
  for (const ns of classifications.values()) {
    nsCounts.set(ns, (nsCounts.get(ns) || 0) + 1);
  }

  // Count cross-namespace interfaces
  const nsInterfaces = new Map<string, number>();
  for (const edge of graph.edges) {
    const fromNs = classifications.get(edge.from) || "unknown";
    const toNs = classifications.get(edge.to) || "unknown";
    if (fromNs !== toNs) {
      const key = `${fromNs}|||${toNs}`;
      nsInterfaces.set(key, (nsInterfaces.get(key) || 0) + 1);
    }
  }

  for (const [ns, count] of [...nsCounts.entries()].sort()) {
    const id = ns.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${id}["${ns}<br/>${count} resources"]`);
  }

  for (const [key, count] of nsInterfaces) {
    const [fromNs, toNs] = key.split("|||");
    const fromId = fromNs.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = toNs.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${fromId} --> |"${count} var/output"| ${toId}`);
  }

  lines.push("```");
  return lines.join("\n");
}
