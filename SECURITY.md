# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in terraform-state-mover, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: [security contact - to be configured]

Or use GitHub's private vulnerability reporting:
https://github.com/tmae/terraform-state-mover/security/advisories/new

## Security Considerations

This tool reads and processes Terraform state files which may contain:
- Database passwords and connection strings
- API keys and tokens
- Private keys and certificates

### Mitigations

- State file contents are never logged or included in error messages
- Sensitive attributes are masked in any output (see `src/state/state-masker.ts`)
- The tool does NOT transmit any data over the network
- Generated migration files contain resource addresses only, not secret values

### Supply Chain

- npm provenance is enabled for published packages
- CodeQL static analysis runs on every PR
- gitleaks scans for accidentally committed secrets
- Dependencies are pinned to exact versions

## Security Best Practices for Users

1. **Never commit `.tfstate` files** to version control
2. **Review generated diffs** before applying migrations
3. **Use `--write` explicitly** — the tool defaults to dry-run (no destructive action without opt-in)
4. **Run in CI with read-only access** to state files when possible
