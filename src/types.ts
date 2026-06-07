export interface TerraformBlock {
  type: "resource" | "data" | "variable" | "locals" | "module";
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

export interface ArnReference {
  arn: string;
  service: string;
  filePath: string;
  repo: string;
  sourceBlock?: TerraformBlock;
  resolved: boolean;
  definingResource?: GraphNode;
}

export interface GraphNode {
  id: string;
  type: "resource" | "data";
  resourceType: string;
  name: string;
  repo: string;
  filePath: string;
  namespace?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "reference" | "arn" | "remote_state" | "unresolved";
  label?: string;
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface SerializedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Namespace = "foundation" | "platform" | `service-${string}`;

export interface ClassificationOverride {
  resourceType?: string;
  resourceName?: string;
  namespace: Namespace;
}

export interface NamespaceConfig {
  overrides?: ClassificationOverride[];
  customClassifier?: (node: GraphNode) => Namespace | null;
  groupByRepo?: boolean;
  /** Custom importance scores for cut-finder edge prioritization (resource_type → score). */
  importanceScores?: Record<string, number>;
}

export interface CutEdge {
  edge: GraphEdge;
  fromNamespace: Namespace;
  toNamespace: Namespace;
  score: number;
}

export interface MigrationStep {
  type: "state_mv" | "import" | "code_rewrite" | "verify";
  command?: string;
  description: string;
  resource?: string;
  targetRepo?: string;
}

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
  block: TerraformBlock;
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
