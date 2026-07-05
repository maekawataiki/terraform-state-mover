# terraform-state-mover

## 0.1.0

### Features

- Initial release
- Analyze cross-repo Terraform dependencies (hardcoded ARNs, remote_state, provider coupling)
- Detect 9 IaC anti-patterns with quantified Before/After metrics
- Generate complete migration: HCL block moves, ARN→variable rewrites, import/removed blocks
- Presets: gatekeeper, terralith, spaghetti, cross-account, data-layer
- Migration modes: import (TF 1.7+), moved (TF 1.5+), tfmigrate (legacy)
- Crossplane YAML scanning support
- Rollback generation with real resource IDs
- Remote backend compatible (S3, TF Cloud, GCS)
- Property-based testing with fast-check
- OSS module fuzzing (583 files, zero crashes)
