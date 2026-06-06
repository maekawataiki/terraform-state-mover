---
description: Generate .tf-mover.yaml config file from repo naming conventions
---

Help the user create a classification config for their repos.

1. List the repo directories available (from arguments or cwd)
2. Analyze repo naming patterns
3. Ask user which layer each ambiguous repo belongs to (foundation/platform/service)
4. Generate `.tf-mover.yaml` with:
   - Inferred patterns from naming conventions
   - Explicit overrides for ambiguous repos
   - Sensible default
5. Write to `.tf-mover.yaml` in the working directory
6. Suggest running `pnpm cli analyze ... --config .tf-mover.yaml` to validate
