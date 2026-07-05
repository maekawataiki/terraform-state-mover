import type { HclMoveOperation, FileWrite, VariableDeclaration } from "../types.js";
import { logger } from "../utils/logger.js";

export interface BoundaryInjectionInput {
  /** Move operations that may include aws_iam_role blocks. */
  moves: HclMoveOperation[];
  /** ARN of the permissions boundary to inject (e.g. "arn:aws:iam::123:policy/ServiceBoundary"). */
  boundaryArn?: string;
  /** Variable name to use for the boundary reference (default: "permissions_boundary_arn"). */
  variableName?: string;
}

export interface BoundaryInjectionResult {
  /** File writes for modified target files (block content with PB injected). */
  fileWrites: FileWrite[];
  /** Variable declarations to add in target repos. */
  variableDeclarations: VariableDeclaration[];
  /** Number of roles that had PB injected. */
  rolesInjected: number;
}

export interface BoundaryWarning {
  /** Resource address (e.g. "aws_iam_role.api_lambda_exec"). */
  resource: string;
  /** Target repo the role is being moved to. */
  targetRepo: string;
}

/**
 * Detect aws_iam_role moves that lack a permissions_boundary attribute.
 * Returns a list of warnings for roles that will be moved without PB.
 * This runs unconditionally when IAM roles are moved.
 */
export function detectMissingBoundaries(moves: HclMoveOperation[]): BoundaryWarning[] {
  const warnings: BoundaryWarning[] = [];

  for (const move of moves) {
    if (move.block.resourceType !== "aws_iam_role") continue;

    const hasBoundary = /permissions_boundary\s*=/.test(move.block.body);
    if (!hasBoundary) {
      warnings.push({
        resource: `${move.block.resourceType}.${move.block.name}`,
        targetRepo: move.targetRepo,
      });
    }
  }

  return warnings;
}

/**
 * Log warnings about IAM roles moved without permissions_boundary.
 */
export function logBoundaryWarnings(warnings: BoundaryWarning[]): void {
  if (warnings.length === 0) return;

  logger.warn(`\n⚠ ${warnings.length} IAM role(s) moved without permissions_boundary:`);
  for (const w of warnings) {
    logger.warn(`  • ${w.resource} → ${w.targetRepo}`);
  }
  logger.warn("");
  logger.warn("  Without a permissions boundary, service teams can escalate privileges on these roles.");
  logger.warn("  To inject boundaries (produces a plan diff):");
  logger.warn("    pnpm cli migrate ... --inject-boundary <boundary-policy-arn>");
  logger.warn("");
}

/**
 * Inject `permissions_boundary = var.<name>` into aws_iam_role blocks
 * that are being moved and don't already have one.
 *
 * This is an explicit transformation (opt-in via --inject-boundary).
 * It intentionally produces a `terraform plan` diff — the user acknowledges
 * this by providing the flag.
 */
export function injectBoundary(input: BoundaryInjectionInput): BoundaryInjectionResult {
  const { moves, boundaryArn, variableName = "permissions_boundary_arn" } = input;
  const fileWrites: FileWrite[] = [];
  const variableDeclarations: VariableDeclaration[] = [];
  const reposNeedingVariable = new Set<string>();
  let rolesInjected = 0;

  for (const move of moves) {
    if (move.block.resourceType !== "aws_iam_role") continue;

    const hasBoundary = /permissions_boundary\s*=/.test(move.block.body);
    if (hasBoundary) continue;

    // Inject permissions_boundary before the closing brace of the block body
    const body = move.block.body;
    const closingBraceIndex = body.lastIndexOf("}");
    if (closingBraceIndex === -1) continue;

    // Determine indentation from existing attributes
    const indent = detectIndent(body);
    const boundaryLine = `${indent}permissions_boundary = var.${variableName}\n`;

    // Insert before closing brace
    const newBody = body.slice(0, closingBraceIndex) + boundaryLine + body.slice(closingBraceIndex);
    move.block = { ...move.block, body: newBody };

    reposNeedingVariable.add(move.targetRepo);
    rolesInjected++;
  }

  // Generate variable declarations and file writes for each target repo
  for (const repo of reposNeedingVariable) {
    variableDeclarations.push({
      name: variableName,
      type: "string",
      description: "ARN of the permissions boundary policy for service IAM roles",
      repo,
      filePath: "", // Will be resolved by the caller to <basePath>/variables.tf
    });

    fileWrites.push({
      filePath: "", // Will be resolved by the caller to <basePath>/boundary-variables.tf
      content: generateBoundaryVariable(variableName, boundaryArn),
      operation: "create",
    });
  }

  return { fileWrites, variableDeclarations, rolesInjected };
}

/**
 * Generate HCL variable block for the boundary ARN.
 * When a default value is provided, includes `default = "<arn>"` so that
 * terraform validate passes without requiring a .tfvars file.
 */
export function generateBoundaryVariable(variableName: string, defaultValue?: string): string {
  const defaultLine = defaultValue ? `\n  default     = "${defaultValue}"` : "";
  return `variable "${variableName}" {
  type        = string
  description = "ARN of the permissions boundary policy for service IAM roles"${defaultLine}
}\n`;
}

/**
 * Detect indentation level from block body content.
 * Returns the whitespace prefix used by existing attributes.
 */
function detectIndent(body: string): string {
  // Find the first non-empty line after the opening brace
  const lines = body.split("\n");
  for (const line of lines) {
    const match = line.match(/^(\s+)\S/);
    if (match) return match[1];
  }
  return "  "; // Default to 2 spaces
}
