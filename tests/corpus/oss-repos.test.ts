/**
 * Corpus test: Verify terraform-state-mover doesn't crash on real-world OSS repos.
 *
 * Clones popular Terraform repos and runs the analyze pipeline against them.
 * This catches edge cases that synthetic tests miss.
 *
 * Skipped in normal test runs (requires network). Run with:
 *   CORPUS_TEST=1 pnpm test -- tests/corpus/oss-repos.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scanDirectory } from "../../src/parser/hcl-parser.js";
import { buildGraph } from "../../src/analyzer/dependency-graph.js";
import { detectArns } from "../../src/analyzer/arn-detector.js";
import { classifyGraph } from "../../src/analyzer/namespace-classifier.js";
import { gatekeeperModelConfig } from "../../src/presets/gatekeeper.js";

const REPOS = [
  { url: "https://github.com/terraform-aws-modules/terraform-aws-vpc.git", name: "terraform-aws-vpc", shallow: true },
  { url: "https://github.com/terraform-aws-modules/terraform-aws-eks.git", name: "terraform-aws-eks", shallow: true },
  { url: "https://github.com/terraform-aws-modules/terraform-aws-lambda.git", name: "terraform-aws-lambda", shallow: true },
];

const SKIP = !process.env.CORPUS_TEST;

describe.skipIf(SKIP)("OSS Corpus Test", () => {
  let corpusDir: string;

  beforeAll(async () => {
    corpusDir = await mkdtemp(join(tmpdir(), "tf-corpus-"));

    for (const repo of REPOS) {
      const repoDir = join(corpusDir, repo.name);
      if (!existsSync(repoDir)) {
        execSync(
          `git clone --depth 1 ${repo.url} ${repoDir}`,
          { stdio: "pipe", timeout: 30_000 },
        );
      }
    }
  }, 120_000); // 2 min timeout for cloning

  afterAll(async () => {
    if (corpusDir) {
      await rm(corpusDir, { recursive: true, force: true });
    }
  });

  for (const repo of REPOS) {
    it(`analyzes ${repo.name} without crashing`, async () => {
      const repoDir = join(corpusDir, repo.name);
      expect(existsSync(repoDir)).toBe(true);

      // This should NOT throw
      const files = await scanDirectory(repoDir, repo.name);
      expect(files.length).toBeGreaterThan(0);

      const graph = buildGraph(files);
      expect(graph.nodes.size).toBeGreaterThan(0);

      // ARN detection should not crash
      const arnRefs = detectArns(files);
      expect(arnRefs).toBeDefined();

      // Classification should not crash
      classifyGraph(graph.nodes, gatekeeperModelConfig);
    }, 30_000);
  }

  it("multi-repo analysis doesn't crash", async () => {
    const allFiles = [];
    for (const repo of REPOS) {
      const repoDir = join(corpusDir, repo.name);
      const files = await scanDirectory(repoDir, repo.name);
      allFiles.push(...files);
    }

    const graph = buildGraph(allFiles);
    const arnRefs = detectArns(allFiles);
    classifyGraph(graph.nodes, gatekeeperModelConfig);

    expect(arnRefs).toBeDefined();

    // Verify no undefined/null nodes
    for (const [id, node] of graph.nodes) {
      expect(id).toBeTruthy();
      expect(node.repo).toBeTruthy();
      expect(node.type).toMatch(/^(resource|data)$/);
    }
  }, 60_000);
});
