import { describe, it, expect } from "vitest";
import { parsePlanJson, buildGraphFromPlan, extractResourceIds, enrichGraphWithPlan } from "./plan-parser.js";
import type { DependencyGraph, GraphNode } from "../types.js";

const samplePlanJson = JSON.stringify({
  format_version: "1.0",
  configuration: {
    root_module: {
      resources: [
        {
          address: "aws_iam_role.api_role",
          mode: "managed",
          type: "aws_iam_role",
          name: "api_role",
          expressions: {
            name: { constant_value: "api-role" },
            assume_role_policy: {
              references: ["data.aws_iam_policy_document.assume.json", "data.aws_iam_policy_document.assume"],
            },
          },
        },
        {
          address: "aws_lambda_function.handler",
          mode: "managed",
          type: "aws_lambda_function",
          name: "handler",
          expressions: {
            function_name: { constant_value: "my-handler" },
            role: {
              references: ["aws_iam_role.api_role.arn", "aws_iam_role.api_role"],
            },
            vpc_config: {
              subnet_ids: {
                references: ["aws_subnet.private.*.id", "aws_subnet.private"],
              },
            },
          },
        },
        {
          address: "data.aws_iam_policy_document.assume",
          mode: "data",
          type: "aws_iam_policy_document",
          name: "assume",
          expressions: {
            statement: {
              actions: { constant_value: ["sts:AssumeRole"] },
            },
          },
        },
      ],
    },
  },
  planned_values: {
    root_module: {
      resources: [
        {
          address: "aws_iam_role.api_role",
          mode: "managed",
          type: "aws_iam_role",
          name: "api_role",
          values: {
            arn: "arn:aws:iam::123456789012:role/api-role",
            name: "api-role",
            id: "api-role",
          },
        },
        {
          address: "aws_lambda_function.handler",
          mode: "managed",
          type: "aws_lambda_function",
          name: "handler",
          values: {
            arn: "arn:aws:lambda:us-east-1:123456789012:function:my-handler",
            function_name: "my-handler",
            id: "my-handler",
          },
        },
        {
          address: "data.aws_iam_policy_document.assume",
          mode: "data",
          type: "aws_iam_policy_document",
          name: "assume",
          values: {
            json: '{"Statement":[]}',
          },
        },
      ],
    },
  },
  resource_changes: [
    {
      address: "aws_iam_role.api_role",
      mode: "managed",
      type: "aws_iam_role",
      name: "api_role",
      change: {
        actions: ["no-op"],
        before: { arn: "arn:aws:iam::123456789012:role/api-role" },
        after: { arn: "arn:aws:iam::123456789012:role/api-role" },
        after_unknown: {},
      },
    },
    {
      address: "aws_lambda_function.handler",
      mode: "managed",
      type: "aws_lambda_function",
      name: "handler",
      change: {
        actions: ["update"],
        before: { arn: "arn:aws:lambda:us-east-1:123456789012:function:my-handler" },
        after: { arn: "arn:aws:lambda:us-east-1:123456789012:function:my-handler" },
        after_unknown: {},
      },
    },
  ],
  variables: {
    region: { value: "us-east-1" },
    environment: { value: "production" },
  },
});

describe("plan-parser", () => {
  describe("parsePlanJson", () => {
    it("parses configuration resources with references", () => {
      const plan = parsePlanJson(samplePlanJson);
      expect(plan.configResources).toHaveLength(3);

      const lambdaRes = plan.configResources.find((r) => r.name === "handler");
      expect(lambdaRes).toBeDefined();
      expect(lambdaRes!.references).toContain("aws_iam_role.api_role.arn");
      expect(lambdaRes!.references).toContain("aws_iam_role.api_role");
      expect(lambdaRes!.references).toContain("aws_subnet.private");
    });

    it("parses planned values with resource attributes", () => {
      const plan = parsePlanJson(samplePlanJson);
      expect(plan.plannedResources).toHaveLength(3);

      const role = plan.plannedResources.find((r) => r.name === "api_role");
      expect(role).toBeDefined();
      expect(role!.values.arn).toBe("arn:aws:iam::123456789012:role/api-role");
    });

    it("parses resource changes", () => {
      const plan = parsePlanJson(samplePlanJson);
      expect(plan.resourceChanges).toHaveLength(2);
      expect(plan.resourceChanges[0].change.actions).toEqual(["no-op"]);
      expect(plan.resourceChanges[1].change.actions).toEqual(["update"]);
    });

    it("parses variables", () => {
      const plan = parsePlanJson(samplePlanJson);
      expect(plan.variables).toHaveProperty("region");
      expect(plan.variables.region.value).toBe("us-east-1");
    });

    it("handles empty plan", () => {
      const plan = parsePlanJson(JSON.stringify({
        format_version: "1.0",
        configuration: { root_module: {} },
        planned_values: { root_module: {} },
        resource_changes: [],
      }));
      expect(plan.configResources).toHaveLength(0);
      expect(plan.plannedResources).toHaveLength(0);
      expect(plan.resourceChanges).toHaveLength(0);
    });

    it("handles nested modules in configuration", () => {
      const plan = parsePlanJson(JSON.stringify({
        format_version: "1.0",
        configuration: {
          root_module: {
            resources: [],
            module_calls: {
              network: {
                module: {
                  resources: [
                    {
                      address: "aws_vpc.main",
                      mode: "managed",
                      type: "aws_vpc",
                      name: "main",
                      expressions: {
                        cidr_block: { constant_value: "10.0.0.0/16" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        planned_values: { root_module: {} },
        resource_changes: [],
      }));
      expect(plan.configResources).toHaveLength(1);
      expect(plan.configResources[0].address).toBe("module.network.aws_vpc.main");
    });

    it("handles nested child_modules in planned_values", () => {
      const plan = parsePlanJson(JSON.stringify({
        format_version: "1.0",
        configuration: { root_module: {} },
        planned_values: {
          root_module: {
            resources: [],
            child_modules: [
              {
                address: "module.network",
                resources: [
                  {
                    address: "module.network.aws_vpc.main",
                    mode: "managed",
                    type: "aws_vpc",
                    name: "main",
                    values: { id: "vpc-123", cidr_block: "10.0.0.0/16" },
                  },
                ],
              },
            ],
          },
        },
        resource_changes: [],
      }));
      expect(plan.plannedResources).toHaveLength(1);
      expect(plan.plannedResources[0].values.id).toBe("vpc-123");
    });
  });

  describe("buildGraphFromPlan", () => {
    it("builds nodes from planned resources", () => {
      const plan = parsePlanJson(samplePlanJson);
      const graph = buildGraphFromPlan(plan, "infra");
      expect(graph.nodes.size).toBe(3);
      expect(graph.nodes.has("infra:resource.aws_iam_role.api_role")).toBe(true);
      expect(graph.nodes.has("infra:resource.aws_lambda_function.handler")).toBe(true);
      expect(graph.nodes.has("infra:data.aws_iam_policy_document.assume")).toBe(true);
    });

    it("builds edges from expression references", () => {
      const plan = parsePlanJson(samplePlanJson);
      const graph = buildGraphFromPlan(plan, "infra");

      // Lambda → IAM role (from expressions.role.references)
      const lambdaToRole = graph.edges.find(
        (e) => e.from === "infra:resource.aws_lambda_function.handler" && e.to === "infra:resource.aws_iam_role.api_role",
      );
      expect(lambdaToRole).toBeDefined();
    });

    it("builds data source edges", () => {
      const plan = parsePlanJson(samplePlanJson);
      const graph = buildGraphFromPlan(plan, "infra");

      // IAM role → data source (from expressions.assume_role_policy.references)
      const roleToDoc = graph.edges.find(
        (e) => e.from === "infra:resource.aws_iam_role.api_role" && e.to === "infra:data.aws_iam_policy_document.assume",
      );
      expect(roleToDoc).toBeDefined();
    });

    it("skips var/local/module references", () => {
      const plan = parsePlanJson(JSON.stringify({
        format_version: "1.0",
        configuration: {
          root_module: {
            resources: [{
              address: "aws_instance.web",
              mode: "managed",
              type: "aws_instance",
              name: "web",
              expressions: {
                instance_type: { references: ["var.instance_type", "var.instance_type"] },
                ami: { references: ["local.ami_id"] },
              },
            }],
          },
        },
        planned_values: {
          root_module: {
            resources: [{
              address: "aws_instance.web",
              mode: "managed",
              type: "aws_instance",
              name: "web",
              values: { id: "i-123" },
            }],
          },
        },
        resource_changes: [],
      }));
      const graph = buildGraphFromPlan(plan, "repo");
      expect(graph.edges).toHaveLength(0);
    });

    it("deduplicates edges", () => {
      const plan = parsePlanJson(samplePlanJson);
      const graph = buildGraphFromPlan(plan, "infra");
      const keys = graph.edges.map((e) => `${e.from}|${e.to}|${e.type}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe("extractResourceIds", () => {
    it("extracts ARNs from planned values", () => {
      const plan = parsePlanJson(samplePlanJson);
      const ids = extractResourceIds(plan, "infra");
      expect(ids.get("infra:aws_iam_role.api_role")).toBe("arn:aws:iam::123456789012:role/api-role");
      expect(ids.get("infra:aws_lambda_function.handler")).toBe("arn:aws:lambda:us-east-1:123456789012:function:my-handler");
    });

    it("falls back to id when no ARN", () => {
      const plan = parsePlanJson(JSON.stringify({
        format_version: "1.0",
        configuration: { root_module: {} },
        planned_values: {
          root_module: {
            resources: [{
              address: "aws_vpc.main",
              mode: "managed",
              type: "aws_vpc",
              name: "main",
              values: { id: "vpc-abc123" },
            }],
          },
        },
        resource_changes: [],
      }));
      const ids = extractResourceIds(plan, "infra");
      expect(ids.get("infra:aws_vpc.main")).toBe("vpc-abc123");
    });

    it("skips data sources", () => {
      const plan = parsePlanJson(samplePlanJson);
      const ids = extractResourceIds(plan, "infra");
      expect(ids.has("infra:aws_iam_policy_document.assume")).toBe(false);
    });
  });

  describe("enrichGraphWithPlan", () => {
    it("adds missing edges from plan to existing graph", () => {
      const plan = parsePlanJson(samplePlanJson);

      // Build a minimal existing graph (simulating static analysis that missed some edges)
      const nodes = new Map<string, GraphNode>();
      nodes.set("repo:resource.aws_iam_role.api_role", {
        id: "repo:resource.aws_iam_role.api_role",
        type: "resource",
        resourceType: "aws_iam_role",
        name: "api_role",
        repo: "repo",
        filePath: "iam.tf",
      });
      nodes.set("repo:resource.aws_lambda_function.handler", {
        id: "repo:resource.aws_lambda_function.handler",
        type: "resource",
        resourceType: "aws_lambda_function",
        name: "handler",
        repo: "repo",
        filePath: "lambda.tf",
      });
      const existingGraph: DependencyGraph = { nodes, edges: [] };

      const enriched = enrichGraphWithPlan({ graph: existingGraph, parsedPlan: plan, repo: "repo" });

      // Should have added edges from plan analysis
      const lambdaToRole = enriched.edges.find(
        (e) => e.from === "repo:resource.aws_lambda_function.handler" && e.to === "repo:resource.aws_iam_role.api_role",
      );
      expect(lambdaToRole).toBeDefined();
    });

    it("does not duplicate existing edges", () => {
      const plan = parsePlanJson(samplePlanJson);

      const nodes = new Map<string, GraphNode>();
      nodes.set("repo:resource.aws_iam_role.api_role", {
        id: "repo:resource.aws_iam_role.api_role",
        type: "resource",
        resourceType: "aws_iam_role",
        name: "api_role",
        repo: "repo",
        filePath: "iam.tf",
      });
      nodes.set("repo:resource.aws_lambda_function.handler", {
        id: "repo:resource.aws_lambda_function.handler",
        type: "resource",
        resourceType: "aws_lambda_function",
        name: "handler",
        repo: "repo",
        filePath: "lambda.tf",
      });

      // Add an edge that already exists
      const existingGraph: DependencyGraph = {
        nodes,
        edges: [{
          from: "repo:resource.aws_lambda_function.handler",
          to: "repo:resource.aws_iam_role.api_role",
          type: "reference",
          label: "aws_iam_role.api_role",
        }],
      };

      const enriched = enrichGraphWithPlan({ graph: existingGraph, parsedPlan: plan, repo: "repo" });

      // Count edges from lambda to role — should be exactly 1 (no duplicate)
      const lambdaToRole = enriched.edges.filter(
        (e) => e.from === "repo:resource.aws_lambda_function.handler" && e.to === "repo:resource.aws_iam_role.api_role",
      );
      expect(lambdaToRole).toHaveLength(1);
    });
  });
});
