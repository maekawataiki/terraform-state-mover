/**
 * Central type re-exports.
 *
 * Types are defined in domain-specific files under src/types/:
 *   - parser.ts  — HCL/Crossplane parsing output
 *   - graph.ts   — dependency graph, namespace classification
 *   - planner.ts — migration planning, code rewriting
 *   - state.ts   — state file & plan parsing
 *   - reporter.ts — pattern detection, report generation
 *   - config.ts  — .tf-mover.yaml configuration
 *
 * This file re-exports everything so existing `from "../types.js"` imports continue to work.
 */

// Parser
export type {
  BlockType,
  GraphableBlockType,
  TerraformBlock,
  GraphableBlock,
  UnresolvedReference,
  ParseWarning,
  ParsedFile,
} from "./types/parser.js";

// Graph / Analyzer
export type {
  Namespace,
  GraphNode,
  GraphEdge,
  DependencyGraph,
  SerializedGraph,
  ArnReference,
  ClassificationOverride,
  NamespaceConfig,
  CutEdge,
} from "./types/graph.js";

// Planner
export type {
  RefactorMode,
  MigrationStep,
  StateMvStep,
  ImportStep,
  CodeRewriteStep,
  VerifyStep,
  MigrationPlan,
  CodeDiff,
  RewriteResult,
  HclMoveOperation,
  VariableDeclaration,
  OutputDeclaration,
  MovedBlock,
  ImportBlock,
  RemovedBlock,
  FileWrite,
  MigrationStepError,
  MigrateResult,
} from "./types/planner.js";

// State
export type {
  StateResource,
  StateFile,
  PlanConfigResource,
  PlanValueResource,
  PlanResourceChange,
  ParsedPlan,
} from "./types/state.js";

// Reporter
export type {
  DetectedPattern,
  PatternThresholds,
} from "./types/reporter.js";

// Config
export type {
  TfMoverConfig,
} from "./types/config.js";
