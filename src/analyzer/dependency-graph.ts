import type { ParsedFile, DependencyGraph, GraphNode, GraphEdge, SerializedGraph } from "../types.js";
import { getOrCreate } from "../utils/map-utils.js";
import { logger } from "../utils/logger.js";

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
        // OR if the resource name matches the LAST segment of the ARN path.
        // Only the last segment is checked because it represents the actual
        // resource name. Intermediate segments (e.g. IAM path "/api/", policy
        // path "/service-role/") are NOT resource identifiers and must not
        // trigger false-positive ownership claims.
        const arnPath = arnParts.slice(5).join(":");
        const allSegments = arnPath.split(/[/:]/);
        const lastSegment = normalizeToken(allSegments[allSegments.length - 1]);
        const nameInArn = lastSegment === normalizeToken(block.name);
        // Definer requires BOTH:
        // 1. Type match (resource type matches the ARN service's expected type), OR
        // 2. Name match AND the resource type is plausibly related to the ARN service
        //    (i.e. its type starts with "aws_{service}"). This prevents aws_s3_bucket
        //    from claiming an IAM role ARN just because the bucket name matches the
        //    role's last path segment.
        const typeMatch = block.resourceType === expectedType;
        const typeCompatible = arnService ? block.resourceType.startsWith(`aws_${arnService}`) : false;
        if (typeMatch || (nameInArn && typeCompatible)) {
          const id = buildNodeId("resource", block.resourceType, block.name, block.repo);
          if (arnDefinerMap.has(arn)) {
            const existing = arnDefinerMap.get(arn)!;
            if (existing.id !== id) {
              logger.warn(
                `⚠ ARN definer conflict: "${arn}" claimed by both ${existing.id} and ${id}. ` +
                `First match wins — migration may assign ownership incorrectly. ` +
                `Consider using --plan-dir for authoritative dependency resolution.`,
              );
            }
          } else {
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

      // Emit unresolved reference edges — these represent dependencies that
      // could NOT be statically resolved due to dynamic expressions.
      // They serve as warnings in the dependency graph.
      if (block.unresolvedRefs && block.unresolvedRefs.length > 0) {
        for (const ref of block.unresolvedRefs) {
          edges.push({
            from: fromId,
            to: "unresolved",
            type: "unresolved",
            label: `${ref.reason}: ${ref.expression}`,
          });
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

