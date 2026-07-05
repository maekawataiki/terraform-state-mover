import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  PlanConfigResource,
  PlanValueResource,
  PlanResourceChange,
  ParsedPlan,
} from "../types.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { validatePlanJson } from "./plan-schema.js";

export type { PlanConfigResource, PlanValueResource, PlanResourceChange, ParsedPlan } from "../types.js";

/**
 * Recursively collect all `references` arrays from a block-expressions object.
 * This walks through nested blocks to find every reference in the resource config.
 */
function collectReferences(obj: unknown): string[] {
  const refs: string[] = [];

  function walk(value: unknown): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if ("references" in record && Array.isArray(record.references)) {
        for (const ref of record.references) {
          if (typeof ref === "string") refs.push(ref);
        }
      }
      for (const v of Object.values(record)) {
        if (v !== record.references) walk(v);
      }
    }
  }

  walk(obj);
  return [...new Set(refs)];
}

/**
 * Recursively collect resources from a module configuration (handles child_modules).
 */
function collectConfigResources(module: unknown, prefix = ""): PlanConfigResource[] {
  const resources: PlanConfigResource[] = [];
  if (!module || typeof module !== "object") return resources;
  const mod = module as Record<string, unknown>;

  // Collect resources in this module
  if (Array.isArray(mod.resources)) {
    for (const res of mod.resources) {
      if (!res || typeof res !== "object") continue;
      const r = res as Record<string, unknown>;
      const address = (prefix ? `${prefix}.` : "") + (r.address as string || "");
      const mode = r.mode === "data" ? "data" : "managed";
      const type = r.type as string || "";
      const name = r.name as string || "";
      const expressions = r.expressions as unknown;
      const references = collectReferences(expressions);

      // Also collect depends_on if present
      if (Array.isArray(r.depends_on)) {
        for (const dep of r.depends_on) {
          if (typeof dep === "string") references.push(dep);
        }
      }

      resources.push({
        address,
        mode: mode as "managed" | "data",
        type,
        name,
        references: [...new Set(references)],
      });
    }
  }

  // Recurse into module_calls
  if (mod.module_calls && typeof mod.module_calls === "object") {
    for (const [callName, call] of Object.entries(mod.module_calls as Record<string, unknown>)) {
      if (!call || typeof call !== "object") continue;
      const c = call as Record<string, unknown>;
      const childPrefix = prefix ? `${prefix}.module.${callName}` : `module.${callName}`;
      if (c.module) {
        resources.push(...collectConfigResources(c.module, childPrefix));
      }
    }
  }

  return resources;
}

/**
 * Recursively collect resources from a values module (handles child_modules).
 */
function collectValueResources(module: unknown): PlanValueResource[] {
  const resources: PlanValueResource[] = [];
  if (!module || typeof module !== "object") return resources;
  const mod = module as Record<string, unknown>;

  if (Array.isArray(mod.resources)) {
    for (const res of mod.resources) {
      if (!res || typeof res !== "object") continue;
      const r = res as Record<string, unknown>;
      resources.push({
        address: r.address as string || "",
        mode: (r.mode === "data" ? "data" : "managed") as "managed" | "data",
        type: r.type as string || "",
        name: r.name as string || "",
        values: (r.values as Record<string, unknown>) || {},
      });
    }
  }

  if (Array.isArray(mod.child_modules)) {
    for (const child of mod.child_modules) {
      resources.push(...collectValueResources(child));
    }
  }

  return resources;
}

/**
 * Parse the JSON output of `terraform show -json <plan-file>`.
 */
export function parsePlanJson(json: string): ParsedPlan {
  let rawPlan: unknown;
  try {
    rawPlan = JSON.parse(json);
  } catch (error: unknown) {
    throw new Error(`Failed to parse Terraform plan JSON: ${formatError(error)}`);
  }

  const plan = validatePlanJson(rawPlan);

  // Parse configuration.root_module for references
  const configResources = collectConfigResources(
    plan.configuration?.root_module,
  );

  // Parse planned_values.root_module for computed values
  const plannedResources = collectValueResources(
    plan.planned_values?.root_module,
  );

  // Parse resource_changes for change details
  const resourceChanges: PlanResourceChange[] = [];
  if (Array.isArray(plan.resource_changes)) {
    for (const rc of plan.resource_changes) {
      if (!rc || typeof rc !== "object") continue;
      resourceChanges.push({
        address: rc.address as string || "",
        mode: (rc.mode === "data" ? "data" : "managed") as "managed" | "data",
        type: rc.type as string || "",
        name: rc.name as string || "",
        index: rc.index as number | string | undefined,
        change: {
          actions: (rc.change?.actions as string[]) || [],
          before: (rc.change?.before as Record<string, unknown>) || null,
          after: (rc.change?.after as Record<string, unknown>) || null,
          after_unknown: (rc.change?.after_unknown as Record<string, unknown>) || {},
        },
      });
    }
  }

  // Parse variables
  const variables = (plan.variables as Record<string, { value: unknown }>) || {};

  return { configResources, plannedResources, resourceChanges, variables };
}

/**
 * Load and parse a plan JSON file from disk.
 */
export async function loadPlanFile(planFilePath: string): Promise<ParsedPlan> {
  const content = await readFile(planFilePath, "utf-8");
  return parsePlanJson(content);
}

/**
 * Build a complete dependency graph from a parsed plan.
 * This uses Terraform's own dependency analysis (via expression references)
 * which captures ALL dependencies including dynamic ones that static analysis misses.
 */
export function buildGraphFromPlan(parsedPlan: ParsedPlan, repo: string): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // Register all nodes from planned_values (which includes actual resource instances)
  for (const res of parsedPlan.plannedResources) {
    const type = res.mode === "data" ? "data" : "resource";
    const id = `${repo}:${type}.${res.type}.${res.name}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        type: type as "resource" | "data",
        resourceType: res.type,
        name: res.name,
        repo,
        filePath: "", // Not available from plan output
      });
    }
  }

  // Build edges from configuration references
  for (const configRes of parsedPlan.configResources) {
    const fromType = configRes.mode === "data" ? "data" : "resource";
    const fromId = `${repo}:${fromType}.${configRes.type}.${configRes.name}`;

    for (const ref of configRes.references) {
      // Parse the reference string: "aws_instance.example", "data.aws_ami.latest", "var.x", "module.foo"
      const refParts = ref.split(".");

      // Skip non-resource references (var, local, module, each, self, path, count)
      if (["var", "local", "module", "each", "self", "path", "count", "terraform"].includes(refParts[0])) {
        continue;
      }

      let toId: string;
      if (refParts[0] === "data" && refParts.length >= 3) {
        toId = `${repo}:data.${refParts[1]}.${refParts[2]}`;
      } else if (refParts.length >= 2) {
        toId = `${repo}:resource.${refParts[0]}.${refParts[1]}`;
      } else {
        continue;
      }

      if (nodes.has(toId) && toId !== fromId) {
        edges.push({
          from: fromId,
          to: toId,
          type: "reference",
          label: ref,
        });
      }
    }
  }

  // Deduplicate edges
  const seen = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { nodes, edges: uniqueEdges };
}

/**
 * Extract resource IDs from planned values (replaces need for state files).
 * Returns a map of "repo:resource_address" → resource ID/ARN.
 */
export function extractResourceIds(parsedPlan: ParsedPlan, repo: string): Map<string, string> {
  const idMap = new Map<string, string>();

  for (const res of parsedPlan.plannedResources) {
    if (res.mode !== "managed") continue;
    const address = `${repo}:${res.type}.${res.name}`;
    // Prefer ARN, fall back to id
    const arn = res.values.arn as string | undefined;
    const id = res.values.id as string | undefined;
    if (arn) {
      idMap.set(address, arn);
    } else if (id) {
      idMap.set(address, id);
    }
  }

  return idMap;
}

/**
 * Merge plan-based edges into an existing dependency graph.
 * Plan-based edges are authoritative — they override regex-based detection.
 */
export function enrichGraphWithPlan({
  graph,
  parsedPlan,
  repo,
}: {
  graph: DependencyGraph;
  parsedPlan: ParsedPlan;
  repo: string;
}): DependencyGraph {
  const planGraph = buildGraphFromPlan(parsedPlan, repo);

  // Add any nodes from plan that aren't in the existing graph
  for (const [id, node] of planGraph.nodes) {
    if (!graph.nodes.has(id)) {
      graph.nodes.set(id, node);
    }
  }

  // Add plan-based edges that don't exist in the current graph
  const existingEdgeKeys = new Set(
    graph.edges.map((e) => `${e.from}|${e.to}`),
  );

  const newEdges: GraphEdge[] = [];
  for (const edge of planGraph.edges) {
    const key = `${edge.from}|${edge.to}`;
    if (!existingEdgeKeys.has(key)) {
      newEdges.push(edge);
    }
  }

  if (newEdges.length > 0) {
    logger.log(`  Plan enrichment: +${newEdges.length} edges from terraform plan analysis`);
  }

  return {
    nodes: graph.nodes,
    edges: [...graph.edges, ...newEdges],
  };
}

/**
 * Load plan files from a directory (supports multiple repos).
 * Expects files named <repo>.plan.json (output of terraform show -json plan.bin).
 */
export async function loadPlanDir(dir: string): Promise<Map<string, ParsedPlan>> {
  const { readdir } = await import("node:fs/promises");
  const plans = new Map<string, ParsedPlan>();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error: unknown) {
    logger.warn(`⚠ Could not read plan directory ${dir}: ${formatError(error)}`);
    return plans;
  }

  for (const entry of entries) {
    if (entry.endsWith(".plan.json")) {
      const repo = entry.replace(".plan.json", "");
      try {
        const plan = await loadPlanFile(join(dir, entry));
        plans.set(repo, plan);
      } catch (error: unknown) {
        logger.warn(`⚠ Could not parse plan file ${entry}: ${formatError(error)}`);
      }
    }
  }

  return plans;
}
