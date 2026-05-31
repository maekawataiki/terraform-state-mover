import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { parseCrossplaneYaml, parseCrossplaneFile, scanCrossplaneDirectory } from "./crossplane-parser.js";

describe("CrossplaneParser", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  const compositionYaml = `apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: rds-with-role
spec:
  compositeTypeRef:
    apiVersion: database.example.io/v1alpha1
    kind: XDatabase
  resources:
    - name: iam-role
      base:
        apiVersion: iam.aws.upbound.io/v1beta1
        kind: Role
        metadata:
          name: app-api-rds-role
        spec:
          forProvider:
            roleArn: arn:aws:iam::111111111111:role/app-api-db-access
            assumeRolePolicy: |
              {"Version":"2012-10-17"}
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        metadata:
          name: app-api-db
        spec:
          forProvider:
            dbInstanceClass: db.r6g.large
            engine: aurora-postgresql
            vpcId: vpc-12345
`;

  const xrdYaml = `apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xdatabases.database.example.io
spec:
  group: database.example.io
  names:
    kind: XDatabase
    plural: xdatabases
`;

  it("parses Composition YAML extracting resource blocks", () => {
    const blocks = parseCrossplaneYaml(compositionYaml, "composition.yaml", "crossplane-repo");

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].repo).toBe("crossplane-repo");
    expect(blocks[0].filePath).toBe("composition.yaml");
    expect(blocks[0].type).toBe("resource");
  });

  it("extracts ARN strings from YAML values", () => {
    const blocks = parseCrossplaneYaml(compositionYaml, "composition.yaml", "crossplane-repo");
    const allArns = blocks.flatMap((b) => b.arns);

    expect(allArns).toContain("arn:aws:iam::111111111111:role/app-api-db-access");
  });

  it("extracts forProvider fields with ARN/ID references", () => {
    const blocks = parseCrossplaneYaml(compositionYaml, "composition.yaml", "crossplane-repo");
    const allLiterals = blocks.flatMap((b) => b.stringLiterals);

    expect(allLiterals.some((s) => s.includes("arn:aws:iam::111111111111:role/app-api-db-access"))).toBe(true);
  });

  it("maps Crossplane kinds to Terraform resource types", () => {
    const blocks = parseCrossplaneYaml(compositionYaml, "composition.yaml", "crossplane-repo");
    const resourceTypes = blocks.map((b) => b.resourceType);

    expect(resourceTypes).toContain("crossplane_composition");
  });

  it("parses XRD files", () => {
    const blocks = parseCrossplaneYaml(xrdYaml, "xrd.yaml", "crossplane-repo");

    expect(blocks.length).toBe(1);
    expect(blocks[0].resourceType).toBe("crossplane_composition");
    expect(blocks[0].name).toBe("xdatabases_database_example_io");
  });

  it("ignores non-Crossplane YAML files", () => {
    const plainYaml = `name: my-app\nversion: 1.0.0\n`;
    const blocks = parseCrossplaneYaml(plainYaml, "app.yaml", "repo");

    expect(blocks).toHaveLength(0);
  });

  it("reads and parses a Crossplane file from disk", async () => {
    const filePath = join(testDir, "composition.yaml");
    await writeFile(filePath, compositionYaml);

    const parsed = await parseCrossplaneFile(filePath, "test-repo");

    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(parsed.repo).toBe("test-repo");
    expect(parsed.filePath).toBe(filePath);
  });

  it("scans a directory for Crossplane YAML files", async () => {
    const subDir = join(testDir, "compositions");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "db.yaml"), compositionYaml);
    await writeFile(join(subDir, "xrd.yaml"), xrdYaml);
    await writeFile(join(subDir, "not-crossplane.yaml"), "name: foo\nversion: 1\n");

    const results = await scanCrossplaneDirectory(testDir, "my-repo");

    expect(results.length).toBe(2);
    expect(results.every((r) => r.repo === "my-repo")).toBe(true);
  });

  it("handles multi-document YAML with --- separators", () => {
    const multiDoc = `${xrdYaml}
---
${compositionYaml}`;
    const blocks = parseCrossplaneYaml(multiDoc, "multi.yaml", "repo");

    expect(blocks.length).toBeGreaterThan(1);
  });
});
