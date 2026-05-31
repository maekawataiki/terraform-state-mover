# Decision Guide: Is This Tool Right for Your Problem?

## Quick Diagnostic

### Structural Anti-Patterns (this tool detects and plans fixes)

| Question | Anti-Pattern | Action |
|---|---|---|
| Is one state file managing 100+ resources? | Terralith | `pnpm cli analyze` → split plan |
| Does a central team bottleneck IAM changes? | Gatekeeper | `--preset gatekeeper` → delegation plan |
| Are hardcoded ARNs linking your state files? | Spaghetti State | Detects + generates code rewrites |
| Do modules use `depends_on`? | Depends On Module | Flags modules, suggests attribute passing |
| Are resources created with `count = length(...)`? | Count on Collection | Flags resources, suggests `for_each` |
| Is one module accepting 15+ variables? | God Module | Flags modules, suggests splitting |
| Are dev/stg/prod nearly identical directories? | Env Copypasta | Detects naming pattern duplication |
| Does one state manage multiple AWS accounts? | Provider Coupling | Detects multiple provider aliases |
| Do remote_state references form cycles? | Circular Remote State | Detects cycles in remote_state edges |

### Not Our Problem (use other tools)

| Question | Tool |
|---|---|
| Are resources living outside Terraform? | Firefly, `terraform import` |
| Are secrets visible in state? | checkov, tfsec, Vault |
| Are providers/modules outdated? | Renovate, tfupdate |
| Are environments drifting from code? | Terraform Cloud drift, Scalr |

## Decision Flowchart

```
Start
  │
  ├─ State too large? ──────────────────── Yes → This tool (Terralith)
  │
  ├─ Central team blocking deployments? ── Yes → This tool (Gatekeeper)
  │
  ├─ Hardcoded ARNs across repos? ──────── Yes → This tool (Spaghetti)
  │
  ├─ `depends_on` or `count` misuse? ──── Yes → This tool (code quality)
  │
  ├─ Environments diverging? ───────────── No → Terragrunt / Terramate
  │
  ├─ Unmanaged cloud resources? ────────── No → Firefly / terraform import
  │
  └─ Already well-structured? ──────────── No action needed
```

## Typical Workflow

```
Week 1: Discovery
  pnpm cli analyze <repos> --preset gatekeeper -o ./analysis
  → Read report.md (diagnosis, Before/After, migration order)
  → Share with stakeholders

Week 2: Planning
  pnpm cli plan <repos> --state-dir ./states -o ./plan
  → Review migrate.hcl (what moves where)
  → Pick pilot service (lowest dependency count from report)

Week 3: Pilot Migration
  tfmigrate plan ./plan/migrate.hcl    # dry-run
  tfmigrate apply ./plan/migrate.hcl   # execute
  terraform plan                        # verify: no changes

Week 4+: Fleet Rollout
  → Repeat per service
  → Monitor: PRs go to service repos, not central
```

## When NOT to Use This Tool

- Your Terraform is already well-structured (few cross-repo deps, clear ownership)
- You're greenfield (design it right from the start)
- The problem is purely organizational (no one owns the migration work)
- You need runtime service dependency analysis (use service mesh observability)
