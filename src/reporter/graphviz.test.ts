import { describe, it, expect } from "vitest";
import { toGraphviz, toGraphvizBefore, toGraphvizAfter } from "./graphviz.js";
import { buildGraph } from "../analyzer/dependency-graph.js";
import type { ParsedFile } from "../types.js";

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

describe("graphviz", () => {
  const files = [makeParsedFile([
    { type: "resource", resourceType: "aws_vpc", name: "main", body: "{}" },
    { type: "resource", resourceType: "aws_subnet", name: "pub", body: "{ vpc_id = aws_vpc.main.id }" },
  ])];

  describe("toGraphviz", () => {
    it("generates valid DOT format", () => {
      const graph = buildGraph(files);
      const dot = toGraphviz(graph);
      expect(dot).toContain("digraph terraform");
      expect(dot).toContain("rankdir=LR");
      expect(dot).toContain("->");
    });
  });

  describe("toGraphvizBefore", () => {
    it("groups nodes into namespace clusters with repo labels", () => {
      const graph = buildGraph(files);
      const dot = toGraphvizBefore(graph);
      expect(dot).toContain("digraph before");
      expect(dot).toContain("subgraph");
      expect(dot).toContain("(repo1)");
    });
  });

  describe("toGraphvizAfter", () => {
    it("omits repo labels from nodes", () => {
      const graph = buildGraph(files);
      const dot = toGraphvizAfter(graph);
      expect(dot).toContain("digraph after");
      expect(dot).not.toContain("(repo1)");
    });
  });
});
