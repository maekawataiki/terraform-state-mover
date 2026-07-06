import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { TerraformBlock, ParsedFile } from "../types.js";
import { ARN_PATTERN_SIMPLE } from "../analyzer/arn-detector.js";

export interface CrossplaneResource {
  apiVersion: string;
  kind: string;
  name: string;
  forProviderFields: Record<string, string>;
  resourceRefs: string[];
  arns: string[];
}

function isCrossplaneFile(content: string): boolean {
  return /apiVersion:\s*(apiextensions\.crossplane\.io|aws\.upbound\.io|iam\.aws\.upbound\.io)/.test(content);
}

export function parseCrossplaneYaml(content: string, filePath: string, repo: string): TerraformBlock[] {
  if (!isCrossplaneFile(content)) return [];

  const blocks: TerraformBlock[] = [];
  const documents = content.split(/^---$/m);

  for (const doc of documents) {
    if (!doc.trim()) continue;

    const apiVersionMatch = doc.match(/apiVersion:[ \t]*([^\n]+)/);
    const kindMatch = doc.match(/kind:[ \t]*([^\n]+)/);
    const nameMatch = doc.match(/metadata:[ \t]*\n[ \t]+name:[ \t]*([^\n]+)/);
    if (!kindMatch) continue;

    const kind = kindMatch[1].trim();
    const _apiVersion = apiVersionMatch?.[1].trim() || "";
    const name = nameMatch?.[1].trim() || "unnamed";

    const arns = [...doc.matchAll(ARN_PATTERN_SIMPLE)].map((m) => m[0]);
    const stringLiterals: string[] = [];

    // Extract forProvider fields with values
    const forProviderLines = doc.match(/^[ \t]+\w+(?:Arn|Id|Ref|Name):[ \t]*[^\n]+$/gm) || [];
    for (const line of forProviderLines) {
      const val = line.split(":").slice(1).join(":").trim();
      if (val) stringLiterals.push(val);
    }

    // Extract resourceRef names
    const resourceRefMatches = doc.matchAll(/resourceRef: *\n +name: *([^\n]+)/g);
    for (const m of resourceRefMatches) {
      stringLiterals.push(m[1].trim());
    }

    // Map Crossplane kind to Terraform resource type
    const resourceType = mapKindToResourceType(kind, doc);

    blocks.push({
      type: "resource",
      resourceType,
      name: name.replace(/[^a-zA-Z0-9_]/g, "_"),
      body: doc,
      stringLiterals,
      arns,
      filePath,
      repo,
    });
  }

  return blocks;
}

function mapKindToResourceType(kind: string, _body: string): string {
  const mapping: Record<string, string> = {
    Role: "aws_iam_role",
    Policy: "aws_iam_policy",
    RolePolicyAttachment: "aws_iam_role_policy_attachment",
    Instance: "aws_db_instance",
    Cluster: "aws_rds_cluster",
    Bucket: "aws_s3_bucket",
    Function: "aws_lambda_function",
    Subnet: "aws_subnet",
    VPC: "aws_vpc",
  };
  if (mapping[kind]) return mapping[kind];
  // Check for Composition/XRD - treat as module
  if (kind === "Composition" || kind === "CompositeResourceDefinition") {
    return "crossplane_composition";
  }
  return `crossplane_${kind.toLowerCase()}`;
}

export async function parseCrossplaneFile(filePath: string, repo: string): Promise<ParsedFile> {
  const content = await readFile(filePath, "utf-8");
  return {
    filePath,
    repo,
    blocks: parseCrossplaneYaml(content, filePath, repo),
  };
}

export async function scanCrossplaneDirectory(dirPath: string, repo?: string): Promise<ParsedFile[]> {
  const repoName = repo || basename(dirPath);
  const results: ParsedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full);
      if (s.isDirectory() && entry !== "node_modules" && entry !== ".git") {
        await walk(full);
      } else if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        const parsed = await parseCrossplaneFile(full, repoName);
        if (parsed.blocks.length > 0) {
          results.push(parsed);
        }
      }
    }
  }

  await walk(dirPath);
  return results;
}
