# Complementary Tools

Tools that work alongside `terraform-state-mover` for comprehensive IaC management.

## Migration & Refactoring (Same Layer)

| Tool | What It Does | How It Complements Us |
|------|-------------|----------------------|
| [tfmigrate](https://github.com/minamijoyo/tfmigrate) | Executes state mv/rm/import as code (GitOps) | We **generate** the migration file; tfmigrate **executes** it (TF < 1.7 only) |
| [tfsplit](https://github.com/jberkenbilt/tfsplit) | Splits state into directory structure for manual rearrangement | Alternative execution path for simple cases |
| Terraform 1.7+ `import`/`removed` blocks | Declarative state operations in HCL | **Our default mode** — we generate these blocks, `terraform apply` runs them |

### Recommended Pipeline

**TF 1.7+ (recommended — no tfmigrate needed):**

```
terraform-state-mover migrate --mode import -o output/
                                              ↓
          Review: output/migrated/, output/diffs/migration.diff
                                              ↓
terraform-state-mover migrate --mode import --apply
                                              ↓
    target repo: terraform apply (imports.tf brings resource in)
                                              ↓
    source repo: terraform apply (removed.tf drops resource, no destroy)
                                              ↓
    both repos: terraform plan (verify: no changes)
```

**Legacy (TF < 1.7 — requires tfmigrate):**

```
terraform-state-mover migrate --mode tfmigrate -o output/
                                              ↓
                                    tfmigrate plan output/migrate.hcl (dry-run)
                                              ↓
                                    tfmigrate apply output/migrate.hcl (execute)
                                              ↓
                                    terraform plan (verify: no changes)
```

---

## Static Analysis & Linting

| Tool | Purpose | When to Use |
|------|---------|-------------|
| [tflint](https://github.com/terraform-linters/tflint) | HCL linting, provider-specific rules | CI/CD on every PR |
| [checkov](https://www.checkov.io/) | Security & compliance scanning | Pre-commit + CI |
| [tfsec](https://github.com/aquasecurity/tfsec) | Security-focused static analysis | CI/CD |
| [OPA/Conftest](https://www.conftest.dev/) | Custom policy enforcement | Guardrails for what resources can be created |

---

## Drift Detection

| Tool | Purpose | When to Use |
|------|---------|-------------|
| [Firefly](https://www.firefly.ai/) | Full cloud inventory vs IaC coverage | Identifying ClickOps residue |
| Terraform Cloud drift detection | Periodic plan to detect out-of-band changes | Ongoing governance |
| [Scalr](https://scalr.com/) | Remote operations + drift alerts | TFC alternative with built-in drift |

---

## Visualization

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `terraform graph` + Graphviz | Single-state dependency graph | Quick local visualization |
| [inframap](https://github.com/cycloidio/inframap) | Provider-aware resource visualization | Understanding topology |
| [Rover](https://github.com/im2nguyen/rover) | Interactive Terraform visualization | Presentations, team alignment |
| **Our tool** (`pnpm cli visualize`) | Cross-repo dependency graph with namespace coloring | Migration planning |

---

## Dependency Management

| Tool | Purpose | When to Use |
|------|---------|-------------|
| [Renovate](https://github.com/renovatebot/renovate) | Automated provider/module version updates | Preventing version debt |
| [Dependabot](https://github.com/dependabot) | GitHub-native dependency updates | Simpler alternative to Renovate |
| [tfupdate](https://github.com/minamijoyo/tfupdate) | Bulk update Terraform version constraints | Major version migrations |

---

## Multi-Environment & Orchestration

| Tool | Purpose | When to Use |
|------|---------|-------------|
| [Terragrunt](https://terragrunt.gruntwork.io/) | DRY configs, dependency orchestration, stacks | Ongoing structure after migration |
| [Terramate](https://terramate.io/) | Stack orchestration, change detection | Alternative to Terragrunt |
| [Spacelift](https://spacelift.io/) | CI/CD for IaC with dependency tracking | Managed platform |
| [Scalr](https://scalr.com/) | Drop-in TFC replacement | Remote operations |

---

## Service Catalog & Ownership

| Tool | Purpose | How We Consume It |
|------|---------|------------------|
| [Backstage](https://backstage.io/) | Service catalog, ownership mapping | Import service list → namespace classification |
| Kubernetes RBAC/namespaces | Service boundary definition | Map K8s namespaces to Terraform namespaces |
| CODEOWNERS files | Repo ownership | Infer team → service mapping |

---

## What We Don't Replace

This tool is specifically for **analyzing cross-repo IaC dependencies, generating migration plans, and rewriting HCL code**. It does not replace:

- **Linters** (tflint, checkov) — we don't check code quality or security
- **Drift detection** (Firefly, driftctl) — we don't compare state vs reality
- **CI/CD platforms** (Spacelift, TFC, Scalr) — we don't run plan/apply workflows
- **Secret management** (Vault, Secrets Manager) — we don't handle credentials
- **Orchestration** (Terragrunt, Terramate) — we don't manage apply order long-term
- **State execution** — we generate `import`/`removed` blocks but `terraform apply` runs them

We **complement** all of these by providing the analysis + code rewriting layer that tells you **what to move where** and generates the complete file changes.
