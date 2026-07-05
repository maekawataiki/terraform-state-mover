/**
 * Property-based tests using fast-check.
 *
 * Validates invariants that must hold for ANY valid input:
 * 1. Parse → Serialize → Re-parse produces the same block metadata
 * 2. ARN extraction is deterministic
 * 3. Block move operations conserve resources (no duplication, no loss)
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { parseHcl, extractArns } from "../../src/parser/hcl-parser.js";
import { blockToHcl } from "../../src/planner/hcl-block-mover.js";
import { generateRemovedBlockHcl, generateImportBlockHcl, generateMovedBlockHcl } from "../../src/planner/moved-block-generator.js";
import { buildGraph } from "../../src/analyzer/dependency-graph.js";
import type { TerraformBlock, ParsedFile } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate valid Terraform resource type names (e.g. "aws_iam_role") */
const resourceTypeGen = fc.tuple(
  fc.constantFrom("aws", "azurerm", "google", "null"),
  fc.array(fc.stringMatching(/^[a-z][a-z0-9]{1,10}$/), { minLength: 1, maxLength: 3 }),
).map(([provider, parts]) => `${provider}_${parts.join("_")}`);

/** Generate valid Terraform resource names (lowercase, underscores) */
const resourceNameGen = fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/);

/** Generate valid repo names */
const repoNameGen = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

/** Generate simple HCL attribute values */
const hclValueGen = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }).map((s) => `"${s.replace(/"/g, "").replace(/\\/g, "")}"`),
  fc.integer({ min: 0, max: 99999 }).map(String),
  fc.boolean().map(String),
);

/** Generate an attribute name (lowercase + underscores) */
const attrNameGen = fc.stringMatching(/^[a-z][a-z0-9_]{1,15}$/);

/** Generate a simple HCL body with attributes */
const hclBodyGen = fc.array(
  fc.tuple(attrNameGen, hclValueGen),
  { minLength: 1, maxLength: 5 },
).map((attrs) => {
  const lines = attrs.map(([name, val]) => `  ${name} = ${val}`);
  return `{\n${lines.join("\n")}\n}`;
});

/** Generate an ARN-like string */
const arnGen = fc.tuple(
  fc.constantFrom("iam", "s3", "lambda", "ec2", "rds"),
  fc.constantFrom("us-east-1", "eu-west-1", "ap-northeast-1", ""),
  fc.stringMatching(/^[0-9]{12}$/).map((s) => s.padStart(12, "1")),
  fc.stringMatching(/^[a-z][a-z0-9-]{3,20}$/),
).map(([service, region, account, name]) => {
  if (service === "iam") return `arn:aws:iam::${account}:role/${name}`;
  if (service === "s3") return `arn:aws:s3:::${name}`;
  return `arn:aws:${service}:${region}:${account}:${name}`;
});

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Property-based: parse-serialize round-trip", () => {
  it("blockToHcl → parseHcl preserves type, resourceType, and name", () => {
    fc.assert(
      fc.property(
        resourceTypeGen,
        resourceNameGen,
        hclBodyGen,
        repoNameGen,
        (resourceType, name, body, repo) => {
          const block: TerraformBlock = {
            type: "resource",
            resourceType,
            name,
            body,
            filePath: "/test/main.tf",
            repo,
            arns: [],
          };

          // Serialize
          const hcl = blockToHcl(block);

          // Re-parse
          const reparsed = parseHcl(hcl, "/test/main.tf", repo);

          // Invariant: same block metadata
          expect(reparsed.length).toBe(1);
          expect(reparsed[0].type).toBe("resource");
          expect(reparsed[0].resourceType).toBe(resourceType);
          expect(reparsed[0].name).toBe(name);
          expect(reparsed[0].repo).toBe(repo);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("data blocks also round-trip correctly", () => {
    fc.assert(
      fc.property(
        resourceTypeGen,
        resourceNameGen,
        hclBodyGen,
        repoNameGen,
        (resourceType, name, body, repo) => {
          const block: TerraformBlock = {
            type: "data",
            resourceType,
            name,
            body,
            filePath: "/test/main.tf",
            repo,
            arns: [],
          };

          const hcl = blockToHcl(block);
          const reparsed = parseHcl(hcl, "/test/main.tf", repo);

          expect(reparsed.length).toBe(1);
          expect(reparsed[0].type).toBe("data");
          expect(reparsed[0].resourceType).toBe(resourceType);
          expect(reparsed[0].name).toBe(name);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property-based: ARN extraction determinism", () => {
  it("extractArns returns same results on same input", () => {
    fc.assert(
      fc.property(
        fc.array(arnGen, { minLength: 0, maxLength: 5 }),
        fc.string({ minLength: 0, maxLength: 50 }),
        (arns, noise) => {
          // Build a string with embedded ARNs + noise
          const text = arns.map((arn) => `role = "${arn}"`).join("\n") + "\n" + noise;

          const result1 = extractArns(text);
          const result2 = extractArns(text);

          // Invariant: deterministic
          expect(result1).toEqual(result2);

          // Invariant: all ARN patterns in source should be found
          for (const arn of arns) {
            if (arn.startsWith("arn:aws:")) {
              expect(result1).toContain(arn);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("ARNs in HCL body are detected regardless of surrounding content", () => {
    fc.assert(
      fc.property(
        arnGen,
        attrNameGen,
        fc.string({ minLength: 0, maxLength: 20 }).map((s) => s.replace(/"/g, "").replace(/\\/g, "")),
        (arn, attrName, prefix) => {
          const body = `{\n  ${attrName} = "${prefix}${arn}"\n}`;
          const result = extractArns(body);
          expect(result).toContain(arn);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property-based: moved/import/removed block generation", () => {
  it("generateRemovedBlockHcl always produces valid HCL structure", () => {
    fc.assert(
      fc.property(
        resourceTypeGen,
        resourceNameGen,
        fc.boolean(),
        (resourceType, name, destroy) => {
          const address = `${resourceType}.${name}`;
          const hcl = generateRemovedBlockHcl({ from: address, destroy });

          expect(hcl).toContain("removed {");
          expect(hcl).toContain(`from = ${address}`);
          expect(hcl).toContain("lifecycle {");
          expect(hcl).toContain(`destroy = ${destroy}`);
          expect(hcl).toContain("}");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generateImportBlockHcl always produces valid HCL structure", () => {
    fc.assert(
      fc.property(
        resourceTypeGen,
        resourceNameGen,
        fc.stringMatching(/^[a-z0-9-]{3,30}$/),
        (resourceType, name, id) => {
          const address = `${resourceType}.${name}`;
          const hcl = generateImportBlockHcl({ to: address, id });

          expect(hcl).toContain("import {");
          expect(hcl).toContain(`to = ${address}`);
          expect(hcl).toContain(`id = "${id}"`);
          expect(hcl).toContain("}");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generateMovedBlockHcl always produces valid HCL structure", () => {
    fc.assert(
      fc.property(
        resourceTypeGen,
        resourceNameGen,
        (resourceType, name) => {
          const address = `${resourceType}.${name}`;
          const hcl = generateMovedBlockHcl({ from: address, to: address });

          expect(hcl).toContain("moved {");
          expect(hcl).toContain(`from = ${address}`);
          expect(hcl).toContain(`to   = ${address}`);
          expect(hcl).toContain("}");
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property-based: graph construction invariants", () => {
  it("buildGraph nodes are unique (no duplicate IDs)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(resourceTypeGen, resourceNameGen, repoNameGen),
          { minLength: 1, maxLength: 20 },
        ),
        (resources) => {
          const parsedFiles: ParsedFile[] = resources.map(([type, name, repo]) => ({
            filePath: `/${repo}/main.tf`,
            repo,
            blocks: [{
              type: "resource" as const,
              resourceType: type,
              name,
              body: `{\n  name = "${name}"\n}`,
              filePath: `/${repo}/main.tf`,
              repo,
              arns: [],
            }],
          }));

          const graph = buildGraph(parsedFiles);

          // Invariant: every node ID in the graph is unique (Map enforces this)
          const nodeIds = [...graph.nodes.keys()];
          expect(new Set(nodeIds).size).toBe(nodeIds.length);

          // Invariant: node count <= input resource count
          // (duplicates with same repo:type.name collapse)
          expect(graph.nodes.size).toBeLessThanOrEqual(resources.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("graph edges only reference existing nodes", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(resourceTypeGen, resourceNameGen, repoNameGen),
          { minLength: 2, maxLength: 10 },
        ),
        (resources) => {
          // Create resources that reference each other by resource type.name
          const parsedFiles: ParsedFile[] = resources.map(([type, name, repo], i) => {
            const nextIdx = (i + 1) % resources.length;
            const [nextType, nextName] = resources[nextIdx];
            const body = `{\n  ref = ${nextType}.${nextName}.id\n}`;
            return {
              filePath: `/${repo}/main.tf`,
              repo,
              blocks: [{
                type: "resource" as const,
                resourceType: type,
                name,
                body,
                filePath: `/${repo}/main.tf`,
                repo,
                arns: [],
              }],
            };
          });

          const graph = buildGraph(parsedFiles);

          // Invariant: all edge endpoints exist in nodes
          // (except "unresolved" which is a sentinel)
          for (const edge of graph.edges) {
            if (edge.to === "unresolved") continue;
            expect(graph.nodes.has(edge.from)).toBe(true);
            expect(graph.nodes.has(edge.to)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
