# Troubleshooting

Common issues and solutions when using terraform-state-mover.

## Parser Failures

### "Could not parse HCL file" / Wasm parser error

**Symptom**: Warning message about falling back to regex parser, or a file is skipped entirely.

**Cause**: The `@cdktf/hcl2json` Wasm parser cannot handle certain HCL constructs (extremely large files, non-UTF8 encoding, or corrupted files).

**Solutions**:
1. Check the file is valid HCL: `terraform fmt -check <file>`
2. If the file uses advanced features (dynamic blocks with complex expressions), the regex fallback will handle basic parsing. Check `parserWarnings` in `--json` output for details.
3. For files in `.tf.json` format: convert to `.tf` (HCL) first.
4. If you're on a restricted platform (musl Alpine, older ARM): ensure the Wasm runtime is available. Try running with `--verbose` to see initialization errors.

### "Symlink loop detected"

**Symptom**: Parser skips a directory with a symlink loop warning.

**Solution**: Remove circular symlinks in your Terraform repo, or exclude the directory from scanning.

## State File Issues

### "Failed to parse state JSON"

**Symptom**: Error when using `--state-dir`.

**Solutions**:
1. Ensure state files are named `<repo-name>.tfstate.json` (matching the directory name passed to the CLI)
2. Generate with: `terraform -chdir=<repo> state pull > states/<repo-name>.tfstate.json`
3. State files must be valid JSON. Verify with: `jq . states/<repo>.tfstate.json`

### "<RESOURCE_ID>" placeholders in import blocks

**Symptom**: Generated `imports.tf` contains `<RESOURCE_ID>` instead of actual IDs.

**Cause**: No state file was provided for the source repo. Without state, resource IDs cannot be resolved.

**Solution**: Pull state and provide via `--state-dir`:
```bash
terraform -chdir=./infra-central state pull > states/infra-central.tfstate.json
pnpm cli migrate ... --state-dir ./states
```

## Large Repositories

### Slow analysis (>10s)

**Cause**: Very large monorepos with 1000+ resources.

**Solutions**:
1. Use `--namespace <ns>` to focus on a subset
2. Split analysis into phases: analyze one service at a time
3. Check if non-Terraform files are being scanned (symlinks to node_modules, etc.)

### Out of memory

**Symptom**: Node.js heap allocation failure on very large repos.

**Solution**: Increase Node.js memory limit:
```bash
NODE_OPTIONS="--max-old-space-size=4096" pnpm cli analyze ...
```

## Remote Backend Authentication

### Cannot pull state from remote backend

This tool does NOT pull state from remote backends automatically. You must provide state files manually:

```bash
# For S3 backend
terraform -chdir=./my-repo state pull > states/my-repo.tfstate.json

# For Terraform Cloud
terraform -chdir=./my-repo state pull > states/my-repo.tfstate.json
# (Requires TFC API token in ~/.terraform.d/credentials.tfrc.json)

# For multiple workspaces
for repo in infra-central service-api service-payments; do
  terraform -chdir=./$repo state pull > states/$repo.tfstate.json
done
```

## CI Integration Issues

### "exit code 1" in CI with --strict

**Expected behavior**: `--strict` mode exits 1 when anti-patterns are detected. This is intentional for CI gating.

To use in CI without failing the build:
```bash
tf-state-mover analyze ./repos --json | jq '.summary'
# Parse the JSON output and make your own gating decisions
```

### "command not found: tf-state-mover"

Ensure the package is installed globally or use npx:
```bash
npx terraform-state-mover analyze ...
```

## Migration Issues

### "Migration write failed — rolling back"

**Symptom**: The `--write` flag attempted to modify source repos but encountered a write error.

**Cause**: Permission denied, disk full, or path issue.

**Recovery**: The tool automatically rolls back all changes. Verify with `git status` that no unintended modifications remain.

### Terraform plan shows unexpected changes after migration

**Possible causes**:
1. Resource block was modified during move (check diffs carefully)
2. Provider version mismatch between repos
3. State was not migrated (run `tfmigrate apply migrate.hcl` first)

**Debugging**:
```bash
# Compare the generated output with source
diff output/migrated/<repo>/main.tf <repo>/main.tf

# Check the rollback plan
cat output/rollback/README.md
```

## Getting Help

- GitHub Issues: https://github.com/tmae/terraform-state-mover/issues
- Use `--verbose` flag for detailed error information
- Include `--json` output when reporting bugs
