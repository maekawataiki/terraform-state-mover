import { readFile } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import type { ArnReference, CutEdge, DependencyGraph, FileWrite, VariableDeclaration } from "../types.js";
import { rewriteArns, sanitizeTfIdentifier } from "./code-rewriter.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { getOrCreate } from "../utils/map-utils.js";

export interface ArnRewriteInput {
  graph: DependencyGraph;
  cutEdges: CutEdge[];
  arnRefs: ArnReference[];
  basePaths: Map<string, string>;
}

export interface ArnRewriteResult {
  variableDeclarations: VariableDeclaration[];
  fileWrites: FileWrite[];
  arnsRewritten: number;
}

/**
 * Find all ARNs that cross namespace boundaries and need rewriting.
 */
export function findCrossNamespaceArns(input: {
  cutEdges: CutEdge[];
  arnRefs: ArnReference[];
}): ArnReference[] {
  const { cutEdges, arnRefs } = input;
  // Collect ARNs that appear in cut edges
  const crossArns = new Set<string>();
  for (const cut of cutEdges) {
    if (cut.edge.type === "arn" && cut.edge.label) {
      crossArns.add(cut.edge.label);
    }
  }
  return arnRefs.filter((ref) => crossArns.has(ref.arn));
}

/**
 * Generate a safe variable name from an ARN.
 * Must stay in sync with the name `rewriteArns` writes into the HCL —
 * both delegate to `sanitizeTfIdentifier`.
 */
export function arnToVarName(arn: string, service: string): string {
  const path = arn.split(":").pop() || "resource";
  return sanitizeTfIdentifier(`${service}_${path}`);
}

/**
 * Plan ARN rewrites: replace hardcoded ARNs with variable references and generate variable declarations.
 */
export async function planArnRewrites(input: ArnRewriteInput): Promise<ArnRewriteResult> {
  const { cutEdges, arnRefs, basePaths } = input;
  const fileWrites: FileWrite[] = [];
  const variableDeclarations: VariableDeclaration[] = [];

  const crossArns = findCrossNamespaceArns({ cutEdges, arnRefs });
  if (crossArns.length === 0) {
    return { variableDeclarations, fileWrites, arnsRewritten: 0 };
  }

  // Group ARN refs by file
  const arnsByFile = new Map<string, ArnReference[]>();
  for (const ref of crossArns) {
    getOrCreate(arnsByFile, ref.filePath, () => []).push(ref);
  }

  // For each file with cross-namespace ARNs, rewrite
  const variablesByRepo = new Map<string, string[]>();
  let arnsRewritten = 0;

  for (const [filePath, refs] of arnsByFile) {
    const repo = refs[0].repo;
    const basePath = basePaths.get(repo);
    const fullPath = isAbsolute(filePath) ? filePath : (basePath ? join(basePath, filePath) : filePath);

    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch (error: unknown) {
      // Try filePath directly
      try {
        logger.warn(`⚠ Could not read ${fullPath} (${formatError(error)}), trying ${filePath} directly`);
        content = await readFile(filePath, "utf-8");
      } catch (fallbackError: unknown) {
        logger.error(`✗ Skipping ARN rewrite for ${filePath}: ${formatError(fallbackError)}`);
        continue;
      }
    }

    const result = rewriteArns(content, filePath, refs, "variable");

    if (result.diffs.length > 0) {
      fileWrites.push({
        filePath: fullPath,
        content: result.diffs[0].modified,
        operation: "modify",
      });
      arnsRewritten += result.arnsRewritten;

      // Collect variable declarations for this repo
      getOrCreate(variablesByRepo, repo, () => []).push(...result.variableDeclarations);

      // Track structured declarations (one per unique ARN actually rewritten)
      const declaredArns = new Set<string>();
      for (const ref of refs) {
        if (declaredArns.has(ref.arn)) continue;
        declaredArns.add(ref.arn);
        const varName = arnToVarName(ref.arn, ref.service);
        variableDeclarations.push({
          name: `${varName}_arn`,
          type: "string",
          description: `ARN for ${varName} (previously hardcoded: ${ref.arn})`,
          repo,
          filePath: join(dirname(fullPath), "variables.tf"),
        });
      }
    }
  }

  // Generate variables.tf writes
  for (const [repo, declarations] of variablesByRepo) {
    const basePath = basePaths.get(repo);
    if (!basePath) continue;
    const varFilePath = join(basePath, "variables.tf");

    // Read existing variables.tf if it exists
    let existing = "";
    try {
      existing = await readFile(varFilePath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    const newContent = existing
      ? `${existing.trimEnd()}\n\n# Variables added by terraform-state-mover\n${declarations.join("\n")}`
      : `# Variables added by terraform-state-mover\n\n${declarations.join("\n")}`;

    fileWrites.push({
      filePath: varFilePath,
      content: newContent,
      operation: existing ? "modify" : "create",
    });
  }

  return { variableDeclarations, fileWrites, arnsRewritten };
}
