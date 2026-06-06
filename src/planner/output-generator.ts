import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CutEdge, DependencyGraph, FileWrite, OutputDeclaration } from "../types.js";
import { getOrCreate } from "../utils/map-utils.js";

export interface OutputGenInput {
  graph: DependencyGraph;
  cutEdges: CutEdge[];
  basePaths: Map<string, string>;
}

export interface OutputGenResult {
  outputDeclarations: OutputDeclaration[];
  fileWrites: FileWrite[];
}

/**
 * Generate an output block HCL string.
 */
export function generateOutputBlock(opts: { name: string; value: string; description: string }): string {
  return `output "${opts.name}" {
  value       = ${opts.value}
  description = "${opts.description}"
}\n`;
}

/**
 * Determine what outputs need to be added to producer repos so consumers can reference them.
 * For each resource that is referenced cross-namespace, the owning repo needs an output.
 */
export async function planOutputGeneration(input: OutputGenInput): Promise<OutputGenResult> {
  const { graph, cutEdges, basePaths } = input;
  const outputDeclarations: OutputDeclaration[] = [];
  const fileWrites: FileWrite[] = [];

  // For each cut edge, the "to" node's repo needs an output for the referenced resource
  // Actually: the target namespace (where resource lives after move) needs to expose outputs
  // The "from" node references the "to" node — so "to" is the producer
  const outputsByRepo = new Map<string, OutputDeclaration[]>();
  const seen = new Set<string>();

  for (const cut of cutEdges) {
    const toNode = graph.nodes.get(cut.edge.to);
    if (!toNode) continue;

    // Dedup: one output per resource
    const key = `${cut.toNamespace}:${toNode.resourceType}.${toNode.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const outputName = `${toNode.resourceType.replace(/^aws_/, "")}_${toNode.name}_arn`;
    const value = `${toNode.resourceType}.${toNode.name}.arn`;
    const description = `ARN of ${toNode.resourceType}.${toNode.name} for cross-repo consumption`;
    const repo = cut.toNamespace;

    const decl: OutputDeclaration = {
      name: outputName,
      value,
      description,
      repo,
      filePath: join(basePaths.get(repo) || repo, "outputs.tf"),
    };

    outputDeclarations.push(decl);
    getOrCreate(outputsByRepo, repo, () => []).push(decl);
  }

  // Generate outputs.tf writes per repo
  for (const [repo, declarations] of outputsByRepo) {
    const basePath = basePaths.get(repo);
    if (!basePath) continue;
    const outputFilePath = join(basePath, "outputs.tf");

    let existing = "";
    try {
      existing = await readFile(outputFilePath, "utf-8");
    } catch {
      // File doesn't exist
    }

    const blocks = declarations.map((d) =>
      generateOutputBlock({ name: d.name, value: d.value, description: d.description }),
    );

    const newContent = existing
      ? `${existing.trimEnd()}\n\n# Outputs added by terraform-state-mover\n${blocks.join("\n")}`
      : `# Outputs added by terraform-state-mover\n\n${blocks.join("\n")}`;

    fileWrites.push({
      filePath: outputFilePath,
      content: newContent,
      operation: existing ? "modify" : "create",
    });
  }

  return { outputDeclarations, fileWrites };
}
