/**
 * terraform-state-mover
 *
 * This package does NOT use barrel exports.
 * Import directly from the specific module you need:
 *
 * @example
 * ```typescript
 * import { parseHcl, scanDirectory } from "terraform-state-mover/parser/hcl-parser";
 * import { buildGraph } from "terraform-state-mover/analyzer/dependency-graph";
 * import { createMigrationPlan } from "terraform-state-mover/planner/migration-planner";
 * import { generateMarkdownReport } from "terraform-state-mover/reporter/markdown-reporter";
 * ```
 *
 * For type imports:
 * ```typescript
 * import type { DependencyGraph, MigrationPlan } from "terraform-state-mover/types";
 * ```
 */

// Re-export types only (zero runtime cost, helps TypeScript consumers)
export type {
  TerraformBlock,
  ParsedFile,
  ArnReference,
  GraphNode,
  GraphEdge,
  DependencyGraph,
  SerializedGraph,
  Namespace,
  ClassificationOverride,
  NamespaceConfig,
  CutEdge,
  MigrationStep,
  MigrationPlan,
  CodeDiff,
  RewriteResult,
} from "./types.js";
