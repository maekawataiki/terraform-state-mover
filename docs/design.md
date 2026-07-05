# Design Document

## Overview

terraform-state-mover provides the **analysis layer** for Terraform state refactoring. Existing tools (tfmigrate, terraform state mv) can execute state operations, but cannot determine **what should move where**. This tool automates that judgment.

## Design Principles

1. **Analysis + code migration** — State execution is delegated to `terraform apply` (TF 1.7+ import/removed blocks) or tfmigrate; this tool handles analysis, code rewriting, and plan generation.
2. **Repo-as-boundary** — Repositories are treated as the smallest unit of ownership. Resources in the same repo share a lifecycle.
3. **Evidence-based diagnosis** — Every detected pattern includes evidence (resource names, file paths, counts) so users can validate findings.
4. **Incremental adoption** — The tool works without state files (reduced precision but never blocked). State files improve accuracy when available.
5. **Non-destructive by default** — `migrate` command writes to `output/` unless `--apply` is explicitly used. Namespace filtering enables gradual rollout.

## Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  .tf files  │────▶│   Parser    │────▶│  Dependency Graph │────▶│  Classifier │
│  .yaml files│     │(comment-aware)    │  (nodes + edges)  │     │(repo-based) │
└─────────────┘     └─────────────┘     └──────────────────┘     └─────────────┘
                                                                        │
                         ┌──────────────────────────────────────────────┘
                         ▼
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  .tfstate   │────▶│  Cut Finder │────▶│ Migration Planner │────▶│  Reporter   │
│  (optional) │     │(cross-ns edges)   │(topo sort + dedup)│     │(Markdown+DOT)
└─────────────┘     └─────────────┘     └──────────────────┘     └─────────────┘
```

## Module Responsibilities

### parser/ — HCL & Crossplane Scanning

| File | Responsibility |
|------|---------------|
| `hcl-parser.ts` | Parse `.tf` files: block detection, ARN extraction, string literal extraction |
| `crossplane-parser.ts` | Parse Crossplane `.yaml` compositions |

**Key Design Decisions:**

- **Comment/heredoc preprocessing** — Before regex fallback runs, `preprocessHcl(content)` replaces comments (`#`, `//`, `/* */`) and heredocs (`<<EOF ... EOF`) with whitespace while preserving line numbers. This prevents false-positive ARN detection and block boundary confusion.
- **Dual-mode parser (AST primary, regex fallback)** — The primary parser uses `@cdktf/hcl2json` to produce a full HCL AST, giving accurate block boundaries, nested attribute extraction, and string literal enumeration. When hcl2json fails (malformed HCL, unsupported syntax), the parser falls back to a regex-based extractor that uses `preprocessHcl` + brace-matching to identify blocks. This ensures graceful degradation: real-world files with minor syntax issues are still partially parsed rather than completely rejected. Trade-off: the regex fallback may miss complex expressions (`for`, ternary operators, dynamic blocks).
- **Repo inference** — `scanDirectory(path, repo?)` infers the repo name from `basename(path)` when not explicitly provided.

### analyzer/ — Graph Construction and Classification

| File | Responsibility |
|------|---------------|
| `dependency-graph.ts` | Node registration, edge detection (resource refs, data refs, remote_state, cross-repo ARN), cycle detection, Graphviz output |
| `arn-detector.ts` | Extracts ARN references from parsed files and builds the consumer→definer relationship |
| `namespace-classifier.ts` | Classifies each resource into `foundation` / `platform` / `service-{name}` |

**Key Design Decisions:**

- **Repo-based grouping (default)** — `groupByRepo: true` is the default. All service-type resources in the same repository share one namespace. This prevents namespace explosion (one namespace per resource).
- **Naming convention inference** — Repo name prefixes (`service-*`, `infra-platform`, `org-*`, etc.) are auto-mapped to namespace tiers.
- **Custom classifier hook** — `NamespaceConfig.customClassifier` allows presets to inject domain-specific classification logic.
- **ARN definer heuristic** — The definer of an ARN is identified by matching resource type against the ARN service, and checking whether the resource name appears in the ARN path.

### planner/ — Migration Plan & Code Generation

| File | Responsibility |
|------|---------------|
| `hcl-migrator.ts` | Orchestrates full migration pipeline (block moves + ARN rewrites + outputs + import/removed blocks) |
| `hcl-block-mover.ts` | Extracts resource blocks from source files, generates target files, removes from source |
| `arn-rewriter.ts` | Replaces hardcoded ARNs with `var.{name}` references, generates `variables.tf` |
| `output-generator.ts` | Generates `output` blocks in producer repos for cross-repo resource interfaces |
| `moved-block-generator.ts` | Generates TF 1.7+ `import`/`removed` blocks or TF 1.5+ `moved` blocks |
| `cut-finder.ts` | Detect cross-namespace edges and assign importance scores |
| `migration-planner.ts` | Generate state_mv / import steps; topological sort; tfmigrate HCL output |
| `code-rewriter.ts` | Low-level ARN rewrite utilities (diffs, variable/datasource generation) |

**Key Design Decisions:**

- **Topological sort** — Kahn's algorithm ensures dependencies are moved before dependents. Falls back to including all nodes if cycles exist.
- **Resource ID resolution** — When `.tfstate.json` files are provided, actual ARN/ID values are resolved and embedded in `terraform import` commands. Without state files, `<RESOURCE_ID>` placeholders are used.
- **Deduplication** — A resource appearing in multiple cut edges is only moved/imported once.
- **Importance scoring** — Resources are weighted: `aws_vpc` (5) > `aws_db_instance` (4) > `aws_iam_role` (3) > `aws_lambda_function` (2). Cut edges are sorted by combined score.

### state/ — State Integration

| File | Responsibility |
|------|---------------|
| `state-reader.ts` | Parse `.tfstate.json`, build ARN maps, enrich parsed files with state-derived ARNs |
| `tfmigrate-executor.ts` | Check tfmigrate/terraform binary prerequisites, execute dry-run validation |
| `state-differ.ts` | Verify state consistency after migration |

### reporter/ — Report Generation

| File | Responsibility |
|------|---------------|
| `markdown-reporter.ts` | Diagnosis section (pattern detection), Before/After tables, Mermaid graphs, migration step summary |

**Anti-pattern Detection Logic:**

| Pattern | Detection Condition |
|---|---|
| Gatekeeper | Multiple repos exist, and one repo concentrates 2+ service-specific IAM roles |
| Terralith | One repo has 15+ resources, or 8+ resources spanning 3+ namespaces |
| Spaghetti State | Cross-repo hardcoded ARN references exist |
| God Module | Module block has 10+ variable assignments |
| Count on Collection | `count = length(...)` pattern in resource body |
| Depends On Module | Module block contains `depends_on =` |
| Environment Copypasta | Resource names differ only by env prefix/suffix (prod/stg/dev) |
| Provider Coupling | One repo has 2+ provider aliases with assume_role |
| Circular Remote State | Cycle detected in remote_state-only edge subgraph |

**Suppression Rules:**
- Gatekeeper detected → suppress Terralith (same root cause: concentration)
- Provider Coupling detected → suppress Environment Copypasta
- Orphaned Resources > 40% of total nodes → suppress (likely incomplete fixture)

### presets/ — Preset Configurations

| File | Responsibility |
|------|---------------|
| `gatekeeper.ts` | Classification rules for IAM Gatekeeper → Permission Boundary migration |

**Gatekeeper classifier logic:**
1. Match IAM role name against known suffix patterns (`_lambda_exec`, `_db_access`, `_s3_access`, etc.)
2. Strip the suffix to extract the service name
3. Normalize (underscore → hyphen) and classify as `service-{normalized-name}`

### utils/ — Utilities

| File | Responsibility |
|------|---------------|
| `error.ts` | `CliError` class, `formatError()`, validation functions (`validateDirectory`, `validatePreset`, `validateFile`, `parseJson`) |
| `logger.ts` | Simple logger that suppresses output when `NODE_ENV=test` |

### CLI (cli.ts)

- **Global error handler** — All actions are wrapped in `try-catch`. `CliError` instances display as `Error: {message}` without stack traces. Unknown errors display as `Unexpected error:`.
- **No process.exit()** — Only `process.exitCode = 1` is set. This prevents killing the process when the CLI module is imported programmatically.
- **Validation first** — Every action validates paths and presets before performing work. Failures produce immediate, clear messages.

## Type System

```typescript
// Core data model flow (src/types.ts)
TerraformBlock  → ParsedFile     (parser output)
GraphNode       → DependencyGraph (analyzer output)
CutEdge         → MigrationPlan  (planner output)
```

All types are centralized in `src/types.ts`. This prevents circular dependencies between modules and makes the impact of type changes immediately visible.

## Extension Points

| What | How |
|------|-----|
| New preset | Create `src/presets/{name}.ts`, add to `VALID_PRESETS` in `src/utils/error.ts` |
| New anti-pattern | Add detection logic in `markdown-reporter.ts` → `detectPatterns()` |
| New resource type | Add to `PLATFORM_TYPES` or `SERVICE_TYPES` in `namespace-classifier.ts` |
| Custom classification | Pass a function via `NamespaceConfig.customClassifier` |
| New parser (Pulumi, etc.) | Create `src/parser/{name}-parser.ts` returning `ParsedFile[]` |

## Trade-offs & Known Limitations

| Decision | Trade-off |
|----------|-----------|
| Regex-based HCL parser | ✅ Zero external deps / ❌ Cannot fully parse complex HCL expressions |
| Centralized types.ts | ✅ Clear impact of type changes / ❌ File may grow over time |
| Repo-name-based namespace inference | ✅ Works without configuration / ❌ Requires manual overrides for non-standard naming |
| ARN definer heuristic | ✅ Works without state / ❌ Ambiguous when same ARN appears in multiple repos |
| State-dependent import IDs | ✅ Accurate import commands / ❌ Stale state files produce incorrect IDs |

## Future Considerations

- **Interactive mode** — CLI wizard for reviewing and adjusting namespace classifications
- **CI integration** — GitHub Actions / GitLab CI to post diagnosis reports as PR comments
- **Incremental analysis** — Cache the dependency graph and re-analyze only changed files
- **PR generation** — Auto-create PRs in source/target repos after `--apply`
- **for_each rewrite** — Automate `count = length(...)` → `for_each` transformation
- **Multi-backend state** — Support S3/GCS/Azure remote state fetching directly (currently generates pull/push scripts)
