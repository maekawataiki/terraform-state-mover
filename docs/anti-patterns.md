# Terraform Anti-Patterns

Common IaC anti-patterns encountered in production environments, their root causes, and remediation paths.

## Detected by This Tool

### 1. Gatekeeper (Centralized IAM Bottleneck)

**Symptoms:**
- One team/repo owns all IAM resources
- Service teams submit PRs and wait days/weeks for IAM changes
- Cross-repo circular dependencies (Role PR → Resource PR → Role fix)
- Staging environments impossible to reproduce (ARNs hardcoded)

**Root cause:** Delegation was feared, so a single gatekeeper controls all identity resources.

**Remediation:** Permission Boundary delegation via a Role Vending Machine (RVM). Services create their own IAM roles within a boundary. This tool analyzes the dependency graph and generates the migration plan to move role ownership to service repos.

**References:**
- [AWS Prescriptive Guidance: Provision least-privilege IAM roles by deploying a role vending machine](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/provision-least-privilege-iam-roles-by-deploying-a-role-vending-machine-solution.html)
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)

**Detection with this tool:**
```bash
pnpm cli analyze ./infra-central ./service-* --preset gatekeeper
# Report shows: high cross-namespace edge count, IAM roles in central repo
# referenced by service repos via hardcoded ARNs
```

---

### 2. Terralith (Monolithic State)

**Symptoms:**
- 500+ resources in one state file
- `terraform plan` takes 10+ minutes
- `apply` locks the entire infrastructure for one change
- Multiple teams blocked on the same state lock

**Root cause:** Incremental growth without periodic refactoring. "It's easier to add here than create a new root module."

**Remediation:** Split by lifecycle. Resources that change together stay together; resources with different change frequencies separate.

**References:**
- [Masterpoint: Terralith — Monolithic Terraform Architecture](https://masterpoint.io/blog/terralith-monolithic-terraform-architecture/)
- [Scalr: The Terraform/OpenTofu Terralith](https://scalr.com/learning-center/the-terraform-opentofu-terralith)
- [Masterpoint: Steps to Break Up a Terralith](https://masterpoint.io/blog/steps-to-break-up-a-terralith/)
- [HashiCorp: Refactoring State](https://developer.hashicorp.com/terraform/language/state/refactor)

**Detection with this tool:**
```bash
pnpm cli analyze ./monolith-repo
# Report shows: high resource count, many namespaces in single repo,
# recommended migration order with low-dependency resources first
```

---

### 3. Spaghetti State (Cross-State Reference Tangle)

**Symptoms:**
- Heavy use of `terraform_remote_state` data sources
- Hardcoded ARNs/IDs from other state files
- `apply` order matters but isn't documented
- One state change cascades plan diffs to 5+ other states

**Root cause:** State was split but references were never properly decoupled (data sources instead of variables/outputs).

**Remediation:** Replace hardcoded references with variables. Use interface contracts (output → variable) rather than state peering.

**References:**
- [Peloton Engineering: Stop Using Terraform Remote State Blocks](https://medium.com/peloton-engineering/stop-using-terraform-remote-state-blocks-2f2d5cea300b)
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)

**Detection with this tool:**
```bash
pnpm cli analyze ./repo-a ./repo-b ./repo-c
# Report shows: cross-repo ARN dependencies table,
# code-rewriter generates diffs replacing hardcoded ARNs with variables
```

---

### 4. Count on Dynamic Collections

**Symptoms:**
- `count = length(var.list)` used to iterate over collections
- Removing an item from the middle of the list causes all subsequent resources to be destroyed and recreated
- State addresses are numeric indices (`resource[0]`, `resource[1]`) rather than meaningful keys

**Root cause:** `count` was the only iteration mechanism before Terraform 0.12.6. Old patterns persist in codebases.

**Remediation:** Use `for_each` with a map or set. Each resource is keyed by a stable identifier instead of a positional index.

**References:**
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)
- [HashiCorp: Refactoring State](https://developer.hashicorp.com/terraform/language/state/refactor) (for migrating count → for_each)

**Detection with this tool:**
```bash
pnpm cli analyze examples/count-antipattern
# Report shows: resources using count = length(...), suggests for_each
```

---

### 5. Depends On Module

**Symptoms:**
- `depends_on` used on module blocks instead of passing attributes
- Terraform treats the entire module as opaque, disabling resource-level parallelism
- Plan/apply is slower than necessary because dependencies are overly broad

**Root cause:** Developer doesn't want to thread the actual attribute through the module interface, so uses the blunt `depends_on` hammer.

**Remediation:** Pass the actual attribute that creates the dependency (e.g., `db_endpoint = aws_rds_cluster.main.endpoint`). Terraform infers the dependency from the data flow.

**References:**
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)
- [Scalr: Structuring Terraform and OpenTofu — A Platform Engineer's Four-Part Guide](https://scalr.com/learning-center/structuring-terraform-and-opentofu-a-platform-engineers-four-part-guide-2)

**Detection with this tool:**
```bash
pnpm cli analyze examples/depends-on-module
# Report shows: modules using depends_on, suggests passing actual attributes
```

---

### 6. God Module (Over-Abstracted Module)

**Symptoms:** One module with 100+ variables, complex conditionals, impossible to test.

**References:**
- [Scalr: Structuring Terraform and OpenTofu — A Platform Engineer's Four-Part Guide](https://scalr.com/learning-center/structuring-terraform-and-opentofu-a-platform-engineers-four-part-guide-2)
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)

**Detection with this tool:**
```bash
pnpm cli analyze examples/god-module
# Report shows: modules with 10+ variable assignments
```

---

### 7. Environment Copypasta (Copy-Paste Environments)

**Symptoms:** dev/stg/prod are separate directories with drifting copy-paste code. Resource names differ only by env prefix.

**References:**
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)

**Detection with this tool:**
```bash
pnpm cli analyze examples/env-copypasta/prod examples/env-copypasta/stg examples/env-copypasta/dev
# Report shows: resources with same base name differing only by env prefix/suffix
```

---

### 8. Implicit Provider Coupling (Multi-Account from Single Root)

**Symptoms:** One Terraform root deploys to 5+ AWS accounts via provider aliases. Blast radius is unlimited.

**References:**
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)

**Detection with this tool:**
```bash
pnpm cli analyze examples/cross-account/multi-account
# Report shows: multiple provider aliases in single repo
```

---

### 9. Circular Remote State

**Symptoms:** remote_state references form cycles — states cannot be applied in isolation.

**References:**
- [Peloton Engineering: Stop Using Terraform Remote State Blocks](https://medium.com/peloton-engineering/stop-using-terraform-remote-state-blocks-2f2d5cea300b)

**Detection with this tool:**
```bash
pnpm cli analyze ./repo-a ./repo-b
# Report shows: cycles in remote_state-only subgraph
```

---

## Detected by Other Tools

### 10. ClickOps Residue (Unmanaged Resources)

**Symptoms:** Resources created manually in console, never imported to Terraform.

**Tools:**
- [Firefly](https://www.firefly.ai/) — full cloud asset inventory vs IaC coverage
- [driftctl](https://github.com/snyk/driftctl) (EOL, but concept) — drift detection
- `terraform import` + [terraformer](https://github.com/GoogleCloudPlatform/terraformer) — bulk import

---

### 11. Secret Sprawl (Secrets in State)

**Symptoms:** Passwords/keys stored as Terraform variables, visible in plain text in state.

**Tools:**
- [checkov](https://www.checkov.io/) / [tfsec](https://github.com/aquasecurity/tfsec) — static analysis
- HashiCorp Vault / AWS Secrets Manager — externalize secrets
- `sensitive = true` + state encryption

---

### 12. Provider Pinning Hell (Version Debt)

**Symptoms:** Providers unpinned or 3+ major versions behind, upgrade impossible.

**Tools:**
- [Renovate](https://github.com/renovatebot/renovate) — automated dependency updates
- Dependabot — GitHub native
- Required version constraints in `versions.tf`

---

### 13. Workspace Abuse (50+ Workspaces)

**Symptoms:** One config with dozens of workspaces, each slightly different.

**Tools:**
- Terragrunt — explicit directory-per-environment
- Separate root modules per environment
- Terraform Cloud/Scalr workspace management

---

## Research Background

The fundamental principle behind correct decomposition comes from Parnas (1972):

> A module should hide a **design decision likely to change** behind a stable interface.

Applied to IaC:
- **What changes together** should live in the same state (lifecycle cohesion)
- **What changes for different reasons** should live in separate states (separation of concerns)
- **Change frequency** is the strongest signal for boundaries (SCPs: yearly, service roles: daily)

Key references:
- Parnas, "On the Criteria To Be Used in Decomposing Systems into Modules" (1972)
- D'Ambros et al., "Change Coupling Between Software Artifacts" (2006)
- Skelton & Pais, "Team Topologies" (2019)
- Fritzsch et al., "From Monolithic Systems to Microservices: A Decomposition Framework" (2019)
- [Masterpoint: Terralith — Monolithic Terraform Architecture](https://masterpoint.io/blog/terralith-monolithic-terraform-architecture/)
- [Scalr: The Terraform/OpenTofu Terralith](https://scalr.com/learning-center/the-terraform-opentofu-terralith)
- [Peloton Engineering: Stop Using Terraform Remote State Blocks](https://medium.com/peloton-engineering/stop-using-terraform-remote-state-blocks-2f2d5cea300b)
- [AWS Prescriptive Guidance: Role Vending Machine](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/provision-least-privilege-iam-roles-by-deploying-a-role-vending-machine-solution.html)
- [Scalr: Structuring Terraform and OpenTofu](https://scalr.com/learning-center/structuring-terraform-and-opentofu-a-platform-engineers-four-part-guide-2)
- [7 Terraform Anti-Patterns Quietly Killing Your Infrastructure](https://decodeops.substack.com/p/7-terraform-anti-patterns-quietly)
- [HashiCorp: Refactoring State](https://developer.hashicorp.com/terraform/language/state/refactor)
- [Masterpoint: Steps to Break Up a Terralith](https://masterpoint.io/blog/steps-to-break-up-a-terralith/)
