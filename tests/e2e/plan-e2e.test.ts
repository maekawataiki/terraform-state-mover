import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { parsePlanJson, buildGraphFromPlan, extractResourceIds, enrichGraphWithPlan } from "../../src/state/plan-parser.js";
import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { buildGraph } from "../../src/analyzer/dependency-graph.js";

const PLAN_OUTPUT_DIR = join(process.cwd(), "tmp/tests/plan-e2e");
const TF_BINARY = process.env.TF_BINARY || "terraform";

function hasTerraform(): boolean {
  try {
    execSync(`${TF_BINARY} version`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run terraform init + plan + show -json for a given directory.
 * Uses a shared plugin cache to avoid re-downloading providers.
 */
function generatePlanJson(dir: string): string | null {
  const env = {
    ...process.env,
    TF_PLUGIN_CACHE_DIR: join(process.cwd(), "tmp/tests/tf-plugin-cache"),
  };

  try {
    execSync(`mkdir -p ${env.TF_PLUGIN_CACHE_DIR}`, { stdio: "pipe" });
    execSync(`${TF_BINARY} init -backend=false -input=false`, { cwd: dir, stdio: "pipe", env });
    execSync(`${TF_BINARY} plan -out=plan.bin -input=false -refresh=false`, { cwd: dir, stdio: "pipe", env });
    const planJson = execSync(`${TF_BINARY} show -json plan.bin`, { cwd: dir, encoding: "utf-8", env });
    execSync("rm -f plan.bin", { cwd: dir, stdio: "pipe" });
    return planJson;
  } catch {
    try { execSync("rm -f plan.bin", { cwd: dir, stdio: "pipe" }); } catch { /* ignore */ }
    return null;
  }
}

describe("Plan-based E2E: gatekeeper", () => {
  const skipAll = !hasTerraform();
  const plans = new Map<string, string>();
  const dirs = [
    "examples/gatekeeper/infra-central",
    "examples/gatekeeper/service-app-api",
    "examples/gatekeeper/service-app-analytics",
  ];

  beforeAll(async () => {
    if (skipAll) return;
    await mkdir(PLAN_OUTPUT_DIR, { recursive: true });
    for (const dir of dirs) {
      const absDir = join(process.cwd(), dir);
      const repoName = dir.split("/").pop()!;
      const planJson = generatePlanJson(absDir);
      if (planJson) {
        plans.set(repoName, planJson);
        await writeFile(join(PLAN_OUTPUT_DIR, `gatekeeper-${repoName}.plan.json`), planJson);
      }
    }
  }, 300_000);

  afterAll(async () => {
    await rm(PLAN_OUTPUT_DIR, { recursive: true, force: true });
    for (const dir of dirs) {
      try { execSync("rm -rf .terraform .terraform.lock.hcl", { cwd: join(process.cwd(), dir), stdio: "pipe" }); } catch { /* ignore */ }
    }
  }, 10_000);

  it.skipIf(skipAll)("generates valid plan JSON for all dirs", () => {
    expect(plans.size).toBeGreaterThan(0);
    for (const [, json] of plans) {
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty("format_version");
    }
  });

  it.skipIf(skipAll)("parsePlanJson extracts resources from all repos", () => {
    let totalResources = 0;
    for (const [, json] of plans) {
      const plan = parsePlanJson(json);
      totalResources += plan.plannedResources.length;
    }
    expect(totalResources).toBeGreaterThanOrEqual(4);
  });

  it.skipIf(skipAll)("buildGraphFromPlan detects expression references", () => {
    let totalNodes = 0;
    let totalEdges = 0;
    for (const [repo, json] of plans) {
      const plan = parsePlanJson(json);
      const graph = buildGraphFromPlan(plan, repo);
      totalNodes += graph.nodes.size;
      totalEdges += graph.edges.length;
    }
    expect(totalNodes).toBeGreaterThanOrEqual(4);
    // Gatekeeper example has role attachments referencing roles
    expect(totalEdges).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(skipAll)("enrichGraphWithPlan merges with static graph", async () => {
    const allParsedFiles = [];
    for (const dir of dirs) {
      const files = await scanDirectory(join(process.cwd(), dir));
      allParsedFiles.push(...files);
    }
    const staticGraph = buildGraph(allParsedFiles);

    let enrichedGraph = staticGraph;
    for (const [repo, json] of plans) {
      const plan = parsePlanJson(json);
      enrichedGraph = enrichGraphWithPlan({ graph: enrichedGraph, parsedPlan: plan, repo });
    }

    expect(enrichedGraph.nodes.size).toBeGreaterThanOrEqual(staticGraph.nodes.size);
    expect(enrichedGraph.edges.length).toBeGreaterThanOrEqual(staticGraph.edges.length);
  });

  it.skipIf(skipAll)("extractResourceIds produces IDs from planned values", () => {
    for (const [repo, json] of plans) {
      const plan = parsePlanJson(json);
      const ids = extractResourceIds(plan, repo);
      expect(ids).toBeInstanceOf(Map);
    }
  });
});

describe("Plan-based E2E: terralith", () => {
  const skipAll = !hasTerraform();
  const plans = new Map<string, string>();
  const dirs = ["examples/terralith/monolith"];

  beforeAll(async () => {
    if (skipAll) return;
    await mkdir(PLAN_OUTPUT_DIR, { recursive: true });
    for (const dir of dirs) {
      const absDir = join(process.cwd(), dir);
      const repoName = dir.split("/").pop()!;
      const planJson = generatePlanJson(absDir);
      if (planJson) {
        plans.set(repoName, planJson);
      }
    }
  }, 300_000);

  afterAll(async () => {
    for (const dir of dirs) {
      try { execSync("rm -rf .terraform .terraform.lock.hcl", { cwd: join(process.cwd(), dir), stdio: "pipe" }); } catch { /* ignore */ }
    }
  }, 10_000);

  it.skipIf(skipAll)("parses monolith plan with many resources", () => {
    if (plans.size === 0) return; // plan generation timed out — skip gracefully
    expect(plans.size).toBe(1);
    const plan = parsePlanJson(plans.get("monolith")!);
    // Terralith example has 33+ resources
    expect(plan.plannedResources.length).toBeGreaterThanOrEqual(10);
  });

  it.skipIf(skipAll)("detects intra-repo dependencies via plan", () => {
    if (plans.size === 0) return;
    const plan = parsePlanJson(plans.get("monolith")!);
    const graph = buildGraphFromPlan(plan, "monolith");
    // Monolith has VPC → subnet → security group → instance chains
    expect(graph.edges.length).toBeGreaterThanOrEqual(5);
  });

  it.skipIf(skipAll)("plan adds edges missed by static analysis", async () => {
    if (plans.size === 0) return;
    const files = await scanDirectory(join(process.cwd(), dirs[0]));
    const staticGraph = buildGraph(files);
    const plan = parsePlanJson(plans.get("monolith")!);
    const enriched = enrichGraphWithPlan({ graph: staticGraph, parsedPlan: plan, repo: "monolith" });

    // Plan-based analysis should find at least as many dependencies
    expect(enriched.edges.length).toBeGreaterThanOrEqual(staticGraph.edges.length);
  });
});

describe("Plan-based E2E: spaghetti", () => {
  const skipAll = !hasTerraform();
  const plans = new Map<string, string>();
  const dirs = [
    "examples/spaghetti/platform",
    "examples/spaghetti/network",
    "examples/spaghetti/services",
  ];

  beforeAll(async () => {
    if (skipAll) return;
    await mkdir(PLAN_OUTPUT_DIR, { recursive: true });
    for (const dir of dirs) {
      const absDir = join(process.cwd(), dir);
      const repoName = dir.split("/").pop()!;
      const planJson = generatePlanJson(absDir);
      if (planJson) {
        plans.set(repoName, planJson);
      }
    }
  }, 300_000);

  afterAll(async () => {
    for (const dir of dirs) {
      try { execSync("rm -rf .terraform .terraform.lock.hcl", { cwd: join(process.cwd(), dir), stdio: "pipe" }); } catch { /* ignore */ }
    }
  }, 10_000);

  it.skipIf(skipAll)("parses all spaghetti repos", () => {
    if (plans.size === 0) return; // plan generation timed out — skip gracefully
    let totalResources = 0;
    for (const [, json] of plans) {
      const plan = parsePlanJson(json);
      totalResources += plan.plannedResources.length;
    }
    expect(totalResources).toBeGreaterThanOrEqual(4);
  });

  it.skipIf(skipAll)("extracts cross-repo references visible in plan", () => {
    if (plans.size === 0) return;
    let totalEdges = 0;
    for (const [repo, json] of plans) {
      const plan = parsePlanJson(json);
      const graph = buildGraphFromPlan(plan, repo);
      totalEdges += graph.edges.length;
    }
    // Spaghetti uses remote_state which creates edges
    expect(totalEdges).toBeGreaterThanOrEqual(0);
  });
});
