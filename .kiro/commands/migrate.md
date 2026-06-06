---
description: Generate full code migration for Terraform state refactoring
---

Run terraform-state-mover migration in preview mode.

1. Confirm repos and preset (reuse from prior analyze if available)
2. Check if `.tf-mover.yaml` exists; if not and naming conventions seem non-standard, offer to create one
3. Run: `pnpm cli migrate <paths...> --preset <preset> --state-dir <dir> -o ./output`
4. Show summary: resources moved, ARNs rewritten, outputs generated, files affected
5. Show key diffs from `output/diffs/migration.diff`
6. If errors occurred, explain which steps failed and what to do
7. Ask user if they want to apply (will re-run with --apply)
