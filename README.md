# terraform-state-mover

The missing **analysis + code migration** layer for Terraform state refactoring.

Existing tools (`tfmigrate`, `tfsplit`, `terraform state mv`) can **execute** state operations — but they can't tell you **what to move where**, and they don't touch your HCL code. This tool does both.

## What It Does

1. **Analyzes** cross-repo Terraform dependencies (hardcoded ARNs, remote_state, provider coupling)
2. **Diagnoses** anti-patterns with quantified Before/After metrics
3. **Generates a complete migration**: HCL block moves, ARN→variable rewrites, output declarations, import/removed blocks — not just state operations

Also supports **Crossplane** (Kubernetes-native IaC): scans `.yaml` manifests for Crossplane Managed Resources and ProviderConfigs, integrating them into the same dependency graph. Use `--include-crossplane` with the `analyze` command.

## What It Detects (and Fixes)

| Anti-Pattern | Symptom | Fix | References |
|---|---|---|---|
| **Gatekeeper** | Central team bottlenecks IAM changes, PRs take days | Move service-specific roles to owning repos → `import`/`removed` blocks | [AWS Role Vending Machine](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/provision-least-privilege-iam-roles-by-deploying-a-role-vending-machine-solution.html) |
| **Terralith** | 500+ resources in one state, 10-min plans | Split by namespace → HCL block moves + state migration | [Masterpoint](https://masterpoint.io/blog/terralith-monolithic-terraform-architecture/), [Scalr](https://scalr.com/learning-center/the-terraform-opentofu-terralith) |
| **Spaghetti State** | `terraform_remote_state` everywhere, cascade failures | Replace hardcoded ARNs → `var`/`output` interface | [Peloton Engineering](https://medium.com/peloton-engineering/stop-using-terraform-remote-state-blocks-2f2d5cea300b) |
| **God Module** | One module with 100+ variables, impossible to test | Decompose into focused modules (detection only) | [Scalr](https://scalr.com/learning-center/structuring-terraform-and-opentofu-a-platform-engineers-four-part-guide-2) |
| **Count on Collection** | `count = length(...)` — item removal destroys N resources | Rewrite to `for_each` (detection only) | [7 Anti-Patterns](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly) |
| **Depends On Module** | `depends_on` on a module — disables parallelism | Remove and use explicit data references (detection only) | [7 Anti-Patterns](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly) |
| **Environment Copypasta** | dev/stg/prod are drifting copy-paste directories | Consolidate with Terragrunt/workspaces (detection only) | Terragrunt exists to solve this |
| **Provider Coupling** | Multiple provider aliases in one state | Separate by provider boundary → cross-state migration | [HashiCorp Refactor](https://developer.hashicorp.com/terraform/language/state/refactor) |
| **Circular Remote State** | A→B→A remote_state cycles | Break cycle via shared outputs layer (detection only) | — |

> **Automated fix** = this tool generates the full migration. **Detection only** = flagged in report with guidance, manual refactoring needed.

## Quick Start

```bash
pnpm install
pnpm demo          # run all 9 example scenarios → output/
```

### On your own repos

```bash
# 1. Pull state for accurate resource ID resolution
terraform -chdir=./infra-central state pull > states/infra-central.tfstate.json

# 2. Analyze and generate full migration (non-destructive, writes to output/)
pnpm cli migrate ./infra-central ./service-api ./service-analytics \
  --preset gatekeeper \
  --state-dir ./states \
  -o ./output

# 3. Review the generated migration
cat output/migrate-plan.json        # full plan details
cat output/diffs/migration.diff     # unified diff of all changes
ls output/migrated/                 # file tree after migration

# 4. Apply when ready (writes to source repos)
pnpm cli migrate ./infra-central ./service-api ./service-analytics \
  --preset gatekeeper \
  --state-dir ./states \
  --apply

# 5. Run terraform in both repos
cd service-api && terraform apply    # imports resource into new state
cd infra-central && terraform apply  # removes resource from old state (no destroy)

# 6. Verify
terraform plan  # expect: no changes in both repos
```

### Incremental Migration

Migrate one namespace at a time to reduce risk:

```bash
pnpm cli migrate ./infra-central ./service-orders \
  --preset gatekeeper --namespace service-orders \
  --state-dir ./states -o output/phase1

# Verify, then next namespace
pnpm cli migrate ./infra-central ./service-payments \
  --preset gatekeeper --namespace service-payments \
  --state-dir ./states -o output/phase2
```

> **Note**: State files are only needed for accurate `import` block generation (resolving resource IDs). Analysis and code migration work without state files — you'll just get placeholder IDs in import blocks.

## CLI Commands

```bash
# Full code migration (recommended)
pnpm cli migrate <paths...> [options]
  --preset <name>        Preset config (gatekeeper, terralith, spaghetti)
  --state-dir <dir>      Directory with <repo>.tfstate.json files
  --namespace <ns>       Only migrate edges involving this namespace
  --mode <mode>          import (TF 1.7+, default), moved (TF 1.5+), tfmigrate (legacy)
  --apply                Write migration files to source repos (does NOT run terraform apply)
  --validate             Run terraform validate on output
  -o <dir>               Output directory for generated files

# Analyze repos and generate diagnosis report
pnpm cli analyze <paths...> [--preset gatekeeper] [--state-dir ./states] [-o ./output]

# Generate migration plan only (state operations)
pnpm cli plan <paths...> [--state-dir ./states] [-o ./output]

# Validate migration plan via tfmigrate dry-run
pnpm cli validate <hcl-file> [--tf-binary terraform]

# Generate report from existing graph.json
pnpm cli report <graph.json> [--preset gatekeeper]

# Generate DOT visualization files
pnpm cli visualize <paths...> [--preset gatekeeper] [--state-dir ./states]
```

### Migration Modes

| Mode | TF Version | What It Generates | Use Case |
|---|---|---|---|
| `import` (default) | ≥ 1.7 | `imports.tf` + `removed.tf` | Cross-state migration without tfmigrate |
| `moved` | ≥ 1.5 | `moved.tf` | Same-state address renames |
| `tfmigrate` | Any | `migrate.hcl` only | Legacy TF, or cross-state with tfmigrate |

## What Gets Generated

### `migrate` command (`-o output/`)

| File | Purpose |
|------|---------|
| `migrate-plan.json` | Full migration plan (moves, rewrites, outputs, imports) |
| `migrate.hcl` | tfmigrate-compatible multi_state migration |
| `migrated/` | Complete file tree after migration (preview) |
| `diffs/migration.diff` | Unified diff of all file changes |
| `rollback/` | Reverse migration plan (if needed) |

### `analyze` command (`-o output/`)

| File | Purpose |
|------|---------|
| `report.md` | Diagnosis, Before/After Mermaid, migration order |
| `migrate.hcl` | tfmigrate-compatible multi_state migration |
| `migrate.sh` | Shell script alternative |
| `plan.json` | Machine-readable plan |
| `graph-before.dot` / `graph-after.dot` | Graphviz DOT files |

## Example Report Output

```markdown
## Diagnosis

🔴 Gatekeeper — 4 service-specific IAM roles centralized in `infra-central`
🔴 Spaghetti State — 3 hardcoded ARN references cross repo boundaries
🟡 Count on Dynamic Collection — `aws_iam_user.team` uses count = length(...)

### After Migration
| Metric              | Before | After |
|---------------------|--------|-------|
| Max blast radius    | 14     | 3     |
| Hardcoded ARNs      | 3      | 0     |
| Deploy flow         | Multi-repo PR | 1 PR, 1 CI run |
```

## Examples

Bundled scenarios demonstrate each anti-pattern:

```bash
pnpm demo:gatekeeper        # centralized IAM bottleneck (small)
pnpm demo:gatekeeper-large  # centralized IAM bottleneck (7 services)
pnpm demo:terralith         # monolithic 33-resource state
pnpm demo:spaghetti         # cross-state remote_state + ARN tangle
pnpm demo:cross-account     # multi-account provider alias mess
pnpm demo:god-module        # over-abstracted module
pnpm demo:env-copypasta     # copy-paste environments
pnpm demo:count-antipattern # count = length(...) trap
pnpm demo:depends-on-module # depends_on on module
```

## Documentation

- [Design](docs/design.md) — Architecture, data flow, module responsibilities, design decisions
- [Anti-Patterns](docs/anti-patterns.md) — 13 IaC anti-patterns with citations, which this tool detects vs other tools
- [Complementary Tools](docs/complementary-tools.md) — Integration with tfmigrate, tflint, Terragrunt, etc.
- [Decision Guide](docs/decision-guide.md) — Is this the right tool for your problem?

## Library Usage

Import directly from specific modules (no barrel exports):

```typescript
import { scanDirectory, parseHcl } from "terraform-state-mover/parser/hcl-parser";
import { buildGraph } from "terraform-state-mover/analyzer/dependency-graph";
import { classifyGraph } from "terraform-state-mover/analyzer/namespace-classifier";
import { createMigrationPlan } from "terraform-state-mover/planner/migration-planner";
import { planMigration, applyMigration } from "terraform-state-mover/planner/hcl-migrator";
import { generateMarkdownReport } from "terraform-state-mover/reporter/markdown-reporter";
import type { DependencyGraph, NamespaceConfig, MigrateResult } from "terraform-state-mover/types";
```

### Namespace Configuration

By default, resources are grouped by repository name (`groupByRepo: true`). Repo naming conventions are auto-detected:

| Repo Prefix | Namespace |
|---|---|
| `infra-foundation`, `org-*`, `scp-*` | `foundation` |
| `infra-platform`, `infra-shared`, `platform-*` | `platform` |
| `service-*`, `svc-*`, `app-*` | `service-{suffix}` |
| Other | `service-{repo-name}` |

To use per-resource naming (legacy behavior):

```typescript
const config: NamespaceConfig = { groupByRepo: false };
```

## Architecture

```
src/
├── commands/         CLI command handlers (one file per command)
│   ├── analyze.ts, migrate.ts, plan.ts, report.ts, validate.ts, visualize.ts
│   └── shared.ts            Preset resolution, state loading, parser warnings
├── parser/           HCL + Crossplane YAML scanning (comment/heredoc-aware, AST + regex)
├── analyzer/         Dependency graph, ARN detection, namespace classification
├── planner/          Cut finding, topological sort, migration plan, code rewriting
│   ├── hcl-migrator.ts         Orchestrates full migration pipeline
│   ├── hcl-block-mover.ts      Extracts/moves resource blocks between repos
│   ├── arn-rewriter.ts         Rewrites hardcoded ARNs → variable references
│   ├── output-generator.ts     Generates output blocks for cross-repo interfaces
│   ├── moved-block-generator.ts  Generates import/removed/moved blocks
│   ├── migration-planner.ts    State-level migration planning + tfmigrate HCL
│   ├── code-rewriter.ts        Low-level ARN rewrite utilities
│   └── cut-finder.ts           Cross-namespace edge detection
├── reporter/         Markdown report + visualization generation
│   ├── markdown-reporter.ts    Report orchestration + public interface
│   ├── detect-patterns.ts      Anti-pattern detection logic
│   ├── mermaid-graphs.ts       Mermaid diagram generation
│   └── graphviz.ts             Graphviz DOT generation (before/after views)
├── state/            State integration, resource ID resolution, tfmigrate executor
├── config/           .tf-mover.yaml loader + namespace config builder
├── presets/          Classification rules (gatekeeper, terralith, spaghetti)
├── utils/            Error handling (CliError), logger
└── cli.ts            Entry point (command registration only)
```

## AI Agent Integration (Claude Code / Kiro)

This project ships with built-in skills and slash commands for AI-assisted workflows.

The `.claude/` directory is auto-discovered by Claude Code, and `.kiro/` by Kiro CLI. No extra configuration needed.

| Command | What It Does |
|---|---|
| `/analyze` | Scan repos, detect anti-patterns, generate diagnosis report |
| `/migrate` | Full code migration with preview diffs |
| `/init-config` | Generate `.tf-mover.yaml` from your repo naming conventions |

The `tf-state-mover` skill activates automatically when you describe a Terraform refactoring problem.

## Development

```bash
pnpm test         # 423 tests, co-located with source
pnpm lint         # tsc --noEmit + ESLint
pnpm build        # compile
pnpm demo         # run all 9 scenarios
```

Tests are co-located with their implementation (e.g., `src/parser/hcl-parser.test.ts` next to `src/parser/hcl-parser.ts`). Integration tests remain in `tests/integration/`.

### Adding a New Preset

1. Create `src/presets/{name}.ts` with a `NamespaceConfig` export
2. Add the preset name to `VALID_PRESETS` in `src/utils/error.ts`
3. Wire it in `resolvePresetConfig()` in `src/commands/shared.ts`
4. Add tests in `src/presets/{name}.test.ts`

## License

MIT
