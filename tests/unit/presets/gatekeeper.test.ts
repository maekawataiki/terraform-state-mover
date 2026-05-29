import { describe, it, expect } from "vitest";
import { gatekeeperModelConfig, classifyGatekeeperResource, gatekeeperModelReportTemplate } from "../../../src/presets/gatekeeper.js";
import type { GraphNode } from "../../../src/types.js";

describe("Gatekeeper Model Preset", () => {
  describe("gatekeeperModelConfig", () => {
    it("has overrides for permission boundaries as foundation", () => {
      const boundaryOverrides = gatekeeperModelConfig.overrides!.filter(
        (o) => o.resourceName?.includes("boundary"),
      );
      expect(boundaryOverrides.length).toBeGreaterThan(0);
      expect(boundaryOverrides.every((o) => o.namespace === "foundation")).toBe(true);
    });

    it("has overrides for Control Tower as foundation", () => {
      const ctOverrides = gatekeeperModelConfig.overrides!.filter(
        (o) => o.resourceType?.includes("controltower"),
      );
      expect(ctOverrides.length).toBeGreaterThan(0);
      expect(ctOverrides.every((o) => o.namespace === "foundation")).toBe(true);
    });

    it("has overrides for Organizations as foundation", () => {
      const orgOverrides = gatekeeperModelConfig.overrides!.filter(
        (o) => o.resourceType?.includes("organizations"),
      );
      expect(orgOverrides.length).toBeGreaterThan(0);
      expect(orgOverrides.every((o) => o.namespace === "foundation")).toBe(true);
    });
  });

  describe("classifyGatekeeperResource", () => {
    it("classifies permission boundaries as foundation", () => {
      const node: GraphNode = {
        id: "ops:resource.aws_iam_policy.web_tier_boundary",
        type: "resource", resourceType: "aws_iam_policy",
        name: "web_tier_boundary", repo: "infra-central", filePath: "iam/boundaries.tf",
      };
      expect(classifyGatekeeperResource(node)).toBe("foundation");
    });

    it("classifies EKS cluster roles as platform", () => {
      const node: GraphNode = {
        id: "infra:resource.aws_iam_role.eks_cluster_role",
        type: "resource", resourceType: "aws_iam_role",
        name: "eks_cluster_role", repo: "infra-platform", filePath: "iam.tf",
      };
      expect(classifyGatekeeperResource(node)).toBe("platform");
    });

    it("classifies EKS node roles as platform", () => {
      const node: GraphNode = {
        id: "infra:resource.aws_iam_role.eks_node_role",
        type: "resource", resourceType: "aws_iam_role",
        name: "eks_node_role", repo: "infra-platform", filePath: "iam.tf",
      };
      expect(classifyGatekeeperResource(node)).toBe("platform");
    });

    it("classifies service roles with {service}-* naming", () => {
      const node: GraphNode = {
        id: "ops:resource.aws_iam_role.app_api_rds_access",
        type: "resource", resourceType: "aws_iam_role",
        name: "app_api_rds_access", repo: "infra-central", filePath: "iam/roles.tf",
      };
      expect(classifyGatekeeperResource(node)).toBe("service-app_api");
    });

    it("classifies analytics roles to service-app namespace", () => {
      const node: GraphNode = {
        id: "ops:resource.aws_iam_role.app_analytics_s3_access",
        type: "resource", resourceType: "aws_iam_role",
        name: "app_analytics_s3_access", repo: "infra-central", filePath: "iam/roles.tf",
      };
      expect(classifyGatekeeperResource(node)).toBe("service-app_analytics");
    });

    it("classifies central repo roles by naming convention", () => {
      const node: GraphNode = {
        id: "ops:resource.aws_iam_role.billing_reader",
        type: "resource", resourceType: "aws_iam_role",
        name: "billing_reader", repo: "infra-central", filePath: "iam/roles.tf",
      };
      const result = classifyGatekeeperResource(node);
      expect(result).toBe("service-billing");
    });

    it("classifies Control Tower resources as foundation", () => {
      const node: GraphNode = {
        id: "ops:resource.aws_controltower_control.guardrail",
        type: "resource", resourceType: "aws_controltower_control",
        name: "guardrail", repo: "infra-central", filePath: "ct.tf",
      };
      expect(classifyGatekeeperResource(node)).toBe("foundation");
    });

    it("returns null for unrecognized patterns", () => {
      const node: GraphNode = {
        id: "repo:resource.aws_s3_bucket.data",
        type: "resource", resourceType: "aws_s3_bucket",
        name: "data", repo: "some-repo", filePath: "main.tf",
      };
      expect(classifyGatekeeperResource(node)).toBeNull();
    });
  });

  describe("gatekeeperModelReportTemplate", () => {
    it("describes migration phases", () => {
      expect(gatekeeperModelReportTemplate).toContain("Migration Phases");
    });

    it("describes the Gatekeeper model", () => {
      expect(gatekeeperModelReportTemplate).toContain("Gatekeeper Model");
    });

    it("describes migration phases", () => {
      expect(gatekeeperModelReportTemplate).toContain("Migration Phases");
      expect(gatekeeperModelReportTemplate).toContain("Foundation layer");
      expect(gatekeeperModelReportTemplate).toContain("Platform layer");
      expect(gatekeeperModelReportTemplate).toContain("Service layer");
    });
  });
});
