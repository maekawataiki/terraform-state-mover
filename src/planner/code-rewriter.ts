import { createTwoFilesPatch } from "diff";
import type { ArnReference, CodeDiff, RewriteResult } from "../types.js";

/**
 * Sanitize a string into a valid Terraform/HCL identifier.
 * HCL identifiers must start with a letter or underscore, and contain only letters, digits, underscores, and hyphens.
 * We replace all invalid characters with underscores, collapse consecutive underscores, strip leading digits,
 * and ensure a leading letter or underscore.
 */
export function sanitizeTfIdentifier(raw: string): string {
  // Replace all non-alphanumeric/underscore characters with underscore
  let result = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  // Collapse consecutive underscores
  result = result.replace(/_+/g, "_");
  // Strip leading/trailing underscores
  result = result.replace(/^_+|_+$/g, "");
  // If it starts with a digit, prefix with underscore
  if (/^[0-9]/.test(result)) {
    result = `_${result}`;
  }
  // Fallback if empty
  if (result === "") {
    result = "resource";
  }
  return result;
}

export function arnToDataSource(arn: string, service: string, name: string): string {
  const dataSourceType = getDataSourceType(service);
  return `data "${dataSourceType}" "${name}" {\n  # Replaces hardcoded ARN: ${arn}\n}\n`;
}

export function arnToVariable(arn: string, name: string): string {
  return `variable "${name}_arn" {\n  type        = string\n  description = "ARN for ${name} (previously hardcoded: ${arn})"\n}\n`;
}

function getDataSourceType(service: string): string {
  const mapping: Record<string, string> = {
    iam: "aws_iam_role",
    s3: "aws_s3_bucket",
    rds: "aws_db_instance",
    lambda: "aws_lambda_function",
    dynamodb: "aws_dynamodb_table",
    sqs: "aws_sqs_queue",
    sns: "aws_sns_topic",
    eks: "aws_eks_cluster",
  };
  return mapping[service] || `aws_${service}_resource`;
}

function getDataSourceReference(service: string, name: string): string {
  return `data.${getDataSourceType(service)}.${name}.arn`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A match followed by one of these characters is a name-token continuation
// (".../role/App" inside ".../role/AppV2") and must not be replaced.
// Segment/path characters like "/" or "*" are NOT included: replacing a
// bucket ARN inside "arn:...:my-bucket/*" → "${var.bucket_arn}/*" is correct.
const TOKEN_CONTINUATION = /[a-zA-Z0-9_-]/;

/**
 * Replace every occurrence of an ARN in content, handling both exact-match and
 * interpolation contexts.
 *
 * - Exact match: `"arn:aws:..."` → bare reference (e.g., `var.xxx_arn`)
 * - Interpolation: ARN embedded in a larger string → `${var.xxx_arn}` form
 *
 * Occurrences where the ARN is followed by another ARN character (e.g. the
 * target is a prefix of a longer ARN) are left untouched.
 */
export function replaceArnInContent(
  content: string,
  arn: string,
  replacement: string,
): { content: string; replacements: number } {
  const pattern = new RegExp(escapeRegExp(arn), "g");
  let result = "";
  let lastIndex = 0;
  let replacements = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const start = match.index;
    const end = start + arn.length;
    const nextChar = content[end];

    // Boundary check: skip if this is a prefix of a longer name token
    if (nextChar !== undefined && TOKEN_CONTINUATION.test(nextChar)) continue;

    const prevChar = start > 0 ? content[start - 1] : undefined;
    if (prevChar === '"' && nextChar === '"') {
      // Entire quoted string is the ARN → bare reference, drop the quotes
      result += content.slice(lastIndex, start - 1) + replacement;
      lastIndex = end + 1;
    } else {
      // Embedded in a larger string → interpolation
      result += content.slice(lastIndex, start) + `\${${replacement}}`;
      lastIndex = end;
    }
    replacements++;
  }

  result += content.slice(lastIndex);
  return { content: result, replacements };
}

export function generateUnifiedDiff(filePath: string, original: string, modified: string): string {
  return createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    original,
    modified,
    "",
    "",
    { context: 3 },
  );
}

export function rewriteArns(
  content: string,
  filePath: string,
  arnRefs: ArnReference[],
  mode: "data_source" | "variable" = "data_source",
): RewriteResult {
  let modified = content;
  const variableDeclarations: string[] = [];
  const dataSourceDeclarations: string[] = [];
  let arnsRewritten = 0;
  const seenArns = new Set<string>();

  for (const ref of arnRefs) {
    // The same ARN may be referenced multiple times; rewrite (and declare) once
    if (seenArns.has(ref.arn)) continue;
    seenArns.add(ref.arn);

    const arnPath = ref.arn.split(":").pop() || "resource";
    const safeName = sanitizeTfIdentifier(`${ref.service}_${arnPath}`);

    let replaced: { content: string; replacements: number };
    if (mode === "data_source") {
      const replacement = getDataSourceReference(ref.service, safeName);
      replaced = replaceArnInContent(modified, ref.arn, replacement);
      if (replaced.replacements > 0) {
        dataSourceDeclarations.push(arnToDataSource(ref.arn, ref.service, safeName));
      }
    } else {
      const varName = `${safeName}_arn`;
      replaced = replaceArnInContent(modified, ref.arn, `var.${varName}`);
      if (replaced.replacements > 0) {
        variableDeclarations.push(arnToVariable(ref.arn, safeName));
      }
    }
    modified = replaced.content;
    arnsRewritten += replaced.replacements;
  }

  const diffs: CodeDiff[] = [];
  if (modified !== content) {
    diffs.push({
      filePath,
      original: content,
      modified,
      unifiedDiff: generateUnifiedDiff(filePath, content, modified),
    });
  }

  return { diffs, variableDeclarations, dataSourceDeclarations, arnsRewritten };
}
