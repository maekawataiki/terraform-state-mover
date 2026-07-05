/**
 * Types for the planner domain — migration planning, code rewriting, block moves.
 */

import type { CutEdge } from "./graph.js";
import type { GraphableBlock } from "./parser.js";

/**
 * Mode determines which Terraform refactoring mechanism to use:
 * - "moved": TF 1.5+ moved blocks (same-state renames only)
 * - "import": TF 1.7+ import blocks in target + removed blocks in source (cross-state)
 * - "tfmigrate": No TF blocks generated, rely on migrate.hcl for state operations
 */
export type RefactorMode = "moved" | "import" | "tfmigrate";

// ---------------------------------------------------------------------------
// Migration steps — discriminated union
// ---------------------------------------------------------------------------

interface MigrationStepBase {
  description: string;
}

export interface StateMvStep extends MigrationStepBase {
  type: "state_mv";
  command: string;
  resource?: string;
  targetRepo?: string;
}

export interface ImportStep extends MigrationStepBase {
  type: "import";
  command: string;
  resource: string;
  targetRepo: string;
}

export interface CodeRewriteStep extends MigrationStepBase {
  type: "code_rewrite";
  resource?: string;
  targetRepo?: string;
}

export interface VerifyStep extends MigrationStepBase {
  type: "verify";
  command: string;
}

export type MigrationStep = StateMvStep | ImportStep | CodeRewriteStep | VerifyStep;

// ---------------------------------------------------------------------------
// Migration plan & results
// ---------------------------------------------------------------------------

export interface MigrationPlan {
  steps: MigrationStep[];
  crossNamespaceEdges: CutEdge[];
  shellScript: string;
  json: string;
  tfmigrateHcl: string;
}

export interface CodeDiff {
  filePath: string;
  original: string;
  modified: string;
  unifiedDiff: string;
}

export interface RewriteResult {
  diffs: CodeDiff[];
  variableDeclarations: string[];
  dataSourceDeclarations: string[];
  /** Number of ARN occurrences actually replaced in the content. */
  arnsRewritten: number;
}

export interface HclMoveOperation {
  sourceFilePath: string;
  targetFilePath: string;
  block: GraphableBlock;
  sourceRepo: string;
  targetRepo: string;
}

export interface VariableDeclaration {
  name: string;
  type: string;
  description: string;
  repo: string;
  filePath: string;
}

export interface OutputDeclaration {
  name: string;
  value: string;
  description: string;
  repo: string;
  filePath: string;
}

export interface MovedBlock {
  from: string;
  to: string;
  repo: string;
}

export interface ImportBlock {
  to: string;
  id: string;
  provider?: string;
  repo: string;
}

export interface RemovedBlock {
  from: string;
  repo: string;
  destroy: boolean;
}

export interface FileWrite {
  filePath: string;
  content: string;
  operation: "create" | "modify" | "delete";
}

export interface MigrationStepError {
  step: string;
  error: string;
}

export interface MigrateResult {
  moves: HclMoveOperation[];
  variableDeclarations: VariableDeclaration[];
  outputDeclarations: OutputDeclaration[];
  movedBlocks: MovedBlock[];
  importBlocks: ImportBlock[];
  removedBlocks: RemovedBlock[];
  fileWrites: FileWrite[];
  tfmigrateHcl: string;
  errors?: MigrationStepError[];
  summary: {
    resourcesMoved: number;
    arnsRewritten: number;
    outputsGenerated: number;
    filesModified: number;
  };
}
