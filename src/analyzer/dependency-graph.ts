import type { ParsedFile, DependencyGraph, GraphNode, GraphEdge, SerializedGraph } from "../types.js";
import { getOrCreate } from "../utils/map-utils.js";

export function buildNodeId(type: "resource" | "data", resourceType: string, name: string, repo: string): string {
  return `${repo}:${type}.${resourceType}.${name}`;
}

export function buildGraph(parsedFiles: ParsedFile[]): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // First pass: register all nodes
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type === "resource" || block.type === "data") {
        const id = buildNodeId(block.type, block.resourceType, block.name, block.repo);
        nodes.set(id, {
          id,
          type: block.type,
          resourceType: block.resourceType,
          name: block.name,
          repo: block.repo,
          filePath: block.filePath,
        });
      }
    }
  }

  // Build ARN→definer map: identify which resource "owns" each ARN
  const arnServiceTypeMap: Record<string, string> = {
    iam: "aws_iam_role",
    s3: "aws_s3_bucket",
    rds: "aws_db_instance",
    lambda: "aws_lambda_function",
    dynamodb: "aws_dynamodb_table",
    sqs: "aws_sqs_queue",
    sns: "aws_sns_topic",
    eks: "aws_eks_cluster",
    kinesis: "aws_kinesis_stream",
  };

  const arnDefinerMap = new Map<string, { id: string; repo: string }>();
  const normalizeToken = (token: string): string => token.replace(/-/g, "_").toLowerCase();
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "resource") continue;
      for (const arn of block.arns) {
        // Extract service from ARN: arn:aws:{service}:...
        const arnParts = arn.split(":");
        const arnService = arnParts[2];
        const expectedType = arnServiceTypeMap[arnService];
        // The definer is identified if the resource type matches the ARN service
        // OR if the resource name matches a whole segment of the ARN path.
        // Whole-segment equality (not substring) so that a resource named "role"
        // or "a" doesn't claim ownership of unrelated ARNs. When the path has
        // multiple segments, the first is a resource-kind indicator
        // ("role/...", "function:...") and is skipped; a single-segment path
        // (e.g. S3 bucket name) is the resource name itself.
        const arnPath = arnParts.slice(5).join(":");
        const allSegments = arnPath.split(/[/:]/);
        const segments = (allSegments.length > 1 ? allSegments.slice(1) : allSegments).map(normalizeToken);
        const nameInArn = segments.includes(normalizeToken(block.name));
        if (block.resourceType === expectedType || nameInArn) {
          const id = buildNodeId("resource", block.resourceType, block.name, block.repo);
          if (!arnDefinerMap.has(arn)) {
            arnDefinerMap.set(arn, { id, repo: block.repo });
          }
        }
      }
    }
  }

  // Second pass: detect edges
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "resource" && block.type !== "data") continue;
      const fromId = buildNodeId(block.type, block.resourceType, block.name, block.repo);

      // Detect data source references in body
      const dataRefPattern = /data\.([a-z_]+)\.([a-z_][a-z0-9_]*)/g;
      let match: RegExpExecArray | null;
      while ((match = dataRefPattern.exec(block.body)) !== null) {
        const targetId = buildNodeId("data", match[1], match[2], block.repo);
        if (nodes.has(targetId)) {
          edges.push({ from: fromId, to: targetId, type: "reference", label: `data.${match[1]}.${match[2]}` });
        }
      }

      // Detect resource references
      const resRefPattern = /(?<!\.)([a-z_]+)\.([a-z_][a-z0-9_]*)\.([a-z_]+)/g;
      while ((match = resRefPattern.exec(block.body)) !== null) {
        if (["var", "local", "module", "data", "each", "self", "path", "count"].includes(match[1])) continue;
        const targetId = buildNodeId("resource", match[1], match[2], block.repo);
        if (nodes.has(targetId) && targetId !== fromId) {
          edges.push({ from: fromId, to: targetId, type: "reference", label: `${match[1]}.${match[2]}` });
        }
      }

      // Detect remote state references
      if (block.body.includes("terraform_remote_state")) {
        const remotePattern = /data\.terraform_remote_state\.([a-z_][a-z0-9_]*)/g;
        while ((match = remotePattern.exec(block.body)) !== null) {
          const targetId = buildNodeId("data", "terraform_remote_state", match[1], block.repo);
          if (nodes.has(targetId)) {
            edges.push({ from: fromId, to: targetId, type: "remote_state", label: match[1] });
          }
        }
      }

      // Cross-repo ARN matching: consumer→definer only
      for (const arn of block.arns) {
        const definer = arnDefinerMap.get(arn);
        if (definer && definer.repo !== block.repo && definer.id !== fromId) {
          edges.push({ from: fromId, to: definer.id, type: "arn", label: arn });
        }
      }
    }
  }

  // Deduplicate edges
  const seen = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.type}|${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { nodes, edges: uniqueEdges };
}

export function detectCycles(graph: DependencyGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    getOrCreate(adj, edge.from, () => []).push(edge.to);
  }

  function dfs(node: string): void {
    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (stack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        cycles.push(path.slice(cycleStart));
      }
    }

    path.pop();
    stack.delete(node);
  }

  for (const nodeId of graph.nodes.keys()) {
    if (!visited.has(nodeId)) dfs(nodeId);
  }

  return cycles;
}

export function serializeGraph(graph: DependencyGraph): SerializedGraph {
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  };
}

