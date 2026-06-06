# terraform-state-mover

The missing analysis + code migration layer for Terraform state refactoring.

## What This Tool Does

1. Analyzes cross-repo Terraform dependencies (hardcoded ARNs, remote_state, provider coupling)
2. Diagnoses anti-patterns with quantified Before/After metrics
3. Generates a complete migration: HCL block moves, ARN→variable rewrites, output declarations, import/removed blocks

## Tech Stack

- TypeScript, pnpm
- Vitest for testing (co-located with source: `src/foo.test.ts`)
- No barrel exports — direct imports only

## Key Commands

```bash
pnpm test         # Run tests
pnpm lint         # Type check
pnpm build        # Compile
pnpm demo         # Run all 9 example scenarios
pnpm cli analyze  # Analyze repos
pnpm cli migrate  # Generate full migration
```

## Architecture

```
src/
├── parser/       HCL + Crossplane YAML scanning
├── analyzer/     Dependency graph, ARN detection, namespace classification
├── planner/      Cut finding, migration plan, code rewriting
├── state/        Real state integration, resource ID resolution
├── reporter/     Markdown report with diagnosis + Mermaid
├── presets/      Classification rules (gatekeeper, terralith, spaghetti)
├── utils/        Error handling, logger
└── test-utils/   Test directory management
```

## Conventions

- Tests co-located with source (`src/foo.test.ts` next to `src/foo.ts`)
- Test directories use `setupTestDirectory()` from `src/test-utils/test-directories.ts`
- Object arguments for multi-param functions
- kebab-case file names
- Use `join()` from `node:path` for all paths
- Use `formatError()` for error logging
