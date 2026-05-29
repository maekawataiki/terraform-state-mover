export interface TerraformBlock {
  type: "resource" | "data" | "variable" | "locals" | "module";
  resourceType: string;
  name: string;
  body: string;
  stringLiterals: string[];
  arns: string[];
  filePath: string;
  repo: string;
}

export interface ParsedFile {
  filePath: string;
  repo: string;
  blocks: TerraformBlock[];
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
  type: "reference" | "arn" | "remote_state";
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
}
