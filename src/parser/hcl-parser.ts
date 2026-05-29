import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, basename, dirname } from "node:path";
import type { TerraformBlock, ParsedFile } from "../types.js";

const ARN_PATTERN = /arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]*:[a-zA-Z0-9/_.\-:*]+/g;
const STRING_LITERAL_PATTERN = /"([^"\\]*(\\.[^"\\]*)*)"/g;
const BLOCK_PATTERN = /^(resource|data|variable|locals|module)\s+"([^"]*)"(?:\s+"([^"]*)")?\s*\{/gm;

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

  while ((match = pattern.exec(content)) !== null) {
    const blockType = match[1] as TerraformBlock["type"];
    const resourceType = match[2];
    const name = match[3] || match[2];
    const braceStart = content.indexOf("{", match.index + match[0].length - 1);
    const braceEnd = findMatchingBrace(content, braceStart);
    const body = content.slice(braceStart, braceEnd + 1);
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
