import { describe, it, expect } from "vitest";
import { classifyResource, classifyGraph } from "./namespace-classifier.js";
import type { GraphNode, NamespaceConfig } from "../types.js";

function makeNode(opts: { resourceType: string; name: string; repo?: string }): GraphNode {
  const repo = opts.repo ?? "my-repo";
  return {
    id: `${repo}:resource.${opts.resourceType}.${opts.name}`,
    type: "resource",
    resourceType: opts.resourceType,
    name: opts.name,
    repo,
    filePath: "main.tf",
  };
}

describe("namespace-classifier repo-based grouping", () => {
  describe("groupByRepo default (true)", () => {
    it("groups service resources by repo name", () => {
      const lambda = makeNode({ resourceType: "aws_lambda_function", name: "handler", repo: "service-orders" });
      const db = makeNode({ resourceType: "aws_db_instance", name: "orders_db", repo: "service-orders" });
      expect(classifyResource(lambda)).toBe("service-orders");
      expect(classifyResource(db)).toBe("service-orders");
    });

    it("strips service- prefix from repo name", () => {
      const node = makeNode({ resourceType: "aws_lambda_function", name: "proc", repo: "service-payments" });
      expect(classifyResource(node)).toBe("service-payments");
    });

    it("strips svc- prefix from repo name", () => {
      const node = makeNode({ resourceType: "aws_sqs_queue", name: "events", repo: "svc-notifications" });
      expect(classifyResource(node)).toBe("service-notifications");
    });

    it("strips app- prefix from repo name", () => {
      const node = makeNode({ resourceType: "aws_s3_bucket", name: "data", repo: "app-frontend" });
      expect(classifyResource(node)).toBe("service-frontend");
    });

    it("infers foundation from repo name", () => {
      const node = makeNode({ resourceType: "aws_iam_role", name: "admin", repo: "infra-foundation" });
      expect(classifyResource(node)).toBe("foundation");
    });

    it("infers platform from repo name", () => {
      const node = makeNode({ resourceType: "aws_iam_role", name: "deployer", repo: "infra-platform" });
      expect(classifyResource(node)).toBe("platform");
    });

    it("still classifies VPC as platform regardless of repo", () => {
      const node = makeNode({ resourceType: "aws_vpc", name: "main", repo: "service-api" });
      expect(classifyResource(node)).toBe("platform");
    });

    it("still classifies organizations resources as foundation", () => {
      const node = makeNode({ resourceType: "aws_organizations_policy", name: "scp", repo: "random-repo" });
      expect(classifyResource(node)).toBe("foundation");
    });

    it("groups unknown-prefix repo resources under service-{repo}", () => {
      const node = makeNode({ resourceType: "aws_lambda_function", name: "handler", repo: "my-project" });
      expect(classifyResource(node)).toBe("service-my-project");
    });
  });

  describe("groupByRepo: false (legacy)", () => {
    const config: NamespaceConfig = { groupByRepo: false };

    it("classifies by resource name (old behavior)", () => {
      const lambda = makeNode({ resourceType: "aws_lambda_function", name: "handler", repo: "service-orders" });
      const db = makeNode({ resourceType: "aws_db_instance", name: "orders_db", repo: "service-orders" });
      expect(classifyResource(lambda, config)).toBe("service-handler");
      expect(classifyResource(db, config)).toBe("service-orders_db");
    });
  });

  describe("classifyGraph with multiple repos", () => {
    it("produces reasonable namespace count from multi-repo setup", () => {
      const nodes = new Map<string, GraphNode>();
      // 4 repos, expect ~4-5 namespaces (not 10+)
      const resources = [
        makeNode({ resourceType: "aws_organizations_policy", name: "scp", repo: "infra-central" }),
        makeNode({ resourceType: "aws_iam_policy", name: "boundary", repo: "infra-central" }),
        makeNode({ resourceType: "aws_vpc", name: "main", repo: "infra-platform" }),
        makeNode({ resourceType: "aws_eks_cluster", name: "prod", repo: "infra-platform" }),
        makeNode({ resourceType: "aws_lambda_function", name: "api", repo: "service-api" }),
        makeNode({ resourceType: "aws_db_instance", name: "db", repo: "service-api" }),
        makeNode({ resourceType: "aws_s3_bucket", name: "data", repo: "service-analytics" }),
        makeNode({ resourceType: "aws_lambda_function", name: "ingest", repo: "service-analytics" }),
      ];
      for (const r of resources) nodes.set(r.id, r);

      const classifications = classifyGraph(nodes);
      const uniqueNamespaces = new Set(classifications.values());

      // Should be: foundation, platform, service-api, service-analytics = 4
      expect(uniqueNamespaces.size).toBe(4);
      expect(uniqueNamespaces).toContain("foundation");
      expect(uniqueNamespaces).toContain("platform");
      expect(uniqueNamespaces).toContain("service-api");
      expect(uniqueNamespaces).toContain("service-analytics");
    });
  });
});

describe("namespace-classifier legacy (resource-name based)", () => {
  function makeNodeLegacy(resourceType: string, name: string): GraphNode {
    return { id: `repo:resource.${resourceType}.${name}`, type: "resource", resourceType, name, repo: "repo1", filePath: "main.tf" };
  }

  describe("classifyResource", () => {
    it("classifies organizations resources as foundation", () => {
      expect(classifyResource(makeNodeLegacy("aws_organizations_account", "prod"))).toBe("foundation");
      expect(classifyResource(makeNodeLegacy("aws_organizations_policy", "scp"))).toBe("foundation");
    });

    it("classifies IAM boundary policies as foundation", () => {
      expect(classifyResource(makeNodeLegacy("aws_iam_policy", "permission_boundary"))).toBe("foundation");
      expect(classifyResource(makeNodeLegacy("aws_iam_policy", "scp_deny"))).toBe("foundation");
    });

    it("classifies VPC/EKS as platform", () => {
      expect(classifyResource(makeNodeLegacy("aws_vpc", "main"))).toBe("platform");
      expect(classifyResource(makeNodeLegacy("aws_eks_cluster", "prod"))).toBe("platform");
      expect(classifyResource(makeNodeLegacy("aws_subnet", "public"))).toBe("platform");
    });

    it("classifies lambda/rds as service", () => {
      const ns = classifyResource(makeNodeLegacy("aws_lambda_function", "api_handler"));
      expect(ns).toMatch(/^service-/);
    });

    it("classifies db_instance as service", () => {
      const ns = classifyResource(makeNodeLegacy("aws_db_instance", "orders_db"));
      expect(ns).toMatch(/^service-/);
    });

    it("classifies IAM roles by name convention", () => {
      expect(classifyResource(makeNodeLegacy("aws_iam_role", "platform_admin"))).toBe("platform");
      const serviceRole = classifyResource(makeNodeLegacy("aws_iam_role", "api_lambda_role"));
      expect(serviceRole).toMatch(/^service-/);
    });

    it("applies custom overrides", () => {
      const config: NamespaceConfig = {
        overrides: [{ resourceType: "aws_vpc", namespace: "foundation" }],
      };
      expect(classifyResource(makeNodeLegacy("aws_vpc", "main"), config)).toBe("foundation");
    });

    it("overrides by resource name", () => {
      const config: NamespaceConfig = {
        overrides: [{ resourceName: "special", namespace: "platform" }],
      };
      expect(classifyResource(makeNodeLegacy("aws_lambda_function", "special"), config)).toBe("platform");
    });

    it("overrides by both type and name", () => {
      const config: NamespaceConfig = {
        overrides: [{ resourceType: "aws_s3_bucket", resourceName: "shared_logs", namespace: "platform" }],
      };
      expect(classifyResource(makeNodeLegacy("aws_s3_bucket", "shared_logs"), config)).toBe("platform");
      // Different name should not match
      const ns = classifyResource(makeNodeLegacy("aws_s3_bucket", "app_data"), config);
      expect(ns).toMatch(/^service-/);
    });
  });

  describe("classifyGraph", () => {
    it("classifies all nodes in a graph", () => {
      const nodes = new Map<string, GraphNode>();
      const vpc = makeNodeLegacy("aws_vpc", "main");
      const lambda = makeNodeLegacy("aws_lambda_function", "handler");
      nodes.set(vpc.id, vpc);
      nodes.set(lambda.id, lambda);

      const classifications = classifyGraph(nodes);
      expect(classifications.get(vpc.id)).toBe("platform");
      expect(classifications.get(lambda.id)).toMatch(/^service-/);
    });
  });
});
