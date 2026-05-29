import { describe, it, expect } from "vitest";
import { verifyMigration } from "../../../src/state/state-differ.js";

describe("state-differ", () => {
  const targetState = JSON.stringify({
    version: 4,
    resources: [
      {
        type: "aws_iam_role",
        name: "app_api_db_access",
        instances: [{ attributes: { arn: "arn:aws:iam::111:role/app-api-db-access" } }],
      },
      {
        type: "aws_iam_role",
        name: "app_api_lambda",
        instances: [{ attributes: { arn: "arn:aws:iam::111:role/app-api-lambda-exec" } }],
      },
      {
        type: "aws_s3_bucket",
        name: "extra_bucket",
        instances: [{ attributes: { arn: "arn:aws:s3:::extra" } }],
      },
    ],
  });

  it("verifies resources that exist in target state", () => {
    const result = verifyMigration({
      expectedResources: ["aws_iam_role.app_api_db_access", "aws_iam_role.app_api_lambda"],
      targetStateJson: targetState,
    });
    expect(result.verified).toEqual(["aws_iam_role.app_api_db_access", "aws_iam_role.app_api_lambda"]);
    expect(result.missing).toEqual([]);
  });

  it("reports missing resources", () => {
    const result = verifyMigration({
      expectedResources: ["aws_iam_role.app_api_db_access", "aws_iam_role.nonexistent"],
      targetStateJson: targetState,
    });
    expect(result.missing).toEqual(["aws_iam_role.nonexistent"]);
    expect(result.verified).toEqual(["aws_iam_role.app_api_db_access"]);
  });

  it("reports extra resources not in expected list", () => {
    const result = verifyMigration({
      expectedResources: ["aws_iam_role.app_api_db_access"],
      targetStateJson: targetState,
    });
    expect(result.extra).toContain("aws_iam_role.app_api_lambda");
    expect(result.extra).toContain("aws_s3_bucket.extra_bucket");
  });

  it("handles empty expected list", () => {
    const result = verifyMigration({
      expectedResources: [],
      targetStateJson: targetState,
    });
    expect(result.verified).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toHaveLength(3);
  });

  it("handles empty state", () => {
    const result = verifyMigration({
      expectedResources: ["aws_iam_role.missing"],
      targetStateJson: JSON.stringify({ version: 4, resources: [] }),
    });
    expect(result.missing).toEqual(["aws_iam_role.missing"]);
    expect(result.verified).toEqual([]);
    expect(result.extra).toEqual([]);
  });
});
