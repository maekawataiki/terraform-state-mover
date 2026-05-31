import { describe, it, expect } from "vitest";
import { findCrossNamespaceEdges, groupCutsByNamespacePair } from "./cut-finder.js";
import type { DependencyGraph, GraphNode, GraphEdge } from "../types.js";

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): DependencyGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return { nodes: nodeMap, edges };
}

describe("cut-finder", () => {
  describe("findCrossNamespaceEdges", () => {
    it("finds edges crossing namespace boundaries", () => {
      const vpc: GraphNode = { id: "r:resource.aws_vpc.main", type: "resource", resourceType: "aws_vpc", name: "main", repo: "infra", filePath: "vpc.tf" };
      const lambda: GraphNode = { id: "r:resource.aws_lambda_function.api", type: "resource", resourceType: "aws_lambda_function", name: "api", repo: "app", filePath: "lambda.tf" };
      const edge: GraphEdge = { from: lambda.id, to: vpc.id, type: "reference" };

      const graph = makeGraph([vpc, lambda], [edge]);
      const cuts = findCrossNamespaceEdges(graph);

      expect(cuts.length).toBe(1);
      expect(cuts[0].fromNamespace).toMatch(/^service-/);
      expect(cuts[0].toNamespace).toBe("platform");
    });

    it("returns empty when no cross-namespace edges", () => {
      const vpc: GraphNode = { id: "r:resource.aws_vpc.main", type: "resource", resourceType: "aws_vpc", name: "main", repo: "infra", filePath: "vpc.tf" };
      const subnet: GraphNode = { id: "r:resource.aws_subnet.pub", type: "resource", resourceType: "aws_subnet", name: "pub", repo: "infra", filePath: "vpc.tf" };
      const edge: GraphEdge = { from: subnet.id, to: vpc.id, type: "reference" };

      const graph = makeGraph([vpc, subnet], [edge]);
      const cuts = findCrossNamespaceEdges(graph);
      // Both are platform, no cross-namespace
      expect(cuts).toHaveLength(0);
    });

    it("scores cuts by resource importance", () => {
      const vpc: GraphNode = { id: "r:resource.aws_vpc.main", type: "resource", resourceType: "aws_vpc", name: "main", repo: "r1", filePath: "a.tf" };
      const lambda: GraphNode = { id: "r:resource.aws_lambda_function.f1", type: "resource", resourceType: "aws_lambda_function", name: "f1", repo: "r2", filePath: "b.tf" };
      const sqs: GraphNode = { id: "r:resource.aws_sqs_queue.q1", type: "resource", resourceType: "aws_sqs_queue", name: "q1", repo: "r3", filePath: "c.tf" };

      const edges: GraphEdge[] = [
        { from: lambda.id, to: vpc.id, type: "reference" },
        { from: sqs.id, to: vpc.id, type: "reference" },
      ];

      const graph = makeGraph([vpc, lambda, sqs], edges);
      const cuts = findCrossNamespaceEdges(graph);
      // All should have scores > 0
      expect(cuts.every((c) => c.score > 0)).toBe(true);
      // Sorted by score descending
      for (let i = 1; i < cuts.length; i++) {
        expect(cuts[i - 1].score).toBeGreaterThanOrEqual(cuts[i].score);
      }
    });
  });

  describe("groupCutsByNamespacePair", () => {
    it("groups cuts by namespace pair", () => {
      const vpc: GraphNode = { id: "r:resource.aws_vpc.main", type: "resource", resourceType: "aws_vpc", name: "main", repo: "r1", filePath: "a.tf" };
      const l1: GraphNode = { id: "r:resource.aws_lambda_function.a", type: "resource", resourceType: "aws_lambda_function", name: "a", repo: "r2", filePath: "b.tf" };
      const l2: GraphNode = { id: "r:resource.aws_lambda_function.b", type: "resource", resourceType: "aws_lambda_function", name: "b", repo: "r2", filePath: "b.tf" };

      const edges: GraphEdge[] = [
        { from: l1.id, to: vpc.id, type: "reference" },
        { from: l2.id, to: vpc.id, type: "reference" },
      ];

      const graph = makeGraph([vpc, l1, l2], edges);
      const cuts = findCrossNamespaceEdges(graph);
      const groups = groupCutsByNamespacePair(cuts);
      expect(groups.size).toBeGreaterThanOrEqual(1);
    });
  });
});
