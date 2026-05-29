# Decision Guide: Is This Tool Right for Your Problem?

## Quick Diagnostic

Answer these questions about your Terraform setup:

### 1. Do you have a single repo/state that's too big?

```
plan/apply > 5 minutes?
500+ resources in one state?
Multiple teams blocked on the same state lock?
```

→ **Terralith problem.** This tool helps split it by analyzing dependencies and finding optimal cut points.

---

### 2. Is one team a bottleneck for infrastructure changes?

```
"I need an IAM role" → PR to central repo → wait days?
Cross-repo PRs required for a single feature?
CI/CD has 10+ manual approval gates?
```

→ **Gatekeeper problem.** This tool identifies what to delegate and generates the migration plan.

---

### 3. Do hardcoded ARNs/IDs link your state files?

```
grep -r "arn:aws:" *.tf returns many results?
Changing one repo breaks plan in another?
Can't create a staging environment because ARNs don't exist there?
```

→ **Spaghetti State.** This tool detects cross-repo ARN references and generates code rewrites.

---

### 4. Are your dev/stg/prod environments drifting apart?

```
Copying tfvars between directories?
"Works in dev, breaks in prod"?
```

→ **Not our problem.** Use Terragrunt or workspace-per-environment patterns.

---

### 5. Are resources living outside Terraform?

```
Console-created resources never imported?
terraform plan shows resources you don't recognize?
```

→ **Not our problem.** Use Firefly or driftctl for asset discovery, then `terraform import`.

---

### 6. Are secrets in your state file?

```
DB passwords visible in terraform.tfstate?
API keys passed as variables?
```

→ **Not our problem.** Use checkov/tfsec for detection, Vault/Secrets Manager for remediation.

---

## Decision Flowchart

```
Start
  │
  ├─ Is one state file too large? ─── Yes ──→ Use this tool (Terralith)
  │                                              └─ Then: Terragrunt for ongoing structure
  │
  ├─ Is a central team blocking ─── Yes ──→ Use this tool (Gatekeeper)
  │   service deployments?                    └─ Then: Permission Boundaries + tfmigrate
  │
  ├─ Do repos reference each ──── Yes ──→ Use this tool (Spaghetti State)
  │   other via hardcoded ARNs?              └─ Then: code-rewriter output + refactor
  │
  ├─ Are environments diverging? ── Yes ──→ Terragrunt / Terramate
  │
  ├─ Are unmanaged resources ──── Yes ──→ Firefly / terraform import
  │   in your cloud accounts?
  │
  ├─ Are providers outdated? ───── Yes ──→ Renovate / tfupdate
  │
  └─ Is your module too complex? ── Yes ──→ tflint + manual refactor
```

## Typical Engagement Workflow

```
Week 1: Discovery
  └─ pnpm cli analyze <repos> --preset gatekeeper --output-dir ./analysis
     • Read report.md → understand current state
     • Share with stakeholders

Week 2: Planning
  └─ pnpm cli plan <repos> --state-dir ./states --output-dir ./plan
     • Review migrate.hcl → agree on what moves where
     • Identify pilot service (lowest dependency count)

Week 3: Pilot Migration
  └─ tfmigrate plan ./plan/migrate.hcl   (dry-run)
     tfmigrate apply ./plan/migrate.hcl  (execute)
     terraform plan                       (verify: no changes)

Week 4+: Fleet Rollout
  └─ Repeat for remaining services, one at a time
     Monitor: new PRs should go to service repos, not central repo
```

## When NOT to Use This Tool

- Your Terraform is already well-structured (few cross-repo deps, clear ownership)
- You're greenfield (design it right from the start instead)
- The problem is purely organizational (no one owns the migration work)
- You need runtime service dependency analysis (use service mesh observability instead)
