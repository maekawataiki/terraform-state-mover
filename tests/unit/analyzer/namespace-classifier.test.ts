import { describe, it, expect } from "vitest";
import { classifyResource, classifyGraph } from "../../../src/analyzer/namespace-classifier.js";
import type { GraphNode, NamespaceConfig } from "../../../src/types.js";

function makeNode(resourceType: string, name: string): GraphNode {
  return { id: `repo:resource.${resourceType}.${name}`, type: "resource", resourceType, name, repo: "repo1", filePath: "main.tf" };
}

describe("namespace-classifier", () => {
  describe("classifyResource", () => {
    it("classifies organizations resources as foundation", () => {
      expect(classifyResource(makeNode("aws_organizations_account", "prod"))).toBe("foundation");
      expect(classifyResource(makeNode("aws_organizations_policy", "scp"))).toBe("foundation");
    });

    it("classifies IAM boundary policies as foundation", () => {
      expect(classifyResource(makeNode("aws_iam_policy", "permission_boundary"))).toBe("foundation");
      expect(classifyResource(makeNode("aws_iam_policy", "scp_deny"))).toBe("foundation");
    });

    it("classifies VPC/EKS as platform", () => {
      expect(classifyResource(makeNode("aws_vpc", "main"))).toBe("platform");
      expect(classifyResource(makeNode("aws_eks_cluster", "prod"))).toBe("platform");
      expect(classifyResource(makeNode("aws_subnet", "public"))).toBe("platform");
    });

    it("classifies lambda/rds as service", () => {
      const ns = classifyResource(makeNode("aws_lambda_function", "api_handler"));
      expect(ns).toMatch(/^service-/);
    });

    it("classifies db_instance as service", () => {
      const ns = classifyResource(makeNode("aws_db_instance", "orders_db"));
      expect(ns).toMatch(/^service-/);
    });

    it("classifies IAM roles by name convention", () => {
      expect(classifyResource(makeNode("aws_iam_role", "platform_admin"))).toBe("platform");
      const serviceRole = classifyResource(makeNode("aws_iam_role", "api_lambda_role"));
      expect(serviceRole).toMatch(/^service-/);
    });

    it("applies custom overrides", () => {
      const config: NamespaceConfig = {
        overrides: [{ resourceType: "aws_vpc", namespace: "foundation" }],
      };
      expect(classifyResource(makeNode("aws_vpc", "main"), config)).toBe("foundation");
    });

    it("overrides by resource name", () => {
      const config: NamespaceConfig = {
        overrides: [{ resourceName: "special", namespace: "platform" }],
      };
      expect(classifyResource(makeNode("aws_lambda_function", "special"), config)).toBe("platform");
    });

    it("overrides by both type and name", () => {
      const config: NamespaceConfig = {
        overrides: [{ resourceType: "aws_s3_bucket", resourceName: "shared_logs", namespace: "platform" }],
      };
      expect(classifyResource(makeNode("aws_s3_bucket", "shared_logs"), config)).toBe("platform");
      // Different name should not match
      const ns = classifyResource(makeNode("aws_s3_bucket", "app_data"), config);
      expect(ns).toMatch(/^service-/);
    });
  });

  describe("classifyGraph", () => {
    it("classifies all nodes in a graph", () => {
      const nodes = new Map<string, GraphNode>();
      const vpc = makeNode("aws_vpc", "main");
      const lambda = makeNode("aws_lambda_function", "handler");
      nodes.set(vpc.id, vpc);
      nodes.set(lambda.id, lambda);

      const classifications = classifyGraph(nodes);
      expect(classifications.get(vpc.id)).toBe("platform");
      expect(classifications.get(lambda.id)).toMatch(/^service-/);
    });
  });
});
