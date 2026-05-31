import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, basename, dirname } from "node:path";
import type { TerraformBlock, ParsedFile } from "../types.js";

const ARN_PATTERN = /arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]*:[a-zA-Z0-9/_.\-:*]+/g;
const STRING_LITERAL_PATTERN = /"([^"\\]*(\\.[^"\\]*)*)"/g;
const BLOCK_PATTERN = /^(resource|data|variable|locals|module)\s+"([^"]*)"(?:\s+"([^"]*)")?\s*\{/gm;

/**
 * Strip single-line (#, //) and multi-line block comments from HCL content.
 * Preserves string literals (does not strip inside quotes).
 */
export function stripComments(content: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < content.length) {
    // Inside a double-quoted string: skip through it verbatim
    if (content[i] === '"') {
      const start = i;
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === "\\") i++; // skip escaped char
        i++;
      }
      i++; // closing quote
      result.push(content.slice(start, i));
      continue;
    }

    // Multi-line comment: /* ... */
    if (content[i] === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end === -1) {
        // Unterminated comment — strip to end
        break;
      }
      // Preserve newlines to keep line numbers stable
      const stripped = content.slice(i, end + 2);
      result.push(stripped.replace(/[^\n]/g, " "));
      i = end + 2;
      continue;
    }

    // Single-line comments: // or #
    if (content[i] === "/" && content[i + 1] === "/" || content[i] === "#") {
      const eol = content.indexOf("\n", i);
      if (eol === -1) {
        // Comment to end of file
        break;
      }
      // Replace comment with spaces (keep newline)
      result.push(" ".repeat(eol - i));
      i = eol;
      continue;
    }

    result.push(content[i]);
    i++;
  }

  return result.join("");
}

/**
 * Strip heredoc blocks (<<EOF...EOF, <<-EOF...EOF) from HCL content.
 * Replaces content with whitespace to preserve line numbers.
 */
export function stripHeredocs(content: string): string {
  const heredocPattern = /<<-?\s*([A-Z_][A-Z0-9_]*)\s*\n/g;
  let result = content;
  let match: RegExpExecArray | null;

  // Need to iterate carefully since we modify the string
  while ((match = heredocPattern.exec(result)) !== null) {
    const marker = match[1];
    const startIndex = match.index;
    const bodyStart = startIndex + match[0].length;

    // Find the closing marker (on its own line, optionally indented)
    const closingPattern = new RegExp(`^\\s*${marker}\\s*$`, "m");
    const remaining = result.slice(bodyStart);
    const closingMatch = closingPattern.exec(remaining);

    if (closingMatch) {
      const endIndex = bodyStart + closingMatch.index + closingMatch[0].length;
      const heredocContent = result.slice(startIndex, endIndex);
      // Replace with whitespace preserving newlines
      const replacement = heredocContent.replace(/[^\n]/g, " ");
      result = result.slice(0, startIndex) + replacement + result.slice(endIndex);
      // Reset regex since we modified the string
      heredocPattern.lastIndex = startIndex + replacement.length;
    }
  }

  return result;
}

/**
 * Preprocess HCL content by stripping comments and heredocs.
 * This ensures ARN extraction and block detection don't produce false positives.
 */
export function preprocessHcl(content: string): string {
  return stripHeredocs(stripComments(content));
}

export function extractArns(text: string): string[] {
  return [...text.matchAll(ARN_PATTERN)].map((m) => m[0]);
}

export function extractStringLiterals(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL_PATTERN)].map((m) => m[1]);
}

function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

export function parseHcl(content: string, filePath: string, repo: string): TerraformBlock[] {
  const blocks: TerraformBlock[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(BLOCK_PATTERN.source, "gm");

  // Preprocess: strip comments and heredocs to avoid false positives
  const cleaned = preprocessHcl(content);

  while ((match = pattern.exec(cleaned)) !== null) {
    const blockType = match[1] as TerraformBlock["type"];
    const resourceType = match[2];
    const name = match[3] || match[2];
    const braceStart = cleaned.indexOf("{", match.index + match[0].length - 1);
    const braceEnd = findMatchingBrace(cleaned, braceStart);
    const body = cleaned.slice(braceStart, braceEnd + 1);
    const stringLiterals = extractStringLiterals(body);
    const arns = extractArns(body);

    blocks.push({
      type: blockType,
      resourceType,
      name,
      body,
      stringLiterals,
      arns,
      filePath,
      repo,
    });
  }
  return blocks;
}

export async function parseTfFile(filePath: string, repo: string): Promise<ParsedFile> {
  const content = await readFile(filePath, "utf-8");
  return {
    filePath,
    repo,
    blocks: parseHcl(content, filePath, repo),
  };
}

export async function scanDirectory(dirPath: string, repo?: string): Promise<ParsedFile[]> {
  const repoName = repo || basename(dirPath);
  const results: ParsedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full);
      if (s.isDirectory() && entry !== ".terraform" && entry !== "node_modules") {
        await walk(full);
      } else if (entry.endsWith(".tf")) {
        results.push(await parseTfFile(full, repoName));
      }
    }
  }

  await walk(dirPath);
  return results;
}
