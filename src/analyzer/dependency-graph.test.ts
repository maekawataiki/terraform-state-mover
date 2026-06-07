import { describe, it, expect } from "vitest";
import { buildGraph, detectCycles, serializeGraph } from "./dependency-graph.js";
import type { ParsedFile } from "../types.js";

function makeParsedFile(blocks: Array<{ type: "resource" | "data"; resourceType: string; name: string; body: string; arns?: string[]; unresolvedRefs?: Array<{ expression: string; reason: "dynamic_index" | "computed_key" | "function_call" | "conditional" | "splat" }> }>, repo = "repo1"): ParsedFile {
  return {
    filePath: "main.tf",
    repo,
    blocks: blocks.map((b) => ({
      ...b,
      filePath: "main.tf",
      repo,
      stringLiterals: [],
      arns: b.arns || [],
      unresolvedRefs: b.unresolvedRefs,
    })),
  };
}

describe("dependency-graph", () => {
  describe("buildGraph", () => {
    it("creates nodes for resource and data blocks", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{}" },
        { type: "data", resourceType: "aws_ami", name: "latest", body: "{}" },
      ])];
      const graph = buildGraph(files);
      expect(graph.nodes.size).toBe(2);
      expect(graph.nodes.has("repo1:resource.aws_vpc.main")).toBe(true);
      expect(graph.nodes.has("repo1:data.aws_ami.latest")).toBe(true);
    });

    it("detects data source references", () => {
      const files = [makeParsedFile([
        { type: "data", resourceType: "aws_ami", name: "latest", body: "{ owner = \"amazon\" }" },
        { type: "resource", resourceType: "aws_instance", name: "web", body: "{ ami = data.aws_ami.latest.id }" },
      ])];
      const graph = buildGraph(files);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].type).toBe("reference");
      expect(graph.edges[0].from).toBe("repo1:resource.aws_instance.web");
      expect(graph.edges[0].to).toBe("repo1:data.aws_ami.latest");
    });

    it("detects resource references", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{ cidr = \"10.0.0.0/16\" }" },
        { type: "resource", resourceType: "aws_subnet", name: "pub", body: "{ vpc_id = aws_vpc.main.id }" },
      ])];
      const graph = buildGraph(files);
      expect(graph.edges.length).toBeGreaterThanOrEqual(1);
      expect(graph.edges.some((e) => e.to === "repo1:resource.aws_vpc.main")).toBe(true);
    });

    it("detects cross-repo ARN edges", () => {
      const arn = "arn:aws:iam::123456789012:role/SharedRole";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_iam_role", name: "shared", body: `{ arn = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn");
      expect(arnEdges.length).toBeGreaterThanOrEqual(1);
    });

    it("detects remote state references", () => {
      const files = [makeParsedFile([
        { type: "data", resourceType: "terraform_remote_state", name: "vpc", body: "{ backend = \"s3\" }" },
        { type: "resource", resourceType: "aws_subnet", name: "pub", body: "{ vpc_id = data.terraform_remote_state.vpc.outputs.vpc_id }" },
      ])];
      const graph = buildGraph(files);
      const remoteEdges = graph.edges.filter((e) => e.type === "remote_state");
      expect(remoteEdges).toHaveLength(1);
    });

    it("deduplicates edges", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{ x = \"y\" }" },
        { type: "resource", resourceType: "aws_subnet", name: "a", body: "{ vpc = aws_vpc.main.id\n cidr = aws_vpc.main.cidr }" },
      ])];
      const graph = buildGraph(files);
      const edges = graph.edges.filter((e) => e.from === "repo1:resource.aws_subnet.a");
      expect(edges.length).toBeGreaterThanOrEqual(1);
      // No exact duplicates: (from, to, type, label) tuples are unique
      const keys = graph.edges.map((e) => `${e.from}|${e.to}|${e.type}|${e.label}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("does not create ARN definer edges from loose substring matches", () => {
      const arn = "arn:aws:iam::123456789012:role/PaymentServiceRole";
      // Resource named "role" must NOT be treated as the definer of this ARN
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_instance", name: "role", body: `{ note = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn" && e.to === "repo1:resource.aws_instance.role");
      expect(arnEdges).toHaveLength(0);
    });

    it("matches ARN definer on whole path segment", () => {
      const arn = "arn:aws:iam::123456789012:role/payment_service_role";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_iam_role", name: "payment-service-role", body: `{ arn = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn");
      expect(arnEdges.length).toBeGreaterThanOrEqual(1);
      expect(arnEdges[0].to).toBe("repo1:resource.aws_iam_role.payment-service-role");
    });

    it("does not match intermediate ARN path segments as definer", () => {
      // IAM role with path: role/api/my-actual-role
      // Resource named "api" must NOT claim ownership via the intermediate path segment
      const arn = "arn:aws:iam::123456789012:role/api/my-actual-role";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_instance", name: "api", body: `{ note = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn" && e.to === "repo1:resource.aws_instance.api");
      expect(arnEdges).toHaveLength(0);
    });

    it("does not match resource named 'service-role' on IAM policy path", () => {
      // Policy ARN with service-role in path: policy/service-role/AWSLambdaBasicExecutionRole
      const arn = "arn:aws:iam::123456789012:policy/service-role/AWSLambdaBasicExecutionRole";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_instance", name: "service-role", body: `{ x = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ policy = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn" && e.to === "repo1:resource.aws_instance.service-role");
      expect(arnEdges).toHaveLength(0);
    });

    it("correctly matches definer when resource name equals last ARN segment", () => {
      // The actual role name is the last segment
      const arn = "arn:aws:iam::123456789012:role/api/api-service-role";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_iam_role", name: "api-service-role", body: `{ arn = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn");
      expect(arnEdges.length).toBeGreaterThanOrEqual(1);
      expect(arnEdges[0].to).toBe("repo1:resource.aws_iam_role.api-service-role");
    });

    it("does not allow type-mismatched resource to claim ARN ownership via name match", () => {
      // Regression: aws_s3_bucket named "shared" must NOT claim IAM role ARN
      // "arn:aws:iam::123:role/shared" even though the last segment matches the name.
      // The resource type (aws_s3_bucket) doesn't match the ARN service (iam).
      const arn = "arn:aws:iam::123456789012:role/shared";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_s3_bucket", name: "shared", body: `{ tags = { role_arn = "${arn}" } }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      // The S3 bucket must NOT be the definer of the IAM ARN
      const arnEdges = graph.edges.filter((e) => e.type === "arn" && e.to === "repo1:resource.aws_s3_bucket.shared");
      expect(arnEdges).toHaveLength(0);
    });

    it("does not allow type-mismatched resource to claim ARN even with exact name", () => {
      // aws_dynamodb_table named "my-role" must NOT claim IAM role ARN "arn:aws:iam::123:role/my-role"
      const arn = "arn:aws:iam::123456789012:role/my-role";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_dynamodb_table", name: "my-role", body: `{ x = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_ecs_task_definition", name: "task", body: `{ role = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn" && e.to === "repo1:resource.aws_dynamodb_table.my-role");
      expect(arnEdges).toHaveLength(0);
    });

    it("allows same-service type to claim ARN via name match (aws_iam_policy for iam ARN)", () => {
      // aws_iam_policy named "shared" CAN claim "arn:aws:iam::123:policy/shared"
      // because aws_iam_policy starts with "aws_iam" (matches service "iam")
      const arn = "arn:aws:iam::123456789012:policy/shared";
      const file1 = makeParsedFile([
        { type: "resource", resourceType: "aws_iam_policy", name: "shared", body: `{ arn = "${arn}" }`, arns: [arn] },
      ], "repo1");
      const file2 = makeParsedFile([
        { type: "resource", resourceType: "aws_lambda_function", name: "func", body: `{ policy = "${arn}" }`, arns: [arn] },
      ], "repo2");

      const graph = buildGraph([file1, file2]);
      const arnEdges = graph.edges.filter((e) => e.type === "arn");
      expect(arnEdges.length).toBeGreaterThanOrEqual(1);
      expect(arnEdges[0].to).toBe("repo1:resource.aws_iam_policy.shared");
    });

    it("emits unresolved edges for blocks with dynamic references", () => {
      const files = [makeParsedFile([
        {
          type: "resource",
          resourceType: "aws_iam_role_policy_attachment",
          name: "dynamic",
          body: '{ role = data[local.type].resource.name }',
          unresolvedRefs: [
            { expression: "data[local.type].resource.name", reason: "dynamic_index" },
          ],
        },
      ])];
      const graph = buildGraph(files);
      const unresolvedEdges = graph.edges.filter((e) => e.type === "unresolved");
      expect(unresolvedEdges).toHaveLength(1);
      expect(unresolvedEdges[0].from).toBe("repo1:resource.aws_iam_role_policy_attachment.dynamic");
      expect(unresolvedEdges[0].to).toBe("unresolved");
      expect(unresolvedEdges[0].label).toContain("dynamic_index");
    });

    it("does not emit unresolved edges for blocks without dynamic references", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{ cidr = \"10.0.0.0/16\" }" },
      ])];
      const graph = buildGraph(files);
      const unresolvedEdges = graph.edges.filter((e) => e.type === "unresolved");
      expect(unresolvedEdges).toHaveLength(0);
    });
  });

  describe("detectCycles", () => {
    it("detects circular dependencies", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_a", name: "x", body: "{ ref = aws_b.y.id }" },
        { type: "resource", resourceType: "aws_b", name: "y", body: "{ ref = aws_a.x.id }" },
      ])];
      const graph = buildGraph(files);
      const cycles = detectCycles(graph);
      expect(cycles.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty for acyclic graph", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{ x = \"y\" }" },
        { type: "resource", resourceType: "aws_subnet", name: "pub", body: "{ vpc_id = aws_vpc.main.id }" },
      ])];
      const graph = buildGraph(files);
      const cycles = detectCycles(graph);
      expect(cycles).toHaveLength(0);
    });
  });

  describe("serializeGraph", () => {
    it("serializes to plain objects", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{}" },
      ])];
      const graph = buildGraph(files);
      const serialized = serializeGraph(graph);
      expect(serialized.nodes).toHaveLength(1);
      expect(Array.isArray(serialized.edges)).toBe(true);
    });
  });

});
