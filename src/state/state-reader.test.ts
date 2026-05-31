import { describe, it, expect } from "vitest";
import { parseStateJson, buildArnMap, enrichWithState } from "./state-reader.js";
import type { ParsedFile } from "../types.js";

const sampleStateJson = JSON.stringify({
  version: 4,
  resources: [
    {
      type: "aws_iam_role",
      name: "app_api_db_access",
      instances: [
        {
          attributes: {
            arn: "arn:aws:iam::111111111111:role/app-api-db-access",
            name: "app-api-db-access",
          },
        },
      ],
    },
    {
      type: "aws_s3_bucket",
      name: "articles",
      instances: [
        {
          attributes: {
            arn: "arn:aws:s3:::articles-prod",
            id: "articles-prod",
            bucket: "articles-prod",
          },
        },
      ],
    },
  ],
});

describe("state-reader", () => {
  describe("parseStateJson", () => {
    it("parses resources from terraform state JSON", () => {
      const result = parseStateJson(sampleStateJson, "infra-central");
      expect(result.repo).toBe("infra-central");
      expect(result.resources).toHaveLength(2);
      expect(result.resources[0]).toEqual({
        address: "aws_iam_role.app_api_db_access",
        type: "aws_iam_role",
        name: "app_api_db_access",
        arn: "arn:aws:iam::111111111111:role/app-api-db-access",
        attributes: { arn: "arn:aws:iam::111111111111:role/app-api-db-access", name: "app-api-db-access" },
      });
    });

    it("extracts ARN from attributes.arn", () => {
      const result = parseStateJson(sampleStateJson, "repo");
      expect(result.resources[0].arn).toBe("arn:aws:iam::111111111111:role/app-api-db-access");
    });

    it("falls back to attributes.id when no arn", () => {
      const json = JSON.stringify({
        version: 4,
        resources: [{
          type: "aws_vpc",
          name: "main",
          instances: [{ attributes: { id: "vpc-12345" } }],
        }],
      });
      const result = parseStateJson(json, "infra");
      expect(result.resources[0].arn).toBe("vpc-12345");
    });

    it("handles empty state", () => {
      const result = parseStateJson(JSON.stringify({ version: 4, resources: [] }), "empty");
      expect(result.resources).toHaveLength(0);
    });
  });

  describe("buildArnMap", () => {
    it("builds a map of repo:address to ARN", () => {
      const stateFiles = [parseStateJson(sampleStateJson, "infra-central")];
      const map = buildArnMap(stateFiles);
      expect(map.get("infra-central:aws_iam_role.app_api_db_access")).toBe(
        "arn:aws:iam::111111111111:role/app-api-db-access",
      );
      expect(map.get("infra-central:aws_s3_bucket.articles")).toBe("arn:aws:s3:::articles-prod");
    });

    it("combines multiple state files", () => {
      const sf1 = parseStateJson(sampleStateJson, "repo-a");
      const sf2 = parseStateJson(JSON.stringify({
        version: 4,
        resources: [{
          type: "aws_iam_role",
          name: "other",
          instances: [{ attributes: { arn: "arn:aws:iam::222:role/other" } }],
        }],
      }), "repo-b");
      const map = buildArnMap([sf1, sf2]);
      expect(map.size).toBe(3);
    });
  });

  describe("enrichWithState", () => {
    it("adds real ARNs to parsed file blocks", () => {
      const parsedFiles: ParsedFile[] = [{
        filePath: "iam/roles.tf",
        repo: "infra-central",
        blocks: [{
          type: "resource",
          resourceType: "aws_iam_role",
          name: "app_api_db_access",
          body: 'name = "app-api-db-access"',
          stringLiterals: [],
          arns: [],
          filePath: "iam/roles.tf",
          repo: "infra-central",
        }],
      }];

      const stateFiles = [parseStateJson(sampleStateJson, "infra-central")];
      const enriched = enrichWithState(parsedFiles, stateFiles);

      expect(enriched[0].blocks[0].arns).toContain(
        "arn:aws:iam::111111111111:role/app-api-db-access",
      );
    });

    it("does not duplicate existing ARNs", () => {
      const existingArn = "arn:aws:iam::111111111111:role/app-api-db-access";
      const parsedFiles: ParsedFile[] = [{
        filePath: "iam/roles.tf",
        repo: "infra-central",
        blocks: [{
          type: "resource",
          resourceType: "aws_iam_role",
          name: "app_api_db_access",
          body: "",
          stringLiterals: [],
          arns: [existingArn],
          filePath: "iam/roles.tf",
          repo: "infra-central",
        }],
      }];

      const stateFiles = [parseStateJson(sampleStateJson, "infra-central")];
      const enriched = enrichWithState(parsedFiles, stateFiles);
      expect(enriched[0].blocks[0].arns).toEqual([existingArn]);
    });

    it("leaves blocks unchanged if no matching state", () => {
      const parsedFiles: ParsedFile[] = [{
        filePath: "main.tf",
        repo: "other-repo",
        blocks: [{
          type: "resource",
          resourceType: "aws_lambda_function",
          name: "handler",
          body: "",
          stringLiterals: [],
          arns: [],
          filePath: "main.tf",
          repo: "other-repo",
        }],
      }];

      const stateFiles = [parseStateJson(sampleStateJson, "infra-central")];
      const enriched = enrichWithState(parsedFiles, stateFiles);
      expect(enriched[0].blocks[0].arns).toEqual([]);
    });
  });
});
