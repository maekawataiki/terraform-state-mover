import { readFile } from "node:fs/promises";
import { join, basename, relative, resolve, sep } from "node:path";
import type { HclMoveOperation, TerraformBlock, DependencyGraph, CutEdge, FileWrite, GraphableBlock } from "../types.js";
import { logger } from "../utils/logger.js";
import { CliError, formatError } from "../utils/error.js";
import { getOrCreate } from "../utils/map-utils.js";
import { preprocessHcl, findMatchingBrace, parseHclAst } from "../parser/hcl-parser.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the full raw HCL text of a block from file content.
 * Operates on a preprocessed copy (heredocs/comments blanked) to find brace boundaries,
 * then slices from the original raw content to preserve heredoc/comment content intact.
 */
function extractBlockHcl(content: string, block: TerraformBlock): string | null {
  const cleaned = preprocessHcl(content);

  const headerPattern = block.type === "resource" || block.type === "data"
    ? new RegExp(`^[ \\t]*${block.type}\\s+"${escapeRegExp(block.resourceType)}"\\s+"${escapeRegExp(block.name)}"\\s*\\{`, "m")
    : new RegExp(`^[ \\t]*${block.type}\\s+"${escapeRegExp(block.name)}"\\s*\\{`, "m");

  const headerMatch = headerPattern.exec(cleaned);
  if (!headerMatch) return null;

  const braceStart = cleaned.indexOf("{", headerMatch.index);
  let braceEnd: number;
  try {
    braceEnd = findMatchingBrace(cleaned, braceStart, block.filePath);
  } catch {
    return null;
  }

  // Slice from start-of-line containing header to closing brace (inclusive) from RAW content
  let lineStart = headerMatch.index;
  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;

  return content.slice(lineStart, braceEnd + 1);
}

export interface BlockMoveInput {
  graph: DependencyGraph;
  cutEdges: CutEdge[];
  basePaths: Map<string, string>; // repo name -> absolute dir path
}

export interface BlockMoveResult {
  moves: HclMoveOperation[];
  fileWrites: FileWrite[];
  /** Moves that were skipped due to file read errors or block location failures. */
  failedMoves: BlockMoveFailure[];
}

export interface BlockMoveFailure {
  resourceType: string;
  name: string;
  sourceRepo: string;
  targetRepo: string;
  reason: string;
}

/**
 * Given original file content and a block to remove, return content with that block excised.
 * Uses the block's body to locate it in the raw content.
 */
export function removeBlockFromContent(content: string, block: TerraformBlock): string {
  // Locate the block in a preprocessed copy: comments and heredocs are blanked out
  // (offset-preserving), so a "}" inside a string, heredoc, or comment can't
  // terminate the scan early. Offsets found here are valid in the raw content.
  const cleaned = preprocessHcl(content);

  const headerPattern = block.type === "resource" || block.type === "data"
    ? new RegExp(`^[ \\t]*${block.type}\\s+"${escapeRegExp(block.resourceType)}"\\s+"${escapeRegExp(block.name)}"\\s*\\{`, "m")
    : new RegExp(`^[ \\t]*${block.type}\\s+"${escapeRegExp(block.name)}"\\s*\\{`, "m");

  const headerMatch = headerPattern.exec(cleaned);
  if (!headerMatch) return content;
  const headerIndex = headerMatch.index;

  // Find opening brace (guaranteed present by the pattern)
  const braceStart = cleaned.indexOf("{", headerIndex);

  // Find matching closing brace (string-aware, on cleaned content)
  let braceEnd: number;
  try {
    braceEnd = findMatchingBrace(cleaned, braceStart, block.filePath);
  } catch {
    // Unmatched brace — leave content untouched rather than corrupting it
    logger.warn(
      `⚠ Block removal skipped: unmatched brace for ${block.type} "${block.resourceType}.${block.name}" in ${block.filePath}. ` +
      `The file was left unchanged. This may indicate malformed HCL syntax.`,
    );
    return content;
  }

  // Remove from start of line containing header to end of closing brace + newline
  let lineStart = headerIndex;
  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;

  let lineEnd = braceEnd + 1;
  // Consume trailing newlines (up to 2)
  let consumed = 0;
  while (lineEnd < content.length && content[lineEnd] === "\n" && consumed < 2) {
    lineEnd++;
    consumed++;
  }

  return content.slice(0, lineStart) + content.slice(lineEnd);
}

/**
 * Generate the full HCL text for a block to be written to the target file.
 */
export function blockToHcl(block: TerraformBlock): string {
  const header = block.type === "resource" || block.type === "data"
    ? `${block.type} "${block.resourceType}" "${block.name}"`
    : `${block.type} "${block.name}"`;
  return `${header} ${block.body}\n`;
}

/**
 * Determine which blocks need to be moved based on cut edges.
 * Returns move operations and corresponding file writes.
 */
export async function planBlockMoves(input: BlockMoveInput): Promise<BlockMoveResult> {
  const { graph, cutEdges, basePaths } = input;
  const moves: HclMoveOperation[] = [];
  const fileWrites: FileWrite[] = [];

  // Collect unique resources that need to move (dedup by node ID)
  // A resource needs to move when its classified namespace doesn't match its current repo.
  // This directly identifies "misplaced" resources (e.g., IAM role in infra-central that
  // should belong to service-app-api per the gatekeeper classifier).
  // We also consider cross-repo cut edges as a secondary signal.
  const movedNodes = new Map<string, { node: typeof graph.nodes extends Map<string, infer V> ? V : never; targetNamespace: string }>();

  // Primary: find resources where namespace != repo (misplaced resources)
  for (const [nodeId, node] of graph.nodes) {
    if (!node.namespace) continue;
    // Resource's namespace doesn't match any expected repo for that namespace
    const expectedRepo = node.namespace;
    if (node.repo !== expectedRepo && basePaths.has(expectedRepo)) {
      if (!movedNodes.has(nodeId)) {
        movedNodes.set(nodeId, { node, targetNamespace: node.namespace });
      }
    }
  }

  // Secondary: cross-repo cut edges (for cases where namespace == repo but edge crosses boundary)
  for (const cut of cutEdges) {
    const fromNode = graph.nodes.get(cut.edge.from);
    const toNode = graph.nodes.get(cut.edge.to);

    // Skip same-repo edges
    if (fromNode && toNode && fromNode.repo === toNode.repo) continue;

    // Move provider (edge.to) to consumer's namespace
    if (toNode && toNode.repo !== cut.fromNamespace && basePaths.has(cut.fromNamespace)) {
      if (!movedNodes.has(cut.edge.to)) {
        movedNodes.set(cut.edge.to, { node: toNode, targetNamespace: cut.fromNamespace });
      }
    }
  }

  for (const [, { node, targetNamespace }] of movedNodes) {
    const sourceBasePath = basePaths.get(node.repo);
    if (!sourceBasePath) continue;

    const sourceFilePath = join(sourceBasePath, relative(sourceBasePath, node.filePath) || basename(node.filePath));
    const targetBasePath = basePaths.get(targetNamespace) || join(sourceBasePath, "..", targetNamespace);
    const targetFileName = `moved-from-${node.repo}.tf`;
    const targetFilePath = join(targetBasePath, targetFileName);

    // Validate that target path does not escape the expected base directory via traversal
    const resolvedTarget = resolve(targetFilePath);
    const resolvedBase = resolve(targetBasePath);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
      throw new CliError(
        `Path traversal detected: target file "${targetFilePath}" resolves outside ` +
        `base directory "${targetBasePath}". Check repo name "${targetNamespace}" for path injection.`,
      );
    }

    const block: GraphableBlock = {
      type: "resource",
      resourceType: node.resourceType,
      name: node.name,
      body: "", // Will be filled from actual file content
      stringLiterals: [],
      arns: [],
      filePath: node.filePath,
      repo: node.repo,
    };

    moves.push({
      sourceFilePath,
      targetFilePath,
      block,
      sourceRepo: node.repo,
      targetRepo: targetNamespace,
    });
  }

  // Read source files, extract actual block bodies, generate file writes
  const sourceContents = new Map<string, string>();
  const targetContents = new Map<string, string[]>();
  const locatedMoves: HclMoveOperation[] = [];
  const failedMoves: BlockMoveFailure[] = [];

  for (const move of moves) {
    // Read source
    if (!sourceContents.has(move.sourceFilePath)) {
      try {
        sourceContents.set(move.sourceFilePath, await readFile(move.sourceFilePath, "utf-8"));
      } catch (error: unknown) {
        // File doesn't exist at computed path, try the block's original filePath
        logger.warn(`⚠ Could not read ${move.sourceFilePath} (${formatError(error)}), falling back to ${move.block.filePath}`);
        try {
          const content = await readFile(move.block.filePath, "utf-8");
          sourceContents.set(move.sourceFilePath, content);
        } catch (fallbackError: unknown) {
          const reason = `File read failed: ${formatError(fallbackError)}`;
          logger.error(`✗ Failed to read source file for ${move.block.resourceType}.${move.block.name}: ${reason}`);
          failedMoves.push({
            resourceType: move.block.resourceType,
            name: move.block.name,
            sourceRepo: move.sourceRepo,
            targetRepo: move.targetRepo,
            reason,
          });
          continue;
        }
      }
    }

    // Parse to get the real block with body.
    // Uses AST parser (hcl2json Wasm) to confirm block existence (handles dynamic blocks,
    // nested structures, complex expressions better than regex), then extracts the original
    // HCL body text via regex parser for writing to target files.
    const content = sourceContents.get(move.sourceFilePath);
    if (!content) continue;

    // Step 1: Confirm block exists via AST (catches edge cases regex misses)
    let blockExists = true;
    try {
      const astBlocks = await parseHclAst(content, move.sourceFilePath, move.sourceRepo);
      blockExists = astBlocks.some(
        (b) => b.type === move.block.type && b.resourceType === move.block.resourceType && b.name === move.block.name,
      );
    } catch {
      // AST parser failed — skip confirmation, try regex directly (blockExists stays true)
    }

    if (!blockExists) {
      const reason = "AST parser could not locate block — may use non-standard HCL syntax";
      logger.warn(
        `⚠ ${reason}: ${move.block.resourceType}.${move.block.name} in ${move.sourceFilePath}`,
      );
      failedMoves.push({
        resourceType: move.block.resourceType,
        name: move.block.name,
        sourceRepo: move.sourceRepo,
        targetRepo: move.targetRepo,
        reason,
      });
      continue;
    }

    // Step 2: Extract original HCL block text from raw content.
    // Uses preprocessed (heredoc/comment-blanked) offsets to locate the block,
    // then slices from raw content to preserve heredoc bodies intact.
    const rawBlockText = extractBlockHcl(content, move.block);

    if (rawBlockText) {
      // Update block body with the raw extracted body (everything between and including braces)
      const braceIndex = rawBlockText.indexOf("{");
      if (braceIndex !== -1) {
        move.block = { ...move.block, body: rawBlockText.slice(braceIndex) } as GraphableBlock;
      }
      locatedMoves.push(move);
      getOrCreate(targetContents, move.targetFilePath, () => []).push(rawBlockText);
    } else {
      const reason = "Could not locate block boundaries — may use unsupported syntax";
      logger.warn(
        `⚠ ${reason}: ${move.block.resourceType}.${move.block.name} in ${move.sourceFilePath}`,
      );
      failedMoves.push({
        resourceType: move.block.resourceType,
        name: move.block.name,
        sourceRepo: move.sourceRepo,
        targetRepo: move.targetRepo,
        reason,
      });
    }
  }

  // Generate file writes: target files (create with moved blocks)
  for (const [targetPath, blocks] of targetContents) {
    fileWrites.push({
      filePath: targetPath,
      content: `# Resources moved by terraform-state-mover\n\n${blocks.join("\n")}`,
      operation: "create",
    });
  }

  // Generate file writes: source files (remove moved blocks).
  // Only blocks that were located and copied to a target may be removed —
  // removing an un-copied block would silently delete the resource definition.
  const sourceRemovals = new Map<string, TerraformBlock[]>();
  for (const move of locatedMoves) {
    getOrCreate(sourceRemovals, move.sourceFilePath, () => []).push(move.block);
  }

  for (const [sourcePath, blocks] of sourceRemovals) {
    let content = sourceContents.get(sourcePath) || "";
    for (const block of blocks) {
      content = removeBlockFromContent(content, block);
    }
    const trimmed = content.trim();
    if (trimmed === "") {
      fileWrites.push({ filePath: sourcePath, content: "", operation: "delete" });
    } else {
      fileWrites.push({ filePath: sourcePath, content: trimmed + "\n", operation: "modify" });
    }
  }

  return { moves: locatedMoves, fileWrites, failedMoves };
}
