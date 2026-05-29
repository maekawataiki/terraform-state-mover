import type { ArnReference, CodeDiff, RewriteResult } from "../types.js";

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

export function generateUnifiedDiff(filePath: string, original: string, modified: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (let i = 0; i < Math.max(origLines.length, modLines.length); i++) {
    if (origLines[i] !== modLines[i]) {
      lines.push(`@@ -${i + 1},1 +${i + 1},1 @@`);
      if (origLines[i] !== undefined) lines.push(`-${origLines[i]}`);
      if (modLines[i] !== undefined) lines.push(`+${modLines[i]}`);
    }
  }

  return lines.join("\n");
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

  for (const ref of arnRefs) {
    const arnPath = ref.arn.split(":").pop() || "resource";
    const safeName = `${ref.service}_${arnPath.replace(/[^a-zA-Z0-9]/g, "_")}`;

    if (mode === "data_source") {
      const replacement = getDataSourceReference(ref.service, safeName);
      // TODO: Handle interpolation context - if ARN is part of a larger string,
      // use "${replacement}" interpolation instead of bare reference
      modified = modified.replace(`"${ref.arn}"`, replacement);
      dataSourceDeclarations.push(arnToDataSource(ref.arn, ref.service, safeName));
    } else {
      const varName = `${safeName}_arn`;
      modified = modified.replace(`"${ref.arn}"`, `var.${varName}`);
      variableDeclarations.push(arnToVariable(ref.arn, safeName));
    }
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

  return { diffs, variableDeclarations, dataSourceDeclarations };
}
