#!/usr/bin/env node
/**
 * Performance benchmark for CI regression tracking.
 *
 * Generates a medium fixture (10 services × 15 resources), runs the analyze
 * command, and measures wall-clock time. Fails if:
 *   1. Duration exceeds absolute CI_THRESHOLD_MS, OR
 *   2. Duration exceeds baseline * (1 + tolerance_pct/100) from perf-baseline.json
 *
 * Usage:
 *   node scripts/perf-benchmark.mjs
 *
 * Output: JSON with benchmark results to stdout.
 * Exit code 1 if duration exceeds threshold or baseline regression detected.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const CI_THRESHOLD_MS = 5000;
const FIXTURE_DIR = join(process.cwd(), "tmp/perf-fixture");
const BASELINE_PATH = join(process.cwd(), "scripts/perf-baseline.json");

// Verify fixture exists
if (!existsSync(FIXTURE_DIR)) {
  console.error(`Fixture not found at ${FIXTURE_DIR}`);
  console.error("Run: node scripts/generate-perf-fixture.mjs 10 15");
  process.exit(1);
}

// Discover service directories (everything except state/)
const entries = readdirSync(FIXTURE_DIR, { withFileTypes: true });
const repoDirs = entries
  .filter((e) => e.isDirectory() && e.name !== "state")
  .map((e) => join(FIXTURE_DIR, e.name));

const stateDir = join(FIXTURE_DIR, "state");
const hasState = existsSync(stateDir);

// Count resources for reporting
const repos = repoDirs.length;
const resources = repos * 15; // approximate based on fixture generation params

// Build the CLI command
const args = [
  "tsx", "src/cli.ts", "analyze",
  ...repoDirs,
  "--preset", "gatekeeper",
  ...(hasState ? ["--state-dir", stateDir] : []),
  "--json",
];

console.error(`Running benchmark: ${repos} repos, ~${resources} resources`);
console.error(`Threshold: ${CI_THRESHOLD_MS}ms`);
console.error(`Command: ${args.join(" ")}`);

// Measure execution time
const startTime = performance.now();

try {
  execSync(args.join(" "), {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
} catch (err) {
  // analyze may exit non-zero with --json if issues found; that's OK
  if (!err.stdout && !err.stderr) {
    console.error("CLI execution failed unexpectedly:", err.message);
    process.exit(1);
  }
}

const endTime = performance.now();
const durationMs = Math.round(endTime - startTime);

// Check absolute threshold
const thresholdPassed = durationMs <= CI_THRESHOLD_MS;

// Check baseline regression
let baselineCheck = null;
if (existsSync(BASELINE_PATH)) {
  try {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
    const tolerancePct = baseline.tolerance_pct ?? 20;
    const maxAllowedMs = Math.round(baseline.baseline_ms * (1 + tolerancePct / 100));
    const regressionPassed = durationMs <= maxAllowedMs;

    baselineCheck = {
      baseline_ms: baseline.baseline_ms,
      tolerance_pct: tolerancePct,
      max_allowed_ms: maxAllowedMs,
      passed: regressionPassed,
    };

    if (!regressionPassed) {
      console.error(
        `\n❌ Baseline regression: ${durationMs}ms exceeds baseline ${baseline.baseline_ms}ms + ${tolerancePct}% tolerance (max: ${maxAllowedMs}ms)`,
      );
    } else {
      console.error(
        `\n✅ Baseline OK: ${durationMs}ms within ${baseline.baseline_ms}ms + ${tolerancePct}% (max: ${maxAllowedMs}ms)`,
      );
    }
  } catch (err) {
    console.error(`\n⚠️  Could not read baseline file: ${err.message}`);
  }
} else {
  console.error("\n⚠️  No baseline file found at scripts/perf-baseline.json — skipping regression check");
}

// Output results
const result = {
  fixture: "medium",
  resources,
  repos,
  duration_ms: durationMs,
  threshold_ms: CI_THRESHOLD_MS,
  threshold_passed: thresholdPassed,
  baseline: baselineCheck,
  passed: thresholdPassed && (baselineCheck === null || baselineCheck.passed),
};

console.log(JSON.stringify(result, null, 2));

if (!thresholdPassed) {
  console.error(
    `\n❌ Performance regression: ${durationMs}ms exceeds threshold of ${CI_THRESHOLD_MS}ms`,
  );
}

if (thresholdPassed && (baselineCheck === null || baselineCheck.passed)) {
  console.error(`\n✅ Performance OK: ${durationMs}ms (threshold: ${CI_THRESHOLD_MS}ms)`);
}

if (!result.passed) {
  process.exit(1);
}
