---
name: tf-state-mover
description: Orchestrates Terraform state refactoring - dependency analysis, anti-pattern detection, and automated code migration.
---

# terraform-state-mover — IaC Refactoring Skill

Orchestrates Terraform state refactoring: dependency analysis, anti-pattern detection, and automated code migration.

## When to Use

- User wants to split a monolithic Terraform state (Terralith pattern)
- User has cross-repo dependencies via `terraform_remote_state` or hardcoded ARNs (Spaghetti pattern)
- User has centralized IAM roles that should be distributed (Gatekeeper pattern)
- User asks about Terraform anti-patterns or state migration planning
- User wants to generate `import`/`removed` blocks or tfmigrate files

## Prerequisites

- Terraform repos accessible locally (or cloned)
- Optional: `.tfstate.json` files for accurate resource ID resolution
- Optional: `.tf-mover.yaml` for custom classification rules

## Workflow

### 1. Analyze

Scan repos, build dependency graph, detect anti-patterns:

```bash
pnpm cli analyze <repo-paths...> --preset <gatekeeper|terralith|spaghetti> --state-dir ./states -o ./output
```

Output: `report.md`, `graph-before.dot`, `graph-after.dot`, `plan.json`

### 2. Configure (if needed)

If the user's repo naming conventions don't match defaults, help them create a `.tf-mover.yaml`:

```yaml
classification:
  patterns:
    - match: "^team-(.+)"
      namespace: "service-$1"
  explicit:
    shared-infra: "platform"
  default: "service-{repo}"
```

Then run with `--config .tf-mover.yaml`.

### 3. Migrate

Generate full code migration (HCL block moves, ARN rewrites, outputs, import/removed blocks):

```bash
pnpm cli migrate <repo-paths...> --preset <name> --state-dir ./states -o ./output
```

Output: `migrate-plan.json`, `migrated/` (file tree), `diffs/migration.diff`, `migrate.hcl`

### 4. Review & Apply

- Review diffs in `output/diffs/migration.diff`
- Preview migrated files in `output/migrated/`
- Apply when ready: `pnpm cli migrate ... --apply`
- Run `terraform plan` in both repos (expect no changes)

## Preset Selection Guide

| Symptom | Preset |
|---|---|
| One state with 100+ resources, 10-min plans | `terralith` |
| `terraform_remote_state` everywhere, cascade failures | `spaghetti` |
| Central team bottlenecks IAM changes | `gatekeeper` |

## Error Handling

- If parser warnings appear (dynamic blocks, templatefile, conditional ARNs), inform the user that some dependencies may not be detected
- If migration steps partially fail, show what succeeded and what needs manual attention
- If repos don't match any naming convention, suggest creating `.tf-mover.yaml`

## Key Behaviors

- Always run in preview mode first (no `--apply`). Show diffs before applying.
- Use `--namespace <ns>` for incremental migration (one service at a time)
- When user's naming conventions are unclear, ask rather than guess
- Explain Before/After metrics (blast radius, hardcoded ARNs, deploy flow)
