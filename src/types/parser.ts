/**
 * Types for the parser domain — HCL/Crossplane parsing output.
 */

/** All possible block types that the parser emits. */
export type BlockType = "resource" | "data" | "variable" | "locals" | "module";

/** Block types that produce nodes in the dependency graph. */
export type GraphableBlockType = "resource" | "data";

export interface TerraformBlock {
  type: BlockType;
  resourceType: string;
  name: string;
  body: string;
  rawBody?: string;
  stringLiterals: string[];
  arns: string[];
  /** Dynamic expressions that could not be statically resolved to a concrete reference. */
  unresolvedRefs?: UnresolvedReference[];
  filePath: string;
  repo: string;
}

/**
 * A TerraformBlock narrowed to only graph-eligible types (resource or data).
 * Use this at boundaries where only resource/data blocks are expected.
 */
export interface GraphableBlock extends Omit<TerraformBlock, "type"> {
  type: GraphableBlockType;
}

export interface UnresolvedReference {
  /** The raw expression string (e.g. "data[local.type].name.attr") */
  expression: string;
  /** Why it couldn't be resolved */
  reason: "dynamic_index" | "computed_key" | "function_call" | "conditional" | "splat";
}

export interface ParseWarning {
  filePath: string;
  line: number;
  message: string;
  severity: "info" | "warning";
}

export interface ParsedFile {
  filePath: string;
  repo: string;
  blocks: TerraformBlock[];
  warnings?: ParseWarning[];
}
