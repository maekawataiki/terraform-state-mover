# terraform-state-mover

The missing analysis layer for Terraform state refactoring.

Existing tools (`tfmigrate`, `tfsplit`, `terraform state mv`) can **execute** state operations — but they can't tell you **what to move where**. This tool does.

## What It Solves

| Anti-Pattern | Symptom | Detection |
|---|---|---|
| **Gatekeeper** | Central team bottlenecks IAM changes, PRs take days | Cross-repo ARN hardcoding |
| **Terralith** | 500+ resources in one state, 10-min plans | Single repo/state with multiple namespaces |
| **Spaghetti State** | `terraform_remote_state` everywhere, cascade failures | Cross-state references |

## How It Works

```
Scan HCL/Crossplane → Build dependency graph → Classify by namespace → Diagnose problems → Generate migration plan
```

The output is a **diagnosis report** (what's wrong, what to fix, quantified Before/After) plus a **tfmigrate-compatible `.hcl` file** you can execute directly.

## Quick Start

```bash
pnpm install
pnpm demo          # run bundled example scenarios → output/
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

# 3. Review report
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

## Example Report Output

```markdown
## Diagnosis

🔴 Gatekeeper — 4 service-specific IAM roles centralized in `infra-central`
🔴 Spaghetti State — 3 hardcoded ARN references cross repo boundaries
🟡 Terralith — `infra-central` contains 8 resources spanning 6 namespaces

### After Migration
| Metric              | Before | After |
|---------------------|--------|-------|
| Max blast radius    | 14     | 3     |
| Hardcoded ARNs      | 3      | 0     |
| Deploy flow         | Multi-repo PR | 1 PR, 1 CI run |
```

## Visualization

```bash
pnpm cli visualize ./infra-central ./service-api \
  --preset gatekeeper --state-dir ./states -o ./output

# Convert to SVG
dot -Tsvg output/graph-before.dot -o output/graph-before.svg
dot -Tsvg output/graph-after.dot -o output/graph-after.svg
```

- **Before**: Resources grouped by namespace, annotated with current repo. Problem edges in red (hardcoded ARN) / blue (remote_state).
- **After**: Same layout, edges replaced with clean interfaces (green, var/output).

## Output Files

| File | Purpose |
|------|---------|
| `report.md` | Diagnosis, impact, Before/After comparison, migration order |
| `migrate.hcl` | [tfmigrate](https://github.com/minamijoyo/tfmigrate)-compatible multi_state migration |
| `migrate.sh` | Shell script alternative |
| `plan.json` | Machine-readable plan |
| `graph-before.dot` | Graphviz: current state with problems |
| `graph-after.dot` | Graphviz: target state |

## Examples

Bundled scenarios demonstrate each anti-pattern:

```bash
pnpm demo:gatekeeper     # centralized IAM bottleneck
pnpm demo:terralith      # monolithic 33-resource state
pnpm demo:spaghetti      # cross-state remote_state + ARN tangle
pnpm demo:cross-account  # multi-account provider alias mess
```

## Documentation

- [Anti-Patterns](docs/anti-patterns.md) — 10 IaC anti-patterns, root causes, and which tool solves each
- [Complementary Tools](docs/complementary-tools.md) — Integration with tfmigrate, tflint, Terragrunt, etc.
- [Decision Guide](docs/decision-guide.md) — Is this the right tool for your problem?

## Architecture

```
src/
├── parser/       HCL + Crossplane YAML scanning
├── analyzer/     Dependency graph, ARN detection, namespace classification
├── planner/      Cut finding, migration plan, code rewriting
├── state/        Real state integration, tfmigrate executor, verification
├── reporter/     Markdown report with diagnosis
└── presets/      Classification rules (gatekeeper model, extensible)
```

## Development

```bash
pnpm test         # 138 tests, 14 files
pnpm lint         # type check
pnpm build        # compile
```

## License

MIT
