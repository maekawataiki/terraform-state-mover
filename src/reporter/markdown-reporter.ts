import type {
  DependencyGraph,
  ArnReference,
  MigrationPlan,
  NamespaceConfig,
  ParsedFile,
} from "../types.js";
import { classifyGraph } from "../analyzer/namespace-classifier.js";
import { detectCycles } from "../analyzer/dependency-graph.js";
import { detectPatterns } from "./detect-patterns.js";
import { toMermaidSummaryBefore, toMermaidSummaryAfter } from "./mermaid-graphs.js";

export type { DetectedPattern } from "./detect-patterns.js";

export interface ReportInput {
  graph: DependencyGraph;
  arnRefs: ArnReference[];
  plan: MigrationPlan;
  config?: NamespaceConfig;
  templateSuffix?: string;
  parsedFiles?: ParsedFile[];
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

  // Diagnosis (the most important section)
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

  // Parser warnings summary
  if (parsedFiles) {
    const allWarnings = parsedFiles.flatMap((f) => f.warnings || []);
    const interpolatedArns = allWarnings.filter((w) => w.message.includes("Interpolated ARN"));
    const indexedResources = allWarnings.filter((w) => w.message.includes("for_each") || w.message.includes("count resource"));

    if (interpolatedArns.length > 0 || indexedResources.length > 0) {
      sections.push("## Parser Limitations\n");
      sections.push("The following patterns were detected but cannot be automatically migrated:\n");

      if (interpolatedArns.length > 0) {
        sections.push(`### Interpolated ARNs (${interpolatedArns.length})\n`);
        sections.push("These ARNs contain `${...}` expressions and cannot be statically resolved or auto-rewritten. Manual review required.\n");
        sections.push("| File | Line |");
        sections.push("| --- | --- |");
        for (const w of interpolatedArns.slice(0, 20)) {
          sections.push(`| ${w.filePath} | ${w.line} |`);
        }
        if (interpolatedArns.length > 20) {
          sections.push(`| ... | ${interpolatedArns.length - 20} more |`);
        }
        sections.push("");
      }

      if (indexedResources.length > 0) {
        sections.push(`### Indexed Resources (${indexedResources.length})\n`);
        sections.push("Resources using `for_each` or `count` require per-instance state move commands.\n");
        sections.push("| File | Line | Type |");
        sections.push("| --- | --- | --- |");
        for (const w of indexedResources.slice(0, 20)) {
          const type = w.message.includes("for_each") ? "for_each" : "count";
          sections.push(`| ${w.filePath} | ${w.line} | ${type} |`);
        }
        if (indexedResources.length > 20) {
          sections.push(`| ... | | ${indexedResources.length - 20} more |`);
        }
        sections.push("");
      }
    }
  }

  // Dependency graph (Mermaid)
  sections.push("## Before\n");
  sections.push(toMermaidSummaryBefore(graph, classifications, arnRefs));
  sections.push("");
  sections.push("## After\n");
  sections.push(toMermaidSummaryAfter(graph, classifications));
  sections.push("");

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
