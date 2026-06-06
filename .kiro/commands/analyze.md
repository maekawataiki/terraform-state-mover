---
description: Analyze Terraform repos for anti-patterns and cross-state dependencies
---

Run terraform-state-mover analysis on the specified repos.

1. Determine which repos to scan (ask user if not clear from context)
2. Select appropriate preset based on symptoms:
   - Monolithic state → terralith
   - Remote state / ARN coupling → spaghetti
   - Centralized IAM → gatekeeper
3. Run: `pnpm cli analyze <paths...> --preset <preset> -o ./output`
4. Read and summarize `output/report.md`
5. If parser warnings exist, inform user about potential blind spots
6. Suggest next steps (migrate, or configure if naming conventions don't match)
