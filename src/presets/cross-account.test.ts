import { describe, expect, it } from "vitest";
import type { GraphNode } from "../types.js";
import {
  classifyCrossAccountResource,
  createProviderAliasClassifier,
  extractProviderAlias,
  aliasToNamespace,
  crossAccountConfig,
} from "./cross-account.js";

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "test:resource.aws_instance.test",
    type: "resource",
    resourceType: "aws_instance",
    name: "test",
    repo: "multi-account",
    filePath: "main.tf",
    ...overrides,
  };
}

describe("cross-account preset", () => {
  describe("extractProviderAlias", () => {
    it("extracts alias from provider = aws.prod", () => {
      expect(extractProviderAlias("provider = aws.prod")).toBe("prod");
    });

    it("extracts alias with varying whitespace", () => {
      expect(extractProviderAlias("  provider   =   aws.staging")).toBe("staging");
    });

    it("returns null for default provider (no alias)", () => {
      expect(extractProviderAlias("name = test")).toBeNull();
    });

    it("extracts hyphenated aliases", () => {
      expect(extractProviderAlias("provider = aws.log-archive")).toBe("log-archive");
    });
  });

  describe("aliasToNamespace", () => {
    it("maps shared aliases to platform", () => {
      expect(aliasToNamespace("shared")).toBe("platform");
      expect(aliasToNamespace("common")).toBe("platform");
      expect(aliasToNamespace("management")).toBe("platform");
      expect(aliasToNamespace("central")).toBe("platform");
    });

    it("maps network aliases to platform", () => {
      expect(aliasToNamespace("network")).toBe("platform");
      expect(aliasToNamespace("transit")).toBe("platform");
      expect(aliasToNamespace("hub")).toBe("platform");
      expect(aliasToNamespace("connectivity")).toBe("platform");
    });

    it("maps security aliases to foundation", () => {
      expect(aliasToNamespace("security")).toBe("foundation");
      expect(aliasToNamespace("audit")).toBe("foundation");
      expect(aliasToNamespace("log-archive")).toBe("foundation");
    });

    it("maps environment aliases to service namespaces", () => {
      expect(aliasToNamespace("prod")).toBe("service-prod");
      expect(aliasToNamespace("staging")).toBe("service-staging");
      expect(aliasToNamespace("dev")).toBe("service-dev");
      expect(aliasToNamespace("sandbox")).toBe("service-sandbox");
    });

    it("maps unknown aliases to service namespace", () => {
      expect(aliasToNamespace("custom")).toBe("service-custom");
    });
  });

  describe("classifyCrossAccountResource", () => {
    it("classifies ECR repositories as platform", () => {
      const node = makeNode({ resourceType: "aws_ecr_repository", name: "app" });
      expect(classifyCrossAccountResource(node)).toBe("platform");
    });

    it("classifies Route53 zones as platform", () => {
      const node = makeNode({ resourceType: "aws_route53_zone", name: "internal" });
      expect(classifyCrossAccountResource(node)).toBe("platform");
    });

    it("classifies Route53 records as platform", () => {
      const node = makeNode({ resourceType: "aws_route53_record", name: "prod_app" });
      expect(classifyCrossAccountResource(node)).toBe("platform");
    });

    it("classifies cross-account IAM roles as platform", () => {
      const node = makeNode({ resourceType: "aws_iam_role", name: "cross_account_reader" });
      expect(classifyCrossAccountResource(node)).toBe("platform");
    });

    it("classifies prod IAM roles as service-prod", () => {
      const node = makeNode({ resourceType: "aws_iam_role", name: "prod_ecs_task" });
      expect(classifyCrossAccountResource(node)).toBe("service-prod");
    });

    it("classifies staging IAM roles as service-staging", () => {
      const node = makeNode({ resourceType: "aws_iam_role", name: "staging_ecs_task" });
      expect(classifyCrossAccountResource(node)).toBe("service-staging");
    });

    it("classifies prod ECS clusters as service-prod", () => {
      const node = makeNode({ resourceType: "aws_ecs_cluster", name: "prod" });
      expect(classifyCrossAccountResource(node)).toBe("service-prod");
    });

    it("classifies staging ECS services as service-staging", () => {
      const node = makeNode({ resourceType: "aws_ecs_service", name: "staging_app" });
      expect(classifyCrossAccountResource(node)).toBe("service-staging");
    });

    it("classifies shared S3 buckets as platform", () => {
      const node = makeNode({ resourceType: "aws_s3_bucket", name: "shared_config" });
      expect(classifyCrossAccountResource(node)).toBe("platform");
    });

    it("classifies prod S3 buckets as service-prod", () => {
      const node = makeNode({ resourceType: "aws_s3_bucket", name: "prod_data" });
      expect(classifyCrossAccountResource(node)).toBe("service-prod");
    });

    it("returns null for unrecognized resources", () => {
      const node = makeNode({ resourceType: "aws_cloudwatch_log_group", name: "app" });
      expect(classifyCrossAccountResource(node)).toBeNull();
    });
  });

  describe("createProviderAliasClassifier", () => {
    it("classifies using provider alias from block body", () => {
      const blockBodies = new Map<string, string>([
        ["test:resource.aws_ecs_cluster.app", "provider = aws.prod\nname = \"app\""],
      ]);
      const classifier = createProviderAliasClassifier(blockBodies);

      const node = makeNode({
        id: "test:resource.aws_ecs_cluster.app",
        resourceType: "aws_ecs_cluster",
        name: "app",
      });
      expect(classifier(node)).toBe("service-prod");
    });

    it("falls through to name heuristics when no body available", () => {
      const blockBodies = new Map<string, string>();
      const classifier = createProviderAliasClassifier(blockBodies);

      const node = makeNode({ resourceType: "aws_ecr_repository", name: "app" });
      expect(classifier(node)).toBe("platform");
    });

    it("provider alias takes precedence over name heuristics", () => {
      const blockBodies = new Map<string, string>([
        ["test:resource.aws_s3_bucket.prod_data", "provider = aws.staging\nbucket = \"prod-data\""],
      ]);
      const classifier = createProviderAliasClassifier(blockBodies);

      // Name says "prod" but provider is staging
      const node = makeNode({
        id: "test:resource.aws_s3_bucket.prod_data",
        resourceType: "aws_s3_bucket",
        name: "prod_data",
      });
      expect(classifier(node)).toBe("service-staging");
    });
  });

  describe("crossAccountConfig", () => {
    it("has a customClassifier", () => {
      expect(crossAccountConfig.customClassifier).toBeDefined();
    });

    it("uses per-resource grouping (not repo-based)", () => {
      expect(crossAccountConfig.groupByRepo).toBe(false);
    });
  });
});
