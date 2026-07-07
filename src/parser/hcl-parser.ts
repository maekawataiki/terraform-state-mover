import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as hcl2jsonParse } from "@cdktf/hcl2json";
import type { TerraformBlock, ParsedFile, ParseWarning, UnresolvedReference } from "../types.js";
import { ARN_PATTERN_SIMPLE } from "../analyzer/arn-detector.js";
import { CliError } from "../utils/error.js";

const STRING_LITERAL_PATTERN = /"((?:[^"\\]|\\.){0,10000})"/g;
// `locals` takes no labels; the other block types take one or two quoted labels.
const BLOCK_PATTERN = /^(?:(resource|data|variable|module)\s+"([^"]*)"(?:\s+"([^"]*)")?|(locals))\s*\{/gm;

/** Normalize a BLOCK_PATTERN match into (type, resourceType, name). */
function blockMatchParts(match: RegExpExecArray): { blockType: TerraformBlock["type"]; resourceType: string; name: string } {
  if (match[4]) {
    // Label-less locals block
    return { blockType: "locals", resourceType: "locals", name: "locals" };
  }
  return {
    blockType: match[1] as TerraformBlock["type"],
    resourceType: match[2],
    name: match[3] || match[2],
  };
}

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
        if (content[i] === "\\") {
          i++; // skip backslash
          if (i < content.length) i++; // skip escaped char
        } else {
          i++;
        }
      }
      if (i < content.length) i++; // closing quote
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
  const heredocPattern = /<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\n/g;
  let result = content;

  // Need to iterate carefully since we modify the string
  // Reset lastIndex each iteration since result string is being mutated
  heredocPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
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
      // Reset lastIndex to continue scanning after the replaced content
      heredocPattern.lastIndex = startIndex + replacement.length;
    } else {
      // No closing marker found — skip past this match to avoid infinite loop
      heredocPattern.lastIndex = bodyStart;
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
  return [...text.matchAll(ARN_PATTERN_SIMPLE)].map((m) => m[0]);
}

export function extractStringLiterals(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL_PATTERN)].map((m) => m[1]);
}

export function findMatchingBrace(text: string, startIndex: number, filePath?: string): number {
  let depth = 0;
  let i = startIndex;
  while (i < text.length) {
    const ch = text[i];
    // Skip over double-quoted strings (don't count braces inside them)
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++; // skip backslash
          if (i < text.length) i++; // skip escaped char
        } else {
          i++;
        }
      }
      // Skip closing quote
      if (i < text.length) i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  const context = filePath ? ` in ${filePath}` : "";
  const snippet = text.slice(startIndex, startIndex + 60).replace(/\n/g, "\\n");
  throw new CliError(
    `Unmatched brace${context} at offset ${startIndex} (depth=${depth}). ` +
    `Block starts with: "${snippet}...". ` +
    `This usually indicates malformed HCL. Fix the syntax or exclude this file.`,
  );
}

export function parseHcl(content: string, filePath: string, repo: string): TerraformBlock[] {
  const blocks: TerraformBlock[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(BLOCK_PATTERN.source, "gm");

  // Preprocess: strip comments and heredocs to avoid false positives
  const cleaned = preprocessHcl(content);

  while ((match = pattern.exec(cleaned)) !== null) {
    const { blockType, resourceType, name } = blockMatchParts(match);
    const braceStart = cleaned.indexOf("{", match.index + match[0].length - 1);
    const braceEnd = findMatchingBrace(cleaned, braceStart, filePath);
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


// ─── AST-based parser using @cdktf/hcl2json (Wasm) ───

/**
 * Recursively extract all string values from a nested JSON structure.
 * Used to find ARNs and string literals deep within parsed HCL.
 * Skips multi-line strings (likely heredocs / JSON policies) to avoid false-positive ARN detection.
 */
function collectStringsFromJson(obj: unknown, opts?: { skipMultiline?: boolean }): string[] {
  const strings: string[] = [];
  const skipMultiline = opts?.skipMultiline ?? false;

  function walk(value: unknown): void {
    if (typeof value === "string") {
      if (skipMultiline && value.includes("\n")) return;
      strings.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  }

  walk(obj);
  return strings;
}

/**
 * Extract unresolved dynamic references from collected strings.
 * 
 * @cdktf/hcl2json represents HCL expressions as "${...}" strings in its JSON output.
 * We classify patterns that can't be statically resolved:
 * - Dynamic indexing: data[local.type].xxx, var.map[key]
 * - Function calls that construct references: lookup(...), element(...)
 * - Conditionals: condition ? ref_a : ref_b
 * - Splat expressions: resource.*.attr
 */
export function extractUnresolvedRefs(strings: string[]): UnresolvedReference[] {
  const refs: UnresolvedReference[] = [];
  const seen = new Set<string>();

  for (const s of strings) {
    // Only analyze interpolation expressions
    if (!s.startsWith("${") && !s.includes("${")) continue;

    // Extract all interpolation expressions from the string
    // Use [^}]+ which cannot backtrack (single char class, mutually exclusive with })
    // Length-limit input to prevent slow scans on very large strings
    const bounded = s.length > 10_000 ? s.slice(0, 10_000) : s;
    const exprPattern = /\$\{([^}]{1,1000})\}/g;
    let match: RegExpExecArray | null;
    while ((match = exprPattern.exec(bounded)) !== null) {
      const expr = match[1].trim();
      if (seen.has(expr)) continue;

      // Dynamic indexing: something[expression] where expression contains a dotted reference
      const bracketMatch = expr.match(/\[([^\]]{1,200})\]/);
      if (bracketMatch && /[a-z_]{1,100}\.[a-z_]{1,100}/.test(bracketMatch[1])) {
        seen.add(expr);
        refs.push({ expression: expr, reason: "dynamic_index" });
        continue;
      }

      // Computed key via lookup/element/try functions
      if (/\b(lookup|element|try|coalesce)\s*\(/.test(expr)) {
        seen.add(expr);
        refs.push({ expression: expr, reason: "function_call" });
        continue;
      }

      // Conditional expressions: cond ? a : b
      if (/\?[^:]{0,500}:/.test(expr)) {
        seen.add(expr);
        refs.push({ expression: expr, reason: "conditional" });
        continue;
      }

      // Splat: resource.*.attr or resource[*].attr
      if (/\.\*\.|\[\*\]/.test(expr)) {
        seen.add(expr);
        refs.push({ expression: expr, reason: "splat" });
        continue;
      }

      // Computed map key: var.something["${...}"] or local.map[var.key]
      if (/\[var\.|local\.|each\./.test(expr) && /\]/.test(expr)) {
        seen.add(expr);
        refs.push({ expression: expr, reason: "computed_key" });
        continue;
      }
    }
  }

  return refs;
}

/**
 * Parse HCL content using @cdktf/hcl2json (Go HCL parser compiled to Wasm).
 * Returns TerraformBlock[] compatible with the rest of the pipeline.
 */
export async function parseHclAst(content: string, filePath: string, repo: string): Promise<TerraformBlock[]> {
  const json = await hcl2jsonParse(filePath, content);
  const blocks: TerraformBlock[] = [];

  // Process resource blocks: { resource: { aws_vpc: { main: [{...}] } } }
  if (json.resource) {
    for (const [resourceType, instances] of Object.entries(json.resource as Record<string, Record<string, unknown[]>>)) {
      for (const [name, configs] of Object.entries(instances)) {
        const body = JSON.stringify(configs);
        const allStrings = collectStringsFromJson(configs, { skipMultiline: true });
        const arns = allStrings.flatMap((s) => extractArns(s));
        const stringLiterals = allStrings.filter((s) => !s.startsWith("${"));
        const unresolvedRefs = extractUnresolvedRefs(allStrings);

        blocks.push({
          type: "resource",
          resourceType,
          name,
          body,
          stringLiterals,
          arns,
          unresolvedRefs: unresolvedRefs.length > 0 ? unresolvedRefs : undefined,
          filePath,
          repo,
        });
      }
    }
  }

  // Process data blocks: { data: { terraform_remote_state: { network: [{...}] } } }
  if (json.data) {
    for (const [resourceType, instances] of Object.entries(json.data as Record<string, Record<string, unknown[]>>)) {
      for (const [name, configs] of Object.entries(instances)) {
        const body = JSON.stringify(configs);
        const allStrings = collectStringsFromJson(configs, { skipMultiline: true });
        const arns = allStrings.flatMap((s) => extractArns(s));
        const stringLiterals = allStrings.filter((s) => !s.startsWith("${"));
        const unresolvedRefs = extractUnresolvedRefs(allStrings);

        blocks.push({
          type: "data",
          resourceType,
          name,
          body,
          stringLiterals,
          arns,
          unresolvedRefs: unresolvedRefs.length > 0 ? unresolvedRefs : undefined,
          filePath,
          repo,
        });
      }
    }
  }

  // Process variable blocks: { variable: { name: [{...}] } }
  if (json.variable) {
    for (const [name, configs] of Object.entries(json.variable as Record<string, unknown[]>)) {
      const body = JSON.stringify(configs);
      blocks.push({
        type: "variable",
        resourceType: "variable",
        name,
        body,
        stringLiterals: collectStringsFromJson(configs).filter((s) => !s.startsWith("${")),
        arns: [],
        filePath,
        repo,
      });
    }
  }

  // Process module blocks: { module: { name: [{...}] } }
  if (json.module) {
    for (const [name, configs] of Object.entries(json.module as Record<string, unknown[]>)) {
      const body = JSON.stringify(configs);
      const allStrings = collectStringsFromJson(configs);
      const arns = allStrings.flatMap((s) => extractArns(s));

      blocks.push({
        type: "module",
        resourceType: "module",
        name,
        body,
        stringLiterals: allStrings.filter((s) => !s.startsWith("${")),
        arns,
        filePath,
        repo,
      });
    }
  }

  // Process locals blocks: { locals: [{...}] }
  if (json.locals) {
    const configs = json.locals as unknown[];
    const body = JSON.stringify(configs);
    const allStrings = collectStringsFromJson(configs);
    const arns = allStrings.flatMap((s) => extractArns(s));

    blocks.push({
      type: "locals",
      resourceType: "locals",
      name: "locals",
      body,
      stringLiterals: allStrings.filter((s) => !s.startsWith("${")),
      arns,
      filePath,
      repo,
    });
  }

  return blocks;
}

// ─── Parser limitation detection (still useful for user awareness) ───

/**
 * Count net brace depth change on a line, skipping braces inside string literals.
 */
function countBraceDelta(line: string): number {
  let delta = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i - 1] !== '\\')) {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') delta++;
      else if (ch === '}') delta--;
    }
  }
  return delta;
}

export function detectParserLimitations(content: string, filePath: string): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const lines = content.split("\n");

  // Track block nesting depth to distinguish resource-level for_each from dynamic block for_each
  let blockDepth = 0;
  let insideResourceBlock = false; // true when inside a resource/data/module top-level block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Detect top-level block starts (before any braces on this line are counted)
    if (blockDepth === 0 && /^(resource|data|module)\s+"/.test(trimmed)) {
      insideResourceBlock = true;
    }

    // Capture depth before applying this line's brace changes
    const depthBeforeLine = blockDepth;

    // Track brace depth (simplified — not inside strings, good enough for warnings)
    const braceDelta = countBraceDelta(line);
    blockDepth += braceDelta;

    // Reset when we exit the top-level block
    if (blockDepth === 0) {
      insideResourceBlock = false;
    }

    // templatefile — even with AST parser, we can't scan external template files
    if (/templatefile\s*\(/.test(line)) {
      warnings.push({
        filePath,
        line: lineNum,
        message: "templatefile() call — ARN references in template files are not scanned",
        severity: "warning",
      });
    }

    // for_each / count at resource level (depthBeforeLine === 1 means the line starts directly inside the top-level block)
    if (insideResourceBlock && depthBeforeLine === 1) {
      if (/^\s*for_each\s*=/.test(line)) {
        warnings.push({
          filePath,
          line: lineNum,
          message: "for_each resource — state addresses use key-based indexing (e.g. resource[\"key\"]). Migration may require per-instance move commands.",
          severity: "warning",
        });
      }
      if (/^\s*count\s*=/.test(line)) {
        warnings.push({
          filePath,
          line: lineNum,
          message: "count resource — state addresses use numeric indexing (e.g. resource[0]). Migration may require per-instance move commands.",
          severity: "warning",
        });
      }
    }

    // Interpolated ARNs — cannot be statically resolved or rewritten
    if (/arn:(?:aws|aws-cn|aws-us-gov):[^"]{0,500}\$\{/.test(line) || /\$\{[^}]{0,500}arn:(?:aws|aws-cn|aws-us-gov):/.test(line)) {
      warnings.push({
        filePath,
        line: lineNum,
        message: "Interpolated ARN detected — contains ${...} expressions. Cannot be statically resolved or auto-rewritten.",
        severity: "warning",
      });
    }
  }

  return warnings;
}

// ─── Lightweight raw body extraction (no ARN/string parsing) ───

/**
 * Extract raw HCL block bodies from content using regex + brace matching.
 * Lighter than full parseHcl — only finds block boundaries, no ARN/string extraction.
 */
function extractRawBodies(content: string, filePath: string): Map<string, string> {
  const cleaned = preprocessHcl(content);
  const map = new Map<string, string>();
  const pattern = new RegExp(BLOCK_PATTERN.source, "gm");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cleaned)) !== null) {
    const { blockType, resourceType, name } = blockMatchParts(match);
    const braceStart = cleaned.indexOf("{", match.index + match[0].length - 1);
    try {
      const braceEnd = findMatchingBrace(cleaned, braceStart, filePath);
      const body = cleaned.slice(braceStart, braceEnd + 1);
      const key = `${blockType}.${resourceType}.${name}`;
      map.set(key, body);
    } catch {
      // Skip malformed blocks
    }
  }

  return map;
}

// ─── Public API (uses AST parser with regex fallback) ───

/**
 * Parse a single .tf file. Uses @cdktf/hcl2json for accurate AST parsing,
 * falls back to regex parser if Wasm fails.
 */
export async function parseTfFile(filePath: string, repo: string): Promise<ParsedFile> {
  const content = await readFile(filePath, "utf-8");
  const warnings = detectParserLimitations(content, filePath);

  let blocks: TerraformBlock[];
  try {
    blocks = await parseHclAst(content, filePath, repo);
    // Enrich with rawBody for pattern matching in reporters (lightweight, no full regex parse)
    const rawBodies = extractRawBodies(content, filePath);
    for (const block of blocks) {
      const key = `${block.type}.${block.resourceType}.${block.name}`;
      block.rawBody = rawBodies.get(key);
    }
  } catch {
    // Fallback to regex parser if AST parser fails (e.g., syntax errors in HCL)
    blocks = parseHcl(content, filePath, repo);
    warnings.push({
      filePath,
      line: 0,
      message: "⚠ AST parser (@cdktf/hcl2json) FAILED — using regex fallback. " +
        "Dependency detection accuracy is reduced: dynamic references, nested blocks, " +
        "and complex expressions may not be detected. " +
        "Fix any HCL syntax errors in this file, or use --plan-dir for authoritative analysis.",
      severity: "warning",
    });
  }

  return {
    filePath,
    repo,
    blocks,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ─── Concurrency limiter ───

async function parallelLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Scan a directory for .tf files and parse them all.
 * Uses symlink loop detection and parallel file parsing (max 10 concurrent).
 */
export async function scanDirectory(dirPath: string, repo?: string): Promise<ParsedFile[]> {
  const repoName = repo || basename(dirPath);
  const tfFiles: string[] = [];
  const visitedDirs = new Set<string>();

  async function collectFiles(dir: string): Promise<void> {
    const realDir = await realpath(dir);
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry === ".terraform" || entry === "node_modules") continue;
      const full = join(dir, entry);
      const s = await stat(full);
      if (s.isDirectory()) {
        await collectFiles(full);
      } else if (entry.endsWith(".tf")) {
        tfFiles.push(full);
      }
    }
  }

  await collectFiles(dirPath);

  const results = await parallelLimit(tfFiles, 10, (filePath) => parseTfFile(filePath, repoName));
  return results;
}
