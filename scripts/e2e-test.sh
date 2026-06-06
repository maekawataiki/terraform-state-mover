#!/bin/bash
set -euo pipefail

# =============================================================================
# E2E Test: terraform-state-mover
#
# Verifies that migration produces zero diff in terraform plan.
# Requires: terraform, AWS credentials configured.
#
# Usage:
#   ./scripts/e2e-test.sh gatekeeper    # Run gatekeeper scenario
#   ./scripts/e2e-test.sh spaghetti     # Run spaghetti scenario
#   ./scripts/e2e-test.sh all           # Run all scenarios
#   ./scripts/e2e-test.sh cleanup       # Force cleanup all E2E resources
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_DIR="$PROJECT_ROOT/examples/e2e"
E2E_OUTPUT="$PROJECT_ROOT/output/e2e"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
ERRORS=()

log()   { echo -e "${BOLD}[e2e]${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
fail()  { echo -e "${RED}  ✗${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }

# --- Utility Functions ---

# Generate lambda.zip fixtures for E2E tests
_generate_lambda_zips() {
  for dir in "$E2E_DIR"/gatekeeper/service-app-api "$E2E_DIR"/spaghetti/services; do
    if [ -d "$dir" ] && [ ! -f "$dir/lambda.zip" ]; then
      echo 'exports.handler = async () => ({ statusCode: 200 });' > "$dir/index.js"
      (cd "$dir" && zip -q lambda.zip index.js && rm index.js)
    fi
  done
}

terraform_init() {
  local dir="$1"
  terraform -chdir="$dir" init -input=false -no-color >/dev/null 2>&1
}

terraform_apply() {
  local dir="$1"
  terraform -chdir="$dir" apply -auto-approve -input=false -no-color 2>&1
}

terraform_plan_no_changes() {
  local dir="$1"
  local output
  output=$(terraform -chdir="$dir" plan -detailed-exitcode -input=false -no-color 2>&1) || {
    local exitcode=$?
    if [ $exitcode -eq 2 ]; then
      # Exit code 2 = changes detected
      echo "$output"
      return 1
    elif [ $exitcode -eq 1 ]; then
      # Exit code 1 = error
      echo "$output"
      return 2
    fi
  }
  return 0
}

terraform_destroy() {
  local dir="$1"
  terraform -chdir="$dir" destroy -auto-approve -input=false -no-color 2>&1 || true
}

terraform_state_pull() {
  local dir="$1"
  local output_file="$2"
  terraform -chdir="$dir" state pull > "$output_file"
}

cleanup_terraform_state() {
  local dir="$1"
  rm -rf "$dir/.terraform" "$dir/.terraform.lock.hcl" "$dir/terraform.tfstate" "$dir/terraform.tfstate.backup"
}

# --- Gatekeeper Scenario ---

test_gatekeeper() {
  log "=== Gatekeeper E2E Test ==="
  log "Scenario: Move service-specific IAM roles from infra-central to service-app-api"
  echo ""

  local infra="$E2E_DIR/gatekeeper/infra-central"
  local service="$E2E_DIR/gatekeeper/service-app-api"
  local state_dir="$E2E_OUTPUT/gatekeeper/state"
  local output_dir="$E2E_OUTPUT/gatekeeper"

  mkdir -p "$state_dir" "$output_dir"

  # Cleanup any previous state
  cleanup_terraform_state "$infra"
  cleanup_terraform_state "$service"

  # Step 1: Deploy infra-central (creates IAM roles)
  log "Step 1: Deploy infra-central (create IAM roles)"
  terraform_init "$infra"
  local apply_output
  apply_output=$(terraform_apply "$infra")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for infra-central"
    echo "$apply_output"
    ERRORS+=("gatekeeper: infra-central apply failed")
    return 1
  fi
  ok "infra-central deployed"

  # Step 2: Deploy service-app-api (initial state)
  log "Step 2: Deploy service-app-api (initial)"
  terraform_init "$service"
  apply_output=$(terraform_apply "$service")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for service-app-api"
    echo "$apply_output"
    ERRORS+=("gatekeeper: service-app-api apply failed")
    _gatekeeper_cleanup "$infra" "$service"
    return 1
  fi
  ok "service-app-api deployed"

  # Step 3: Pull state for migration tool
  log "Step 3: Pull state"
  terraform_state_pull "$infra" "$state_dir/infra-central.tfstate.json"
  terraform_state_pull "$service" "$state_dir/service-app-api.tfstate.json"
  ok "State pulled"

  # Step 4: Run migration (--apply writes to source repos)
  log "Step 4: Run terraform-state-mover migrate --apply"
  # Backup source files before migration modifies them
  cp "$infra/main.tf" "$state_dir/infra-central-main.tf.bak"
  cp "$service/main.tf" "$state_dir/service-app-api-main.tf.bak"
  local migrate_output
  migrate_output=$(cd "$PROJECT_ROOT" && npx tsx src/cli.ts migrate \
    "$infra" "$service" \
    --preset gatekeeper \
    --state-dir "$state_dir" \
    -o "$output_dir" \
    --apply 2>&1)
  if [ $? -ne 0 ]; then
    fail "migrate --apply failed"
    echo "$migrate_output"
    ERRORS+=("gatekeeper: migrate --apply failed")
    _gatekeeper_cleanup "$infra" "$service"
    return 1
  fi
  ok "Migration applied"
  echo "$migrate_output" | grep -E "Resources to move|ARNs to rewrite|Files affected" | sed 's/^/    /' || true

  # Step 5: Re-init (new files may have been added)
  log "Step 5: Re-init both repos"
  terraform_init "$infra"
  terraform_init "$service"
  ok "Re-initialized"

  # Step 6: Apply in service-app-api (import resources)
  log "Step 6: Apply service-app-api (import resources from infra-central)"
  apply_output=$(terraform_apply "$service")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for service-app-api after migration"
    echo "$apply_output"
    ERRORS+=("gatekeeper: service-app-api post-migration apply failed")
    _gatekeeper_cleanup "$infra" "$service"
    return 1
  fi
  ok "service-app-api: import successful"

  # Step 7: Apply in infra-central (removed blocks release resources)
  log "Step 7: Apply infra-central (release resources via removed blocks)"
  apply_output=$(terraform_apply "$infra")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for infra-central after migration"
    echo "$apply_output"
    ERRORS+=("gatekeeper: infra-central post-migration apply failed")
    _gatekeeper_cleanup "$infra" "$service"
    return 1
  fi
  ok "infra-central: resources released"

  # Step 8: THE CRITICAL CHECK — plan shows no changes
  log "Step 8: Verify terraform plan shows NO CHANGES"
  local plan_output

  plan_output=$(terraform_plan_no_changes "$infra")
  if [ $? -eq 0 ]; then
    ok "infra-central: No changes (plan clean)"
    PASSED=$((PASSED + 1))
  else
    fail "infra-central: Plan shows changes!"
    echo "$plan_output" | head -30
    ERRORS+=("gatekeeper: infra-central has plan diff after migration")
    FAILED=$((FAILED + 1))
  fi

  plan_output=$(terraform_plan_no_changes "$service")
  if [ $? -eq 0 ]; then
    ok "service-app-api: No changes (plan clean)"
    PASSED=$((PASSED + 1))
  else
    fail "service-app-api: Plan shows changes!"
    echo "$plan_output" | head -30
    ERRORS+=("gatekeeper: service-app-api has plan diff after migration")
    FAILED=$((FAILED + 1))
  fi

  # Save post-migration state for comparison
  log "Saving post-migration state"
  terraform_state_pull "$infra" "$state_dir/infra-central-after.tfstate.json"
  terraform_state_pull "$service" "$state_dir/service-app-api-after.tfstate.json"
  ok "State saved to $state_dir/*-after.tfstate.json"

  # Cleanup
  log "Cleanup: Destroy resources"
  _gatekeeper_cleanup "$infra" "$service"
  echo ""
}

_gatekeeper_cleanup() {
  local infra="$1"
  local service="$2"
  terraform_destroy "$service" >/dev/null 2>&1
  terraform_destroy "$infra" >/dev/null 2>&1
  # Remove migration-generated files (untracked, git checkout won't remove them)
  rm -f "$infra/removed.tf" "$service/imports.tf" "$service/moved-from-"*.tf
  rm -f "$infra/imports.tf" "$infra/moved-from-"*.tf "$service/removed.tf"
  rm -f "$service/outputs.tf" "$infra/outputs.tf"
  # Restore original main.tf from backup
  local state_dir="$E2E_OUTPUT/gatekeeper/state"
  [ -f "$state_dir/infra-central-main.tf.bak" ] && cp "$state_dir/infra-central-main.tf.bak" "$infra/main.tf"
  [ -f "$state_dir/service-app-api-main.tf.bak" ] && cp "$state_dir/service-app-api-main.tf.bak" "$service/main.tf"
  cleanup_terraform_state "$infra"
  cleanup_terraform_state "$service"
  ok "Cleaned up"
}

# --- Spaghetti Scenario ---

test_spaghetti() {
  log "=== Spaghetti E2E Test ==="
  log "Scenario: Replace hardcoded ARN references + remote_state with var/output interfaces"
  echo ""

  local network="$E2E_DIR/spaghetti/network"
  local platform="$E2E_DIR/spaghetti/platform"
  local services="$E2E_DIR/spaghetti/services"
  local state_dir="$E2E_OUTPUT/spaghetti/state"
  local output_dir="$E2E_OUTPUT/spaghetti"

  mkdir -p "$state_dir" "$output_dir"

  # Cleanup any previous state
  cleanup_terraform_state "$network"
  cleanup_terraform_state "$platform"
  cleanup_terraform_state "$services"

  # Step 1: Deploy network (VPC/subnets)
  log "Step 1: Deploy network"
  terraform_init "$network"
  local apply_output
  apply_output=$(terraform_apply "$network")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for network"
    echo "$apply_output"
    ERRORS+=("spaghetti: network apply failed")
    return 1
  fi
  ok "network deployed"

  # Step 2: Deploy platform (IAM roles)
  log "Step 2: Deploy platform"
  terraform_init "$platform"
  apply_output=$(terraform_apply "$platform")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for platform"
    echo "$apply_output"
    ERRORS+=("spaghetti: platform apply failed")
    _spaghetti_cleanup "$network" "$platform" "$services"
    return 1
  fi
  ok "platform deployed"

  # Step 3: Deploy services (uses remote_state + hardcoded ARNs)
  log "Step 3: Deploy services"
  terraform_init "$services"
  apply_output=$(terraform_apply "$services")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for services"
    echo "$apply_output"
    ERRORS+=("spaghetti: services apply failed")
    _spaghetti_cleanup "$network" "$platform" "$services"
    return 1
  fi
  ok "services deployed"

  # Step 4: Pull state
  log "Step 4: Pull state"
  terraform_state_pull "$network" "$state_dir/network.tfstate.json"
  terraform_state_pull "$platform" "$state_dir/platform.tfstate.json"
  terraform_state_pull "$services" "$state_dir/services.tfstate.json"
  ok "State pulled"

  # Step 5: Run migration
  log "Step 5: Run terraform-state-mover migrate --apply"
  local migrate_output
  migrate_output=$(cd "$PROJECT_ROOT" && npx tsx src/cli.ts migrate \
    "$network" "$platform" "$services" \
    --preset spaghetti \
    --state-dir "$state_dir" \
    -o "$output_dir" \
    --apply 2>&1)
  if [ $? -ne 0 ]; then
    fail "migrate --apply failed"
    echo "$migrate_output"
    ERRORS+=("spaghetti: migrate --apply failed")
    _spaghetti_cleanup "$network" "$platform" "$services"
    return 1
  fi
  ok "Migration applied"
  echo "$migrate_output" | grep -E "Resources to move|ARNs to rewrite|Files affected" | sed 's/^/    /' || true

  # Step 6: Re-init all repos
  log "Step 6: Re-init all repos"
  terraform_init "$network"
  terraform_init "$platform"
  terraform_init "$services"
  ok "Re-initialized"

  # Step 7: Apply all (import/removed)
  log "Step 7: Apply all repos (import + removed)"
  apply_output=$(terraform_apply "$platform")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for platform after migration"
    echo "$apply_output"
    ERRORS+=("spaghetti: platform post-migration apply failed")
    _spaghetti_cleanup "$network" "$platform" "$services"
    return 1
  fi
  ok "platform applied"

  apply_output=$(terraform_apply "$network")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for network after migration"
    echo "$apply_output"
    ERRORS+=("spaghetti: network post-migration apply failed")
    _spaghetti_cleanup "$network" "$platform" "$services"
    return 1
  fi
  ok "network applied"

  apply_output=$(terraform_apply "$services")
  if [ $? -ne 0 ]; then
    fail "terraform apply failed for services after migration"
    echo "$apply_output"
    ERRORS+=("spaghetti: services post-migration apply failed")
    _spaghetti_cleanup "$network" "$platform" "$services"
    return 1
  fi
  ok "services applied"

  # Step 8: THE CRITICAL CHECK
  log "Step 8: Verify terraform plan shows NO CHANGES"
  local plan_output

  plan_output=$(terraform_plan_no_changes "$network")
  if [ $? -eq 0 ]; then
    ok "network: No changes (plan clean)"
    PASSED=$((PASSED + 1))
  else
    fail "network: Plan shows changes!"
    echo "$plan_output" | head -30
    ERRORS+=("spaghetti: network has plan diff after migration")
    FAILED=$((FAILED + 1))
  fi

  plan_output=$(terraform_plan_no_changes "$platform")
  if [ $? -eq 0 ]; then
    ok "platform: No changes (plan clean)"
    PASSED=$((PASSED + 1))
  else
    fail "platform: Plan shows changes!"
    echo "$plan_output" | head -30
    ERRORS+=("spaghetti: platform has plan diff after migration")
    FAILED=$((FAILED + 1))
  fi

  plan_output=$(terraform_plan_no_changes "$services")
  if [ $? -eq 0 ]; then
    ok "services: No changes (plan clean)"
    PASSED=$((PASSED + 1))
  else
    fail "services: Plan shows changes!"
    echo "$plan_output" | head -30
    ERRORS+=("spaghetti: services has plan diff after migration")
    FAILED=$((FAILED + 1))
  fi

  # Save post-migration state for comparison
  log "Saving post-migration state"
  terraform_state_pull "$network" "$state_dir/network-after.tfstate.json"
  terraform_state_pull "$platform" "$state_dir/platform-after.tfstate.json"
  terraform_state_pull "$services" "$state_dir/services-after.tfstate.json"
  ok "State saved to $state_dir/*-after.tfstate.json"

  # Cleanup
  log "Cleanup: Destroy resources"
  _spaghetti_cleanup "$network" "$platform" "$services"
  echo ""
}

_spaghetti_cleanup() {
  local network="$1"
  local platform="$2"
  local services="$3"
  terraform_destroy "$services" >/dev/null 2>&1
  terraform_destroy "$platform" >/dev/null 2>&1
  terraform_destroy "$network" >/dev/null 2>&1
  # Remove migration-generated files
  for dir in "$network" "$platform" "$services"; do
    rm -f "$dir/removed.tf" "$dir/imports.tf" "$dir/moved-from-"*.tf
    rm -f "$dir/outputs.tf" "$dir/variables.tf"
  done
  # Restore modified files from git
  (cd "$PROJECT_ROOT" && git checkout -- "$network/main.tf" "$platform/main.tf" "$services/main.tf" 2>/dev/null) || true
  cleanup_terraform_state "$network"
  cleanup_terraform_state "$platform"
  cleanup_terraform_state "$services"
  ok "Cleaned up"
}

# --- Force Cleanup ---

force_cleanup() {
  log "Force cleanup all E2E resources..."
  local infra="$E2E_DIR/gatekeeper/infra-central"
  local service="$E2E_DIR/gatekeeper/service-app-api"
  local network="$E2E_DIR/spaghetti/network"
  local platform="$E2E_DIR/spaghetti/platform"
  local services="$E2E_DIR/spaghetti/services"

  for dir in "$service" "$infra" "$services" "$platform" "$network"; do
    if [ -f "$dir/terraform.tfstate" ]; then
      log "Destroying $dir"
      terraform_init "$dir" 2>/dev/null || true
      terraform_destroy "$dir"
    fi
    # Remove migration-generated files
    rm -f "$dir/removed.tf" "$dir/imports.tf" "$dir/moved-from-"*.tf
    rm -f "$dir/outputs.tf" "$dir/variables.tf"
    cleanup_terraform_state "$dir"
  done

  # Restore files from git
  (cd "$PROJECT_ROOT" && git checkout -- examples/e2e/ 2>/dev/null) || true
  rm -rf "$E2E_OUTPUT"
  ok "All cleaned up"
}

# --- Main ---

main() {
  local scenario="${1:-all}"

  # Verify prerequisites
  if ! command -v terraform &>/dev/null; then
    fail "terraform not found in PATH"
    exit 1
  fi

  if ! aws sts get-caller-identity &>/dev/null; then
    fail "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE."
    exit 1
  fi

  local identity
  identity=$(aws sts get-caller-identity --query 'Account' --output text)
  log "Using AWS account: $identity"
  echo ""

  _generate_lambda_zips

  case "$scenario" in
    gatekeeper)
      test_gatekeeper
      ;;
    spaghetti)
      test_spaghetti
      ;;
    all)
      test_gatekeeper
      test_spaghetti
      ;;
    cleanup)
      force_cleanup
      exit 0
      ;;
    *)
      echo "Usage: $0 {gatekeeper|spaghetti|all|cleanup}"
      exit 1
      ;;
  esac

  # Summary
  echo ""
  log "========================================="
  log "  E2E Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
  log "========================================="
  if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    for err in "${ERRORS[@]}"; do
      fail "$err"
    done
    exit 1
  fi
}

main "$@"
