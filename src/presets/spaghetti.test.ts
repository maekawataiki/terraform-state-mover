import { describe, it, expect } from "vitest";
import { spaghettiConfig, classifySpaghettiResource, spaghettiReportTemplate } from "./spaghetti.js";
import type { GraphNode } from "../types.js";

describe("Spaghetti Preset", () => {
  describe("spaghettiConfig", () => {
    it("has a customClassifier", () => {
      expect(spaghettiConfig.customClassifier).toBeDefined();
    });

    it("uses repo-based grouping", () => {
      expect(spaghettiConfig.groupByRepo).toBe(true);
    });
  });

  describe("classifySpaghettiResource", () => {
    it("classifies remote_state 'network' as platform", () => {
      const node: GraphNode = {
        id: "services:data.terraform_remote_state.network",
        type: "data", resourceType: "terraform_remote_state",
        name: "network", repo: "services", filePath: "main.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies remote_state 'platform' as platform", () => {
      const node: GraphNode = {
        id: "services:data.terraform_remote_state.platform",
        type: "data", resourceType: "terraform_remote_state",
        name: "platform", repo: "services", filePath: "main.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies remote_state 'vpc' as platform", () => {
      const node: GraphNode = {
        id: "services:data.terraform_remote_state.vpc",
        type: "data", resourceType: "terraform_remote_state",
        name: "vpc", repo: "services", filePath: "main.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies remote_state with service name as service-{name}", () => {
      const node: GraphNode = {
        id: "api:data.terraform_remote_state.payments",
        type: "data", resourceType: "terraform_remote_state",
        name: "payments", repo: "api", filePath: "main.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("service-payments");
    });

    it("classifies remote_state 'foundation' as foundation", () => {
      const node: GraphNode = {
        id: "api:data.terraform_remote_state.foundation",
        type: "data", resourceType: "terraform_remote_state",
        name: "foundation", repo: "api", filePath: "main.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("foundation");
    });

    it("classifies VPC resources as platform", () => {
      const node: GraphNode = {
        id: "network:resource.aws_vpc.main",
        type: "resource", resourceType: "aws_vpc",
        name: "main", repo: "network", filePath: "vpc.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies IAM roles with 'platform' in name as platform", () => {
      const node: GraphNode = {
        id: "platform:resource.aws_iam_role.platform_deployer",
        type: "resource", resourceType: "aws_iam_role",
        name: "platform_deployer", repo: "platform", filePath: "iam.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies resources in platform-like repos as platform", () => {
      const node: GraphNode = {
        id: "infra-platform:resource.aws_eks_cluster.main",
        type: "resource", resourceType: "aws_eks_cluster",
        name: "main", repo: "infra-platform", filePath: "eks.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies resources in network repo as platform", () => {
      const node: GraphNode = {
        id: "network:resource.aws_nat_gateway.main",
        type: "resource", resourceType: "aws_nat_gateway",
        name: "main", repo: "network", filePath: "nat.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("platform");
    });

    it("classifies resources in service-* repos as service-{name}", () => {
      const node: GraphNode = {
        id: "service-orders:resource.aws_lambda_function.api",
        type: "resource", resourceType: "aws_lambda_function",
        name: "api", repo: "service-orders", filePath: "lambda.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("service-orders");
    });

    it("classifies resources in generic repos as service-{repo}", () => {
      const node: GraphNode = {
        id: "services:resource.aws_lambda_function.order_api",
        type: "resource", resourceType: "aws_lambda_function",
        name: "order_api", repo: "services", filePath: "main.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("service-services");
    });

    it("classifies resources in infra-central as foundation", () => {
      const node: GraphNode = {
        id: "infra-central:resource.aws_iam_role.admin",
        type: "resource", resourceType: "aws_iam_role",
        name: "admin", repo: "infra-central", filePath: "iam.tf",
      };
      expect(classifySpaghettiResource(node)).toBe("foundation");
    });
  });

  describe("spaghettiReportTemplate", () => {
    it("describes the Spaghetti State context", () => {
      expect(spaghettiReportTemplate).toContain("Spaghetti State");
    });

    it("explains why remote_state is problematic", () => {
      expect(spaghettiReportTemplate).toContain("terraform_remote_state");
      expect(spaghettiReportTemplate).toContain("Cascade failures");
    });

    it("describes the migration strategy", () => {
      expect(spaghettiReportTemplate).toContain("Migration Strategy");
      expect(spaghettiReportTemplate).toContain("variable");
      expect(spaghettiReportTemplate).toContain("output");
    });
  });
});
