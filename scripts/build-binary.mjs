#!/usr/bin/env node
/**
 * Build standalone binaries using bun compile.
 *
 * Produces single executables for:
 * - linux-x64
 * - linux-arm64
 * - darwin-x64
 * - darwin-arm64
 *
 * Usage:
 *   bun run scripts/build-binary.mjs          # current platform only
 *   bun run scripts/build-binary.mjs --all    # cross-compile all platforms
 *
 * Output: dist/bin/tf-state-mover-{platform}-{arch}
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ENTRY = "src/cli.ts";
const OUT_DIR = join(process.cwd(), "dist", "bin");
const NAME = "tf-state-mover";

const TARGETS = [
  { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
];

function buildForTarget(target) {
  const outPath = join(OUT_DIR, `${NAME}-${target.platform}-${target.arch}`);
  console.log(`Building: ${target.platform}-${target.arch} → ${outPath}`);

  try {
    execFileSync("bun", ["build", ENTRY, "--compile", `--target=${target.bunTarget}`, `--outfile=${outPath}`], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    console.log(`  ✓ ${outPath}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
    return false;
  }
}

// Ensure output directory
mkdirSync(OUT_DIR, { recursive: true });

const buildAll = process.argv.includes("--all");

if (buildAll) {
  console.log("Cross-compiling for all platforms...\n");
  let success = 0;
  for (const target of TARGETS) {
    if (buildForTarget(target)) success++;
  }
  console.log(`\nBuilt ${success}/${TARGETS.length} targets.`);
  if (success === 0) process.exit(1);
} else {
  // Current platform only
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  const target = TARGETS.find((t) => t.platform === platform && t.arch === arch);

  if (!target) {
    console.error(`No target configured for ${platform}-${arch}`);
    console.error("Use --all for cross-compilation");
    process.exit(1);
  }

  if (!buildForTarget(target)) {
    process.exit(1);
  }
}
