import { describe, expect, it } from "vitest";
import {
  ARN_SERVICE_TO_RESOURCE_TYPE,
  FOUNDATION_TYPES,
  FOUNDATION_PATTERNS,
  PLATFORM_TYPES,
  SERVICE_TYPES,
  DEFAULT_IMPORTANCE_SCORES,
} from "./resource-types.js";

describe("resource-types registry", () => {
  describe("ARN_SERVICE_TO_RESOURCE_TYPE", () => {
    it("maps common ARN services to Terraform resource types", () => {
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["iam"]).toBe("aws_iam_role");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["s3"]).toBe("aws_s3_bucket");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["lambda"]).toBe("aws_lambda_function");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["rds"]).toBe("aws_db_instance");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["dynamodb"]).toBe("aws_dynamodb_table");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["sqs"]).toBe("aws_sqs_queue");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["sns"]).toBe("aws_sns_topic");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["eks"]).toBe("aws_eks_cluster");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["kinesis"]).toBe("aws_kinesis_stream");
    });

    it("includes extended services (networking, security, CI/CD)", () => {
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["elasticloadbalancing"]).toBe("aws_lb");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["kms"]).toBe("aws_kms_key");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["secretsmanager"]).toBe("aws_secretsmanager_secret");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["ecr"]).toBe("aws_ecr_repository");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["codebuild"]).toBe("aws_codebuild_project");
    });

    it("handles hyphenated ARN services", () => {
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["execute-api"]).toBe("aws_apigatewayv2_api");
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["cognito-idp"]).toBe("aws_cognito_user_pool");
    });

    it("all values follow aws_ prefix convention", () => {
      for (const [service, type] of Object.entries(ARN_SERVICE_TO_RESOURCE_TYPE)) {
        expect(type).toMatch(/^aws_/);
      }
    });

    it("returns undefined for unknown services", () => {
      expect(ARN_SERVICE_TO_RESOURCE_TYPE["nonexistent"]).toBeUndefined();
    });
  });

  describe("FOUNDATION_TYPES", () => {
    it("contains organization-level resources", () => {
      expect(FOUNDATION_TYPES.has("aws_organizations_organization")).toBe(true);
      expect(FOUNDATION_TYPES.has("aws_organizations_account")).toBe(true);
      expect(FOUNDATION_TYPES.has("aws_organizations_policy")).toBe(true);
    });

    it("does not contain platform or service types", () => {
      expect(FOUNDATION_TYPES.has("aws_vpc")).toBe(false);
      expect(FOUNDATION_TYPES.has("aws_lambda_function")).toBe(false);
    });
  });

  describe("FOUNDATION_PATTERNS", () => {
    it("matches aws_organizations_ prefix", () => {
      expect(FOUNDATION_PATTERNS.some((p) => p.test("aws_organizations_delegated_admin"))).toBe(true);
    });

    it("does not match unrelated types", () => {
      expect(FOUNDATION_PATTERNS.some((p) => p.test("aws_vpc"))).toBe(false);
    });
  });

  describe("PLATFORM_TYPES", () => {
    it("contains networking and shared compute resources", () => {
      expect(PLATFORM_TYPES.has("aws_vpc")).toBe(true);
      expect(PLATFORM_TYPES.has("aws_subnet")).toBe(true);
      expect(PLATFORM_TYPES.has("aws_eks_cluster")).toBe(true);
      expect(PLATFORM_TYPES.has("aws_ecs_cluster")).toBe(true);
      expect(PLATFORM_TYPES.has("aws_cloudfront_distribution")).toBe(true);
    });

    it("does not contain per-service types", () => {
      expect(PLATFORM_TYPES.has("aws_lambda_function")).toBe(false);
      expect(PLATFORM_TYPES.has("aws_sqs_queue")).toBe(false);
    });
  });

  describe("SERVICE_TYPES", () => {
    it("contains per-service compute and data resources", () => {
      expect(SERVICE_TYPES.has("aws_lambda_function")).toBe(true);
      expect(SERVICE_TYPES.has("aws_dynamodb_table")).toBe(true);
      expect(SERVICE_TYPES.has("aws_sqs_queue")).toBe(true);
      expect(SERVICE_TYPES.has("aws_ecs_service")).toBe(true);
      expect(SERVICE_TYPES.has("aws_apigatewayv2_api")).toBe(true);
    });

    it("does not overlap with PLATFORM_TYPES", () => {
      for (const type of SERVICE_TYPES) {
        expect(PLATFORM_TYPES.has(type)).toBe(false);
      }
    });

    it("does not overlap with FOUNDATION_TYPES", () => {
      for (const type of SERVICE_TYPES) {
        expect(FOUNDATION_TYPES.has(type)).toBe(false);
      }
    });
  });

  describe("DEFAULT_IMPORTANCE_SCORES", () => {
    it("assigns highest scores to foundational infra", () => {
      expect(DEFAULT_IMPORTANCE_SCORES["aws_vpc"]).toBe(5);
      expect(DEFAULT_IMPORTANCE_SCORES["aws_eks_cluster"]).toBe(5);
    });

    it("assigns high scores to stateful resources", () => {
      expect(DEFAULT_IMPORTANCE_SCORES["aws_db_instance"]).toBe(4);
      expect(DEFAULT_IMPORTANCE_SCORES["aws_rds_cluster"]).toBe(4);
    });

    it("assigns medium scores to IAM resources", () => {
      expect(DEFAULT_IMPORTANCE_SCORES["aws_iam_role"]).toBe(3);
      expect(DEFAULT_IMPORTANCE_SCORES["aws_iam_policy"]).toBe(3);
    });

    it("assigns lower scores to stateless resources", () => {
      expect(DEFAULT_IMPORTANCE_SCORES["aws_lambda_function"]).toBe(2);
      expect(DEFAULT_IMPORTANCE_SCORES["aws_s3_bucket"]).toBe(2);
    });

    it("returns undefined (defaults to 1 in cut-finder) for unlisted types", () => {
      expect(DEFAULT_IMPORTANCE_SCORES["aws_cloudwatch_log_group"]).toBeUndefined();
    });
  });
});
