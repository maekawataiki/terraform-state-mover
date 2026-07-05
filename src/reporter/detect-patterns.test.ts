import { describe, it, expect } from "vitest";
import type { DependencyGraph, GraphNode, GraphEdge, ArnReference, Namespace, ParsedFile, TerraformBlock } from "../types.js";
import {
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
  detectPatterns,
  type PatternContext,
} from "./detect-patterns.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: "resource",
    resourceType: "aws_instance",
    name: overrides.id.split(":").pop() || "unnamed",
    repo: "repo-a",
    filePath: "main.tf",
    ...overrides,
  };
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[] = []): DependencyGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return { nodes: nodeMap, edges };
}

function makeCtx(overrides: Partial<PatternContext> = {}): PatternContext {
  const graph = overrides.graph ?? makeGraph([]);
  return {
    graph,
    arnRefs: [],
    classifications: new Map(),
    cycles: [],
    thresholds: {
      terralithMinResources: 15,
      terralithMinResourcesWithDiversity: 8,
      terralithMinNamespaces: 3,
      terralithCriticalThreshold: 30,
      godModuleMinAssignments: 10,
    },
    repos: new Set([...graph.nodes.values()].map((n) => n.repo)),
    ...overrides,
  };
}

function makeBlock(overrides: Partial<TerraformBlock> = {}): TerraformBlock {
  return {
    type: "resource",
    resourceType: "aws_instance",
    name: "example",
    body: "{}",
    stringLiterals: [],
    arns: [],
    filePath: "main.tf",
    repo: "repo-a",
    ...overrides,
  };
}

function makeParsedFile(blocks: TerraformBlock[], repo = "repo-a"): ParsedFile {
  return { filePath: "main.tf", repo, blocks };
}

// ---------------------------------------------------------------------------
// detectGatekeeper
// ---------------------------------------------------------------------------

describe("detectGatekeeper", () => {
  it("returns empty if only 1 repo", () => {
    const nodes = [
      makeNode({ id: "r:role1", resourceType: "aws_iam_role", repo: "infra" }),
      makeNode({ id: "r:role2", resourceType: "aws_iam_role", repo: "infra" }),
    ];
    const classifications = new Map<string, Namespace>([
      ["r:role1", "service-api"],
      ["r:role2", "service-web"],
    ]);
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    expect(detectGatekeeper(ctx)).toEqual([]);
  });

  it("detects gatekeeper when service-namespaced IAM roles are in a central repo", () => {
    const nodes = [
      makeNode({ id: "r:role1", resourceType: "aws_iam_role", name: "api-role", repo: "infra-central" }),
      makeNode({ id: "r:role2", resourceType: "aws_iam_role", name: "web-role", repo: "infra-central" }),
      makeNode({ id: "r:svc", resourceType: "aws_lambda_function", name: "api", repo: "service-api" }),
    ];
    const classifications = new Map<string, Namespace>([
      ["r:role1", "service-api"],
      ["r:role2", "service-web"],
      ["r:svc", "service-api"],
    ]);
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    const result = detectGatekeeper(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Gatekeeper");
    expect(result[0].severity).toBe("critical");
    expect(result[0].description).toContain("infra-central");
  });

  it("ignores roles not in service-* namespace", () => {
    const nodes = [
      makeNode({ id: "r:role1", resourceType: "aws_iam_role", repo: "infra" }),
      makeNode({ id: "r:role2", resourceType: "aws_iam_role", repo: "infra" }),
      makeNode({ id: "r:other", resourceType: "aws_instance", repo: "service-x" }),
    ];
    const classifications = new Map<string, Namespace>([
      ["r:role1", "platform"],
      ["r:role2", "foundation"],
      ["r:other", "service-x"],
    ]);
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    expect(detectGatekeeper(ctx)).toEqual([]);
  });

  it("requires at least 2 roles for detection", () => {
    const nodes = [
      makeNode({ id: "r:role1", resourceType: "aws_iam_role", repo: "infra" }),
      makeNode({ id: "r:svc", resourceType: "aws_instance", repo: "service-api" }),
    ];
    const classifications = new Map<string, Namespace>([
      ["r:role1", "service-api"],
      ["r:svc", "service-api"],
    ]);
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    expect(detectGatekeeper(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSpaghetti
// ---------------------------------------------------------------------------

describe("detectSpaghetti", () => {
  it("returns empty when no cross-repo ARN refs", () => {
    const arnRefs: ArnReference[] = [{
      arn: "arn:aws:iam::123:role/my-role",
      service: "iam",
      filePath: "main.tf",
      repo: "repo-a",
      resolved: true,
      definingResource: makeNode({ id: "r:role", repo: "repo-a" }),
    }];
    const ctx = makeCtx({ arnRefs });
    expect(detectSpaghetti(ctx)).toEqual([]);
  });

  it("detects spaghetti with cross-repo ARNs", () => {
    const defNode = makeNode({ id: "r:role", repo: "infra-central" });
    const arnRefs: ArnReference[] = [
      { arn: "arn:aws:iam::123:role/api-role", service: "iam", filePath: "main.tf", repo: "service-api", resolved: true, definingResource: defNode },
      { arn: "arn:aws:iam::123:role/web-role", service: "iam", filePath: "main.tf", repo: "service-web", resolved: true, definingResource: defNode },
      { arn: "arn:aws:iam::123:role/analytics-role", service: "iam", filePath: "main.tf", repo: "service-analytics", resolved: true, definingResource: defNode },
    ];
    const ctx = makeCtx({ arnRefs });
    const result = detectSpaghetti(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Spaghetti State");
    expect(result[0].severity).toBe("critical");
  });

  it("warning severity for fewer than 3 cross-repo ARNs", () => {
    const defNode = makeNode({ id: "r:role", repo: "infra-central" });
    const arnRefs: ArnReference[] = [
      { arn: "arn:aws:iam::123:role/api-role", service: "iam", filePath: "main.tf", repo: "service-api", resolved: true, definingResource: defNode },
    ];
    const ctx = makeCtx({ arnRefs });
    const result = detectSpaghetti(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// detectRemoteStateCoupling
// ---------------------------------------------------------------------------

describe("detectRemoteStateCoupling", () => {
  it("returns empty when no remote_state edges", () => {
    const ctx = makeCtx({ graph: makeGraph([], [{ from: "a", to: "b", type: "reference" }]) });
    expect(detectRemoteStateCoupling(ctx)).toEqual([]);
  });

  it("detects remote state coupling", () => {
    const nodes = [
      makeNode({ id: "a", repo: "repo-a" }),
      makeNode({ id: "b", repo: "repo-b" }),
    ];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", type: "remote_state", label: "vpc_id" },
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    const result = detectRemoteStateCoupling(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Remote State Coupling");
    expect(result[0].severity).toBe("info");
  });

  it("warning severity for 3+ remote_state edges", () => {
    const nodes = [
      makeNode({ id: "a", repo: "repo-a" }),
      makeNode({ id: "b", repo: "repo-b" }),
      makeNode({ id: "c", repo: "repo-c" }),
      makeNode({ id: "d", repo: "repo-d" }),
    ];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", type: "remote_state", label: "vpc_id" },
      { from: "a", to: "c", type: "remote_state", label: "subnet_id" },
      { from: "b", to: "d", type: "remote_state", label: "sg_id" },
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    const result = detectRemoteStateCoupling(ctx);
    expect(result[0].severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// detectTerralith
// ---------------------------------------------------------------------------

describe("detectTerralith", () => {
  it("returns empty when resource count is below threshold", () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const classifications = new Map<string, Namespace>(
      nodes.map((n) => [n.id, "service-api"]),
    );
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    expect(detectTerralith(ctx)).toEqual([]);
  });

  it("detects terralith when resources >= terralithMinResources", () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const classifications = new Map<string, Namespace>(
      nodes.map((n) => [n.id, "service-api"]),
    );
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    const result = detectTerralith(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Terralith");
    expect(result[0].severity).toBe("warning");
  });

  it("critical severity when resources >= terralithCriticalThreshold", () => {
    const nodes = Array.from({ length: 30 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const classifications = new Map<string, Namespace>(
      nodes.map((n) => [n.id, "service-api"]),
    );
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    const result = detectTerralith(ctx);
    expect(result[0].severity).toBe("critical");
  });

  it("detects terralith with diversity (8+ resources, 3+ namespaces)", () => {
    const nodes = Array.from({ length: 9 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const namespaces: Namespace[] = ["service-api", "service-web", "platform"];
    const classifications = new Map<string, Namespace>(
      nodes.map((n, i) => [n.id, namespaces[i % 3]]),
    );
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    const result = detectTerralith(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Terralith");
  });

  it("no detection when resources < diversity threshold and < 3 namespaces", () => {
    const nodes = Array.from({ length: 9 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const classifications = new Map<string, Namespace>(
      nodes.map((n) => [n.id, "service-api"]),
    );
    const ctx = makeCtx({ graph: makeGraph(nodes), classifications });
    expect(detectTerralith(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe("detectCycles", () => {
  it("returns empty when no cycles", () => {
    const ctx = makeCtx({ cycles: [] });
    expect(detectCycles(ctx)).toEqual([]);
  });

  it("detects cycles", () => {
    const cycles = [["repo-a:res1", "repo-b:res2", "repo-a:res1"]];
    const ctx = makeCtx({ cycles });
    const result = detectCycles(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Circular Dependency");
    expect(result[0].severity).toBe("critical");
  });

  it("limits evidence to 3 cycles", () => {
    const cycles = Array.from({ length: 5 }, (_, i) => [`a:r${i}`, `b:r${i}`]);
    const ctx = makeCtx({ cycles });
    const result = detectCycles(ctx);
    expect(result[0].evidence).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// detectGodModule
// ---------------------------------------------------------------------------

describe("detectGodModule", () => {
  it("returns empty when no parsedFiles", () => {
    const ctx = makeCtx({ parsedFiles: undefined });
    expect(detectGodModule(ctx)).toEqual([]);
  });

  it("returns empty when module has fewer assignments than threshold", () => {
    const block = makeBlock({
      type: "module",
      name: "small",
      rawBody: "source = \"./mod\"\nvar1 = val1\nvar2 = val2",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    expect(detectGodModule(ctx)).toEqual([]);
  });

  it("detects god module with many assignments (rawBody)", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `var${i} = value${i}`);
    const block = makeBlock({
      type: "module",
      name: "mega_module",
      rawBody: lines.join("\n"),
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    const result = detectGodModule(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("God Module");
    expect(result[0].description).toContain("mega_module");
    expect(result[0].description).toContain("12");
  });

  it("detects god module with JSON body", () => {
    const obj: Record<string, string> = { source: "./mod" };
    for (let i = 0; i < 11; i++) obj[`var${i}`] = `val${i}`;
    const block = makeBlock({
      type: "module",
      name: "json_module",
      body: JSON.stringify([obj]),
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    const result = detectGodModule(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("God Module");
  });

  it("ignores resource blocks", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `var${i} = value${i}`);
    const block = makeBlock({
      type: "resource",
      name: "big_resource",
      rawBody: lines.join("\n"),
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    expect(detectGodModule(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectEnvironmentCopypasta
// ---------------------------------------------------------------------------

describe("detectEnvironmentCopypasta", () => {
  it("returns empty when no env-prefixed resources", () => {
    const nodes = [
      makeNode({ id: "r:vpc", name: "main_vpc", repo: "repo-a" }),
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes) });
    expect(detectEnvironmentCopypasta(ctx)).toEqual([]);
  });

  it("detects copypasta with env prefix/suffix across dirs", () => {
    const nodes = [
      makeNode({ id: "r:dev_app", name: "dev_app", repo: "dev" }),
      makeNode({ id: "r:prod_app", name: "prod_app", repo: "prod" }),
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes) });
    const result = detectEnvironmentCopypasta(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Environment Copypasta");
    expect(result[0].description).toContain("app");
  });

  it("detects copypasta with 3+ same-dir variants", () => {
    const nodes = [
      makeNode({ id: "r:dev_db", name: "dev_db", repo: "repo-a" }),
      makeNode({ id: "r:stg_db", name: "stg_db", repo: "repo-a" }),
      makeNode({ id: "r:prod_db", name: "prod_db", repo: "repo-a" }),
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes) });
    const result = detectEnvironmentCopypasta(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toHaveLength(3);
  });

  it("no detection for non-env prefixes", () => {
    const nodes = [
      makeNode({ id: "r:main_app", name: "main_app", repo: "repo-a" }),
      makeNode({ id: "r:backup_app", name: "backup_app", repo: "repo-b" }),
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes) });
    expect(detectEnvironmentCopypasta(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectOrphanedResources
// ---------------------------------------------------------------------------

describe("detectOrphanedResources", () => {
  it("returns empty when all nodes have edges", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const edges: GraphEdge[] = [{ from: "a", to: "b", type: "reference" }];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    expect(detectOrphanedResources(ctx)).toEqual([]);
  });

  it("detects orphaned resources", () => {
    const nodes = [
      makeNode({ id: "a" }),
      makeNode({ id: "b" }),
      makeNode({ id: "orphan", name: "lonely" }),
    ];
    const edges: GraphEdge[] = [{ from: "a", to: "b", type: "reference" }];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    const result = detectOrphanedResources(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Orphaned Resources");
    expect(result[0].severity).toBe("info");
  });

  it("returns empty when graph has no edges at all", () => {
    const nodes = [makeNode({ id: "a" })];
    const ctx = makeCtx({ graph: makeGraph(nodes, []) });
    const result = detectOrphanedResources(ctx);
    // All nodes are orphans since no edges
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectCountOnCollection
// ---------------------------------------------------------------------------

describe("detectCountOnCollection", () => {
  it("returns empty when no parsedFiles", () => {
    const ctx = makeCtx({ parsedFiles: undefined });
    expect(detectCountOnCollection(ctx)).toEqual([]);
  });

  it("detects count = length(...) in resource", () => {
    const block = makeBlock({
      type: "resource",
      resourceType: "aws_iam_user",
      name: "team",
      rawBody: "count = length(var.team_members)\nname  = var.team_members[count.index]",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    const result = detectCountOnCollection(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Count on Dynamic Collection");
    expect(result[0].severity).toBe("warning");
  });

  it("ignores resources without count = length", () => {
    const block = makeBlock({
      type: "resource",
      rawBody: "count = 3\nami = var.ami_id",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    expect(detectCountOnCollection(ctx)).toEqual([]);
  });

  it("ignores module blocks with count = length", () => {
    const block = makeBlock({
      type: "module",
      name: "services",
      rawBody: "count = length(var.services)\nsource = \"./mod\"",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    expect(detectCountOnCollection(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectDependsOnModule
// ---------------------------------------------------------------------------

describe("detectDependsOnModule", () => {
  it("returns empty when no parsedFiles", () => {
    const ctx = makeCtx({ parsedFiles: undefined });
    expect(detectDependsOnModule(ctx)).toEqual([]);
  });

  it("detects depends_on in module block (rawBody)", () => {
    const block = makeBlock({
      type: "module",
      name: "app",
      rawBody: "source = \"./app\"\ndepends_on = [module.db]",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    const result = detectDependsOnModule(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Depends On Module");
    expect(result[0].description).toContain("app");
  });

  it("detects depends_on in JSON body", () => {
    const block = makeBlock({
      type: "module",
      name: "svc",
      body: "{\"depends_on\": [\"module.db\"]}",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    const result = detectDependsOnModule(ctx);
    expect(result).toHaveLength(1);
  });

  it("ignores resource blocks with depends_on", () => {
    const block = makeBlock({
      type: "resource",
      name: "app",
      rawBody: "depends_on = [aws_db_instance.main]",
    });
    const ctx = makeCtx({ parsedFiles: [makeParsedFile([block])] });
    expect(detectDependsOnModule(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectProviderCoupling
// ---------------------------------------------------------------------------

describe("detectProviderCoupling", () => {
  it("returns empty when no parsedFiles", () => {
    const ctx = makeCtx({ parsedFiles: undefined });
    expect(detectProviderCoupling(ctx)).toEqual([]);
  });

  it("detects multiple provider aliases in one repo", () => {
    const blocks = [
      makeBlock({ rawBody: "provider = aws.us_east_1\nami = \"ami-123\"" }),
      makeBlock({ rawBody: "provider = aws.eu_west_1\nami = \"ami-456\"", name: "instance2" }),
    ];
    const ctx = makeCtx({ parsedFiles: [makeParsedFile(blocks)] });
    const result = detectProviderCoupling(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Implicit Provider Coupling");
    expect(result[0].description).toContain("2 provider aliases");
  });

  it("returns empty when only one provider alias per repo", () => {
    const blocks = [
      makeBlock({ rawBody: "provider = aws.us_east_1\nami = \"ami-123\"" }),
    ];
    const ctx = makeCtx({ parsedFiles: [makeParsedFile(blocks)] });
    expect(detectProviderCoupling(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectCircularRemoteState
// ---------------------------------------------------------------------------

describe("detectCircularRemoteState", () => {
  it("returns empty when no remote_state edges", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const edges: GraphEdge[] = [{ from: "a", to: "b", type: "reference" }];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    expect(detectCircularRemoteState(ctx)).toEqual([]);
  });

  it("returns empty when remote_state edges are acyclic", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" }), makeNode({ id: "c" })];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", type: "remote_state" },
      { from: "b", to: "c", type: "remote_state" },
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    expect(detectCircularRemoteState(ctx)).toEqual([]);
  });

  it("detects circular remote_state (A→B→A)", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", type: "remote_state" },
      { from: "b", to: "a", type: "remote_state" },
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    const result = detectCircularRemoteState(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Circular Remote State");
    expect(result[0].severity).toBe("critical");
  });

  it("detects longer cycles (A→B→C→A)", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" }), makeNode({ id: "c" })];
    const edges: GraphEdge[] = [
      { from: "a", to: "b", type: "remote_state" },
      { from: "b", to: "c", type: "remote_state" },
      { from: "c", to: "a", type: "remote_state" },
    ];
    const ctx = makeCtx({ graph: makeGraph(nodes, edges) });
    const result = detectCircularRemoteState(ctx);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectPatterns (orchestrator + suppression)
// ---------------------------------------------------------------------------

describe("detectPatterns", () => {
  it("runs all detectors and returns sorted results", () => {
    const nodes = [
      makeNode({ id: "r:role1", resourceType: "aws_iam_role", name: "api-role", repo: "infra" }),
      makeNode({ id: "r:role2", resourceType: "aws_iam_role", name: "web-role", repo: "infra" }),
      makeNode({ id: "r:svc", resourceType: "aws_lambda_function", repo: "service-api" }),
    ];
    const classifications = new Map<string, Namespace>([
      ["r:role1", "service-api"],
      ["r:role2", "service-web"],
      ["r:svc", "service-api"],
    ]);
    const graph = makeGraph(nodes);

    const result = detectPatterns(graph, [], classifications, []);
    expect(result.length).toBeGreaterThan(0);
    // Should be sorted by severity: critical first
    const severities = result.map((p) => p.severity);
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(severityOrder[severities[i]]).toBeGreaterThanOrEqual(severityOrder[severities[i - 1]]);
    }
  });

  it("suppresses Terralith when Gatekeeper is detected", () => {
    // Many service-* IAM roles in one repo triggers both Gatekeeper and Terralith
    const nodes = [
      ...Array.from({ length: 16 }, (_, i) =>
        makeNode({ id: `r:role${i}`, resourceType: "aws_iam_role", name: `role${i}`, repo: "infra" }),
      ),
      makeNode({ id: "r:svc", resourceType: "aws_instance", repo: "service-x" }),
    ];
    const classifications = new Map<string, Namespace>(
      nodes.map((n, i) => [n.id, i < 16 ? `service-svc${i}` as Namespace : "service-x"]),
    );
    const graph = makeGraph(nodes);

    const result = detectPatterns(graph, [], classifications, []);
    const names = result.map((p) => p.name);
    expect(names).toContain("Gatekeeper");
    expect(names).not.toContain("Terralith");
  });

  it("suppresses Orphaned Resources when > 40% of nodes are orphans", () => {
    // 5 nodes, 0 edges → all 5 are orphans → 100% > 40% → suppressed
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const graph = makeGraph(nodes, []);
    const classifications = new Map<string, Namespace>();

    const result = detectPatterns(graph, [], classifications, []);
    const names = result.map((p) => p.name);
    expect(names).not.toContain("Orphaned Resources");
  });

  it("keeps Orphaned Resources when <= 40% of nodes are orphans", () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    // Connect 7 nodes, leave 3 orphaned (30%)
    const edges: GraphEdge[] = [
      { from: "r:0", to: "r:1", type: "reference" },
      { from: "r:1", to: "r:2", type: "reference" },
      { from: "r:2", to: "r:3", type: "reference" },
      { from: "r:3", to: "r:4", type: "reference" },
      { from: "r:4", to: "r:5", type: "reference" },
      { from: "r:5", to: "r:6", type: "reference" },
    ];
    const graph = makeGraph(nodes, edges);
    const classifications = new Map<string, Namespace>();

    const result = detectPatterns(graph, [], classifications, []);
    const names = result.map((p) => p.name);
    expect(names).toContain("Orphaned Resources");
  });

  it("suppresses Environment Copypasta when Provider Coupling detected", () => {
    // Set up: multiple provider aliases + env-prefixed resources
    const nodes = [
      makeNode({ id: "r:dev_app", name: "dev_app", repo: "repo-a" }),
      makeNode({ id: "r:prod_app", name: "prod_app", repo: "repo-b" }),
    ];
    const graph = makeGraph(nodes);
    const blocks = [
      makeBlock({ rawBody: "provider = aws.us_east\nami = \"x\"", repo: "repo-a" }),
      makeBlock({ rawBody: "provider = aws.eu_west\nami = \"y\"", name: "i2", repo: "repo-a" }),
    ];
    const parsedFiles = [makeParsedFile(blocks, "repo-a")];
    const classifications = new Map<string, Namespace>();

    const result = detectPatterns(graph, [], classifications, [], parsedFiles);
    const names = result.map((p) => p.name);
    expect(names).toContain("Implicit Provider Coupling");
    expect(names).not.toContain("Environment Copypasta");
  });

  it("accepts custom thresholds", () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `r:${i}`, repo: "repo-a" }),
    );
    const classifications = new Map<string, Namespace>(
      nodes.map((n) => [n.id, "service-api"]),
    );
    const graph = makeGraph(nodes);

    // Default threshold (15) → no detection
    const result1 = detectPatterns(graph, [], classifications, []);
    expect(result1.map((p) => p.name)).not.toContain("Terralith");

    // Lower threshold → detection
    const result2 = detectPatterns(graph, [], classifications, [], undefined, { terralithMinResources: 4 });
    expect(result2.map((p) => p.name)).toContain("Terralith");
  });

  it("accepts custom detectors array", () => {
    const graph = makeGraph([makeNode({ id: "r:x", repo: "repo-a" })]);
    const customDetector = () => [{ name: "Custom", severity: "info" as const, description: "test", evidence: [] }];

    const result = detectPatterns(graph, [], new Map(), [], undefined, undefined, [customDetector]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Custom");
  });
});
