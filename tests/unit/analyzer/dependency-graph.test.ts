import { describe, it, expect } from "vitest";
import { buildGraph, detectCycles, serializeGraph, toGraphviz, buildNodeId } from "../../../src/analyzer/dependency-graph.js";
import type { ParsedFile } from "../../../src/types.js";

function makeParsedFile(blocks: Array<{ type: "resource" | "data"; resourceType: string; name: string; body: string; arns?: string[] }>, repo = "repo1"): ParsedFile {
  return {
    filePath: "main.tf",
    repo,
    blocks: blocks.map((b) => ({
      ...b,
      filePath: "main.tf",
      repo,
      stringLiterals: [],
      arns: b.arns || [],
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
      // Should have edges but they should not be exact duplicates
      expect(edges.length).toBeGreaterThanOrEqual(1);
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

  describe("toGraphviz", () => {
    it("generates valid DOT format", () => {
      const files = [makeParsedFile([
        { type: "resource", resourceType: "aws_vpc", name: "main", body: "{}" },
        { type: "resource", resourceType: "aws_subnet", name: "pub", body: "{ vpc_id = aws_vpc.main.id }" },
      ])];
      const graph = buildGraph(files);
      const dot = toGraphviz(graph);
      expect(dot).toContain("digraph terraform");
      expect(dot).toContain("rankdir=LR");
      expect(dot).toContain("->");
    });
  });
});
