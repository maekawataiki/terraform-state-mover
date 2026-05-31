# terraform-state-mover

The missing analysis layer for Terraform state refactoring.

Existing tools (`tfmigrate`, `tfsplit`, `terraform state mv`) can **execute** state operations — but they can't tell you **what to move where**. This tool does.

## What It Detects

| Anti-Pattern | Symptom | References |
|---|---|---|
| **Gatekeeper** | Central team bottlenecks IAM changes, PRs take days | [AWS Role Vending Machine](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/provision-least-privilege-iam-roles-by-deploying-a-role-vending-machine-solution.html) |
| **Terralith** | 500+ resources in one state, 10-min plans | [Masterpoint](https://masterpoint.io/blog/terralith-monolithic-terraform-architecture/), [Scalr](https://scalr.com/learning-center/the-terraform-opentofu-terralith) |
| **Spaghetti State** | `terraform_remote_state` everywhere, cascade failures | [Peloton Engineering](https://medium.com/peloton-engineering/stop-using-terraform-remote-state-blocks-2f2d5cea300b) |
| **God Module** | One module with 100+ variables, impossible to test | [Scalr](https://scalr.com/learning-center/structuring-terraform-and-opentofu-a-platform-engineers-four-part-guide-2) |
| **Count on Collection** | `count = length(...)` — item removal destroys N resources | [7 Anti-Patterns](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly) |
| **Depends On Module** | `depends_on` on a module — disables parallelism | [7 Anti-Patterns](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly) |
| **Environment Copypasta** | dev/stg/prod are drifting copy-paste directories | Terragrunt exists to solve this |
| **Provider Coupling** | Multiple provider aliases in one state | [HashiCorp Refactor](https://developer.hashicorp.com/terraform/language/state/refactor) |
| **Circular Remote State** | A→B→A remote_state cycles | — |

## How It Works

```
Scan HCL/Crossplane → Build dependency graph → Classify by namespace → Diagnose problems → Generate migration plan
```

The output is a **diagnosis report** (what's wrong, what to fix, quantified Before/After with Mermaid graphs) plus a **tfmigrate-compatible `.hcl` file** you can execute directly.

### Key Features

- **Comment/heredoc-aware parser** — ARNs in comments or `<<EOF` blocks are correctly ignored
- **Repo-based namespace grouping** — resources in the same repo are classified together (no namespace explosion)
- **Topological sort** — migration steps are ordered by dependency (move leaves first)
- **State-aware ID resolution** — provide `.tfstate.json` to get real resource IDs in import commands
- **Deduplication** — same resource is never moved or imported twice

## Quick Start

```bash
pnpm install
pnpm demo          # run all 8 example scenarios → output/
```

### On your own repos

```bash
# 1. Pull state for accurate ARN resolution
terraform -chdir=./infra-central state pull > states/infra-central.tfstate.json

# 2. Analyze
pnpm cli analyze ./infra-central ./service-api ./service-analytics \
  --preset gatekeeper \
  --state-dir ./states \
  -o ./output

# 3. Review report (includes Mermaid Before/After graphs)
cat output/report.md

# 4. Generate migration plan
pnpm cli plan ./infra-central ./service-api \
  --state-dir ./states \
  -o ./output

# 5. Dry-run with tfmigrate
tfmigrate plan output/migrate.hcl

# 6. Execute
tfmigrate apply output/migrate.hcl
terraform plan  # expect: no changes
```

## CLI Commands

```bash
# Analyze repos and generate full report
pnpm cli analyze <paths...> [--preset gatekeeper] [--state-dir ./states] [-o ./output]

# Generate migration plan only
pnpm cli plan <paths...> [--state-dir ./states] [-o ./output]

# Validate migration plan via tfmigrate dry-run
pnpm cli validate <hcl-file> [--tf-binary terraform]

# Generate report from existing graph.json
pnpm cli report <graph.json> [--preset gatekeeper]

# Generate DOT visualization files
pnpm cli visualize <paths...> [--preset gatekeeper] [--state-dir ./states]
```

### Error Handling

The CLI provides clear error messages for common issues:

```
$ pnpm cli analyze /nonexistent
Error: Directory not found: /nonexistent

$ pnpm cli analyze ./infra --preset bogus
Error: Unknown preset: "bogus". Available presets: gatekeeper
```

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

## Visualization

The report embeds Mermaid graphs (renders in GitHub/GitLab/VSCode). For large repos (30+ nodes), it shows a namespace-level summary with edge counts.

DOT files are also generated for high-quality SVGs:

```bash
dot -Tsvg output/graph-before.dot -o output/graph-before.svg
dot -Tsvg output/graph-after.dot -o output/graph-after.svg
```

- **Before**: Namespace groups, nodes show current repo. Red = hardcoded ARN, blue = remote_state.
- **After**: Same layout, all cross-namespace edges become green `var/output` interfaces.

## Output Files

| File | Purpose |
|------|---------|
| `report.md` | Diagnosis, Before/After Mermaid, migration order |
| `migrate.hcl` | [tfmigrate](https://github.com/minamijoyo/tfmigrate)-compatible multi_state migration |
| `migrate.sh` | Shell script alternative |
| `plan.json` | Machine-readable plan |
| `graph-before.dot` | Graphviz: current state with problems |
| `graph-after.dot` | Graphviz: target state |

## Examples

Bundled scenarios demonstrate each anti-pattern:

```bash
pnpm demo:gatekeeper        # centralized IAM bottleneck
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
import { generateMarkdownReport } from "terraform-state-mover/reporter/markdown-reporter";
import type { DependencyGraph, NamespaceConfig } from "terraform-state-mover/types";
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
├── parser/           HCL + Crossplane YAML scanning (comment/heredoc-aware)
├── analyzer/         Dependency graph, ARN detection, namespace classification
├── planner/          Cut finding, topological sort, migration plan, code rewriting
├── state/            Real state integration, resource ID resolution, tfmigrate executor
├── reporter/         Markdown report with diagnosis + Mermaid
├── presets/          Classification rules (gatekeeper model, extensible)
├── utils/            Error handling (CliError), logger
└── test-utils/       Test directory management (setupTestDirectory)
```

## Development

```bash
pnpm test         # 215 tests, co-located with source
pnpm lint         # type check
pnpm build        # compile
pnpm demo         # run all 8 scenarios
```

### Test Structure

Tests are co-located with their implementation (e.g., `src/parser/hcl-parser.test.ts` next to `src/parser/hcl-parser.ts`). Integration tests remain in `tests/integration/`.

### Adding a New Preset

1. Create `src/presets/{name}.ts` with a `NamespaceConfig` export
2. Add the preset name to `VALID_PRESETS` in `src/utils/error.ts`
3. Wire it in `resolvePresetConfig()` in `src/cli.ts`
4. Add tests in `src/presets/{name}.test.ts`

## License

MIT
