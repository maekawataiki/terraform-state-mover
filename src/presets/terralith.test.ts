import { describe, it, expect } from "vitest";
import { terralithConfig, classifyTerralithResource, terralithReportTemplate } from "./terralith.js";
import type { GraphNode } from "../types.js";

describe("Terralith Preset", () => {
  describe("terralithConfig", () => {
    it("has a customClassifier", () => {
      expect(terralithConfig.customClassifier).toBeDefined();
    });

    it("uses per-resource grouping (groupByRepo: false)", () => {
      expect(terralithConfig.groupByRepo).toBe(false);
    });
  });

  describe("classifyTerralithResource", () => {
    it("classifies VPC as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_vpc.main",
        type: "resource", resourceType: "aws_vpc",
        name: "main", repo: "monolith", filePath: "networking.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies subnets as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_subnet.public",
        type: "resource", resourceType: "aws_subnet",
        name: "public", repo: "monolith", filePath: "networking.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies security groups as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_security_group.main",
        type: "resource", resourceType: "aws_security_group",
        name: "main", repo: "monolith", filePath: "networking.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies EKS cluster as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_eks_cluster.main",
        type: "resource", resourceType: "aws_eks_cluster",
        name: "main", repo: "monolith", filePath: "eks.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies RDS as service-data", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_db_instance.main",
        type: "resource", resourceType: "aws_db_instance",
        name: "main", repo: "monolith", filePath: "database.tf",
      };
      expect(classifyTerralithResource(node)).toBe("service-data");
    });

    it("classifies DynamoDB as service-data", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_dynamodb_table.orders",
        type: "resource", resourceType: "aws_dynamodb_table",
        name: "orders", repo: "monolith", filePath: "database.tf",
      };
      expect(classifyTerralithResource(node)).toBe("service-data");
    });

    it("classifies Lambda by name pattern (order_api → service-order)", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_lambda_function.order_api",
        type: "resource", resourceType: "aws_lambda_function",
        name: "order_api", repo: "monolith", filePath: "compute.tf",
      };
      expect(classifyTerralithResource(node)).toBe("service-order");
    });

    it("classifies Lambda by name pattern (payment_processor → service-payment)", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_lambda_function.payment_processor",
        type: "resource", resourceType: "aws_lambda_function",
        name: "payment_processor", repo: "monolith", filePath: "compute.tf",
      };
      expect(classifyTerralithResource(node)).toBe("service-payment");
    });

    it("falls back to service-{name} for unnamed Lambda", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_lambda_function.main",
        type: "resource", resourceType: "aws_lambda_function",
        name: "main", repo: "monolith", filePath: "compute.tf",
      };
      expect(classifyTerralithResource(node)).toBe("service-main");
    });

    it("classifies CloudFront as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_cloudfront_distribution.cdn",
        type: "resource", resourceType: "aws_cloudfront_distribution",
        name: "cdn", repo: "monolith", filePath: "cdn.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies Route53 zone as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_route53_zone.main",
        type: "resource", resourceType: "aws_route53_zone",
        name: "main", repo: "monolith", filePath: "dns.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies IAM roles with eks in name as platform", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_iam_role.eks_cluster_role",
        type: "resource", resourceType: "aws_iam_role",
        name: "eks_cluster_role", repo: "monolith", filePath: "iam.tf",
      };
      expect(classifyTerralithResource(node)).toBe("platform");
    });

    it("classifies IAM roles with service name pattern", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_iam_role.order_lambda_exec",
        type: "resource", resourceType: "aws_iam_role",
        name: "order_lambda_exec", repo: "monolith", filePath: "iam.tf",
      };
      const result = classifyTerralithResource(node);
      expect(result).toBe("service-order");
    });

    it("classifies S3 bucket by name pattern", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_s3_bucket.logs",
        type: "resource", resourceType: "aws_s3_bucket",
        name: "logs", repo: "monolith", filePath: "storage.tf",
      };
      expect(classifyTerralithResource(node)).toBe("service-logs");
    });

    it("returns null for unrecognized resource types", () => {
      const node: GraphNode = {
        id: "mono:resource.aws_kms_key.main",
        type: "resource", resourceType: "aws_kms_key",
        name: "main", repo: "monolith", filePath: "kms.tf",
      };
      expect(classifyTerralithResource(node)).toBeNull();
    });
  });

  describe("terralithReportTemplate", () => {
    it("describes the Terralith context", () => {
      expect(terralithReportTemplate).toContain("Terralith");
    });

    it("describes decomposition layers", () => {
      expect(terralithReportTemplate).toContain("Decomposition Layers");
      expect(terralithReportTemplate).toContain("Platform (networking)");
      expect(terralithReportTemplate).toContain("Service-data");
    });

    it("describes benefits", () => {
      expect(terralithReportTemplate).toContain("Benefits After Split");
    });
  });
});
