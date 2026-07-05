import { describe, expect, it } from "vitest";
import type { GraphNode } from "../types.js";
import { classifyDataLayerResource, dataLayerConfig } from "./data-layer.js";

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "test:resource.aws_instance.test",
    type: "resource",
    resourceType: "aws_instance",
    name: "test",
    repo: "monolith",
    filePath: "main.tf",
    ...overrides,
  };
}

describe("data-layer preset", () => {
  describe("classifyDataLayerResource", () => {
    describe("data store resources → service-data", () => {
      it("classifies RDS instances", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_db_instance", name: "main" }))).toBe("service-data");
      });

      it("classifies RDS clusters", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_rds_cluster", name: "aurora" }))).toBe("service-data");
      });

      it("classifies DynamoDB tables", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_dynamodb_table", name: "orders" }))).toBe("service-data");
      });

      it("classifies ElastiCache clusters", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_elasticache_cluster", name: "session" }))).toBe("service-data");
      });

      it("classifies ElastiCache replication groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_elasticache_replication_group", name: "cache" }))).toBe("service-data");
      });

      it("classifies Redshift clusters", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_redshift_cluster", name: "warehouse" }))).toBe("service-data");
      });

      it("classifies OpenSearch domains", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_opensearch_domain", name: "logs" }))).toBe("service-data");
      });
    });

    describe("data pipeline resources → service-data", () => {
      it("classifies Kinesis streams", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_kinesis_stream", name: "events" }))).toBe("service-data");
      });

      it("classifies Kinesis Firehose", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_kinesis_firehose_delivery_stream", name: "logs" }))).toBe("service-data");
      });

      it("classifies Glue catalog databases", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_glue_catalog_database", name: "analytics" }))).toBe("service-data");
      });

      it("classifies Glue jobs", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_glue_job", name: "etl" }))).toBe("service-data");
      });

      it("classifies DMS replication instances", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_dms_replication_instance", name: "migration" }))).toBe("service-data");
      });
    });

    describe("data support resources → service-data", () => {
      it("classifies DB subnet groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_db_subnet_group", name: "main" }))).toBe("service-data");
      });

      it("classifies DB parameter groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_db_parameter_group", name: "custom" }))).toBe("service-data");
      });

      it("classifies ElastiCache subnet groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_elasticache_subnet_group", name: "cache" }))).toBe("service-data");
      });

      it("classifies RDS cluster parameter groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_rds_cluster_parameter_group", name: "aurora" }))).toBe("service-data");
      });
    });

    describe("compute resources → service-compute or inferred service", () => {
      it("classifies Lambda functions", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_lambda_function", name: "generic" }))).toBe("service-compute");
      });

      it("infers service name from Lambda function name", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_lambda_function", name: "order_processor" }))).toBe("service-order");
      });

      it("classifies ECS services", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_ecs_service", name: "api_service" }))).toBe("service-api");
      });

      it("classifies ECS task definitions", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_ecs_task_definition", name: "worker" }))).toBe("service-compute");
      });

      it("classifies EKS clusters", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_eks_cluster", name: "main" }))).toBe("service-compute");
      });
    });

    describe("networking resources → platform", () => {
      it("classifies VPCs", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_vpc", name: "main" }))).toBe("platform");
      });

      it("classifies subnets", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_subnet", name: "private" }))).toBe("platform");
      });

      it("classifies security groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_security_group", name: "db" }))).toBe("platform");
      });

      it("classifies load balancers", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_lb", name: "api" }))).toBe("platform");
      });
    });

    describe("IAM roles → context-dependent", () => {
      it("classifies DB-related IAM roles as service-data", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_iam_role", name: "rds_enhanced_monitoring" }))).toBe("service-data");
      });

      it("classifies Lambda/ECS IAM roles as service-compute", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_iam_role", name: "lambda_exec" }))).toBe("service-compute");
      });

      it("classifies platform IAM roles", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_iam_role", name: "platform_deploy" }))).toBe("platform");
      });

      it("returns null for ambiguous IAM roles", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_iam_role", name: "app_role" }))).toBeNull();
      });
    });

    describe("S3 buckets → context-dependent", () => {
      it("classifies data/lake S3 buckets as service-data", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_s3_bucket", name: "data_lake" }))).toBe("service-data");
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_s3_bucket", name: "analytics_warehouse" }))).toBe("service-data");
      });

      it("classifies deploy/artifact S3 buckets as service-compute", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_s3_bucket", name: "deploy_artifacts" }))).toBe("service-compute");
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_s3_bucket", name: "static_assets" }))).toBe("service-compute");
      });

      it("returns null for ambiguous S3 buckets", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_s3_bucket", name: "my_bucket" }))).toBeNull();
      });
    });

    describe("KMS keys → context-dependent", () => {
      it("classifies DB encryption keys as service-data", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_kms_key", name: "rds_encryption" }))).toBe("service-data");
      });

      it("returns null for non-data KMS keys", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_kms_key", name: "app_signing" }))).toBeNull();
      });
    });

    describe("Secrets Manager → context-dependent", () => {
      it("classifies DB credential secrets as service-data", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_secretsmanager_secret", name: "db_password" }))).toBe("service-data");
      });

      it("returns null for non-data secrets", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_secretsmanager_secret", name: "api_key" }))).toBeNull();
      });
    });

    describe("unrecognized resources → null (falls through)", () => {
      it("returns null for CloudWatch log groups", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_cloudwatch_log_group", name: "app" }))).toBeNull();
      });

      it("returns null for SNS topics", () => {
        expect(classifyDataLayerResource(makeNode({ resourceType: "aws_sns_topic", name: "alerts" }))).toBeNull();
      });
    });
  });

  describe("dataLayerConfig", () => {
    it("has a customClassifier", () => {
      expect(dataLayerConfig.customClassifier).toBeDefined();
    });

    it("uses per-resource grouping (not repo-based)", () => {
      expect(dataLayerConfig.groupByRepo).toBe(false);
    });
  });
});
