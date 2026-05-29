import type { ParsedFile, ArnReference, GraphNode } from "../types.js";
import { buildNodeId } from "./dependency-graph.js";

const ARN_PATTERN = /arn:aws:([a-z0-9-]+):[a-z0-9-]*:[0-9]*:[a-zA-Z0-9/_.\-:*]+/g;

export function classifyArnService(arn: string): string {
  const match = arn.match(/^arn:aws:([a-z0-9-]+):/);
  return match ? match[1] : "unknown";
}

export function detectArns(parsedFiles: ParsedFile[]): ArnReference[] {
  const results: ArnReference[] = [];
  const resourceArns = new Map<string, GraphNode>();

  // Build map of ARNs to their defining resources
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      if (block.type !== "resource") continue;
      for (const arn of block.arns) {
        resourceArns.set(arn, {
          id: buildNodeId("resource", block.resourceType, block.name, block.repo),
          type: "resource",
          resourceType: block.resourceType,
          name: block.name,
          repo: block.repo,
          filePath: block.filePath,
        });
      }
    }
  }

  // Scan all blocks for ARN references
  for (const file of parsedFiles) {
    for (const block of file.blocks) {
      for (const arn of block.arns) {
        const definingResource = resourceArns.get(arn);
        results.push({
          arn,
          service: classifyArnService(arn),
          filePath: file.filePath,
          repo: file.repo,
          sourceBlock: block,
          resolved: !!definingResource,
          definingResource,
        });
      }
    }
  }

  return results;
}

export function getUnresolvedArns(refs: ArnReference[]): ArnReference[] {
  return refs.filter((r) => !r.resolved);
}

export function groupByService(refs: ArnReference[]): Map<string, ArnReference[]> {
  const groups = new Map<string, ArnReference[]>();
  for (const ref of refs) {
    if (!groups.has(ref.service)) groups.set(ref.service, []);
    groups.get(ref.service)!.push(ref);
  }
  return groups;
}
