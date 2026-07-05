import { describe, it, expect } from "vitest";
import { validatePlanJson } from "./plan-schema.js";

describe("validatePlanJson", () => {
  it("accepts a valid minimal plan", () => {
    const plan = {
      format_version: "1.2",
      configuration: {
        root_module: {
          resources: [],
        },
      },
      planned_values: {
        root_module: {
          resources: [],
        },
      },
      resource_changes: [],
      variables: {},
    };

    const result = validatePlanJson(plan);
    expect(result.format_version).toBe("1.2");
    expect(result.resource_changes).toEqual([]);
  });

  it("accepts a plan with populated resource_changes", () => {
    const plan = {
      format_version: "1.2",
      resource_changes: [
        {
          address: "aws_iam_role.example",
          mode: "managed",
          type: "aws_iam_role",
          name: "example",
          change: {
            actions: ["create"],
            before: null,
            after: { name: "example-role" },
            after_unknown: { arn: true },
          },
        },
      ],
    };

    const result = validatePlanJson(plan);
    expect(result.resource_changes).toHaveLength(1);
    expect(result.resource_changes![0].address).toBe("aws_iam_role.example");
  });

  it("throws on null input", () => {
    expect(() => validatePlanJson(null)).toThrow("Invalid Terraform plan JSON format");
    expect(() => validatePlanJson(null)).toThrow("expected a JSON object at the top level");
  });

  it("throws on undefined input", () => {
    expect(() => validatePlanJson(undefined)).toThrow("Invalid Terraform plan JSON format");
  });

  it("throws on number input", () => {
    expect(() => validatePlanJson(42)).toThrow("Invalid Terraform plan JSON format");
    expect(() => validatePlanJson(42)).toThrow("expected a JSON object at the top level");
  });

  it("throws on string input", () => {
    expect(() => validatePlanJson("not a plan")).toThrow("Invalid Terraform plan JSON format");
  });

  it("throws on array input", () => {
    expect(() => validatePlanJson([1, 2, 3])).toThrow("Invalid Terraform plan JSON format");
    expect(() => validatePlanJson([1, 2, 3])).toThrow("expected a JSON object at the top level");
  });

  it("accepts a plan with missing configuration section", () => {
    const plan = {
      format_version: "1.2",
      planned_values: {
        root_module: {
          resources: [
            { address: "aws_s3_bucket.main", mode: "managed", type: "aws_s3_bucket", name: "main", values: {} },
          ],
        },
      },
      resource_changes: [],
    };

    const result = validatePlanJson(plan);
    expect(result.configuration).toBeUndefined();
    expect(result.planned_values?.root_module?.resources).toHaveLength(1);
  });

  it("accepts a plan with missing planned_values section", () => {
    const plan = {
      format_version: "1.2",
      configuration: { root_module: { resources: [] } },
      resource_changes: [],
    };

    const result = validatePlanJson(plan);
    expect(result.planned_values).toBeUndefined();
  });

  it("throws when resource_changes is not an array", () => {
    const plan = {
      format_version: "1.2",
      resource_changes: "not-an-array",
    };

    expect(() => validatePlanJson(plan)).toThrow("Invalid Terraform plan JSON format");
  });

  it("throws when configuration.root_module.resources is not an array", () => {
    const plan = {
      configuration: {
        root_module: {
          resources: "not-an-array",
        },
      },
    };

    expect(() => validatePlanJson(plan)).toThrow("Invalid Terraform plan JSON format");
  });

  it("accepts extra fields at all levels without failure (loose object)", () => {
    const plan = {
      format_version: "1.2",
      terraform_version: "1.9.3",
      timestamp: "2026-07-05T00:00:00Z",
      applyable: true,
      complete: true,
      configuration: {
        root_module: {
          resources: [],
          module_calls: {},
        },
        provider_config: { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws" } },
      },
      planned_values: {
        root_module: {
          resources: [],
          child_modules: [],
        },
        outputs: {},
      },
      resource_changes: [
        {
          address: "aws_iam_role.test",
          mode: "managed",
          type: "aws_iam_role",
          name: "test",
          provider_name: "registry.terraform.io/hashicorp/aws",
          schema_version: 0,
          change: {
            actions: ["create"],
            before: null,
            after: {},
            after_unknown: {},
            before_sensitive: false,
            after_sensitive: {},
          },
        },
      ],
      variables: {
        region: { value: "us-east-1" },
      },
      output_changes: {},
      prior_state: {},
    };

    const result = validatePlanJson(plan);
    expect(result.format_version).toBe("1.2");
    expect(result.resource_changes).toHaveLength(1);
    // Extra fields are preserved by looseObject
    expect((result as Record<string, unknown>).terraform_version).toBe("1.9.3");
  });

  it("accepts a completely empty object", () => {
    const result = validatePlanJson({});
    expect(result.format_version).toBeUndefined();
    expect(result.resource_changes).toBeUndefined();
  });

  it("accepts variables with various value types", () => {
    const plan = {
      variables: {
        name: { value: "test" },
        count: { value: 5 },
        enabled: { value: true },
        tags: { value: { env: "prod" } },
        list: { value: ["a", "b"] },
      },
    };

    const result = validatePlanJson(plan);
    expect(result.variables?.name.value).toBe("test");
    expect(result.variables?.count.value).toBe(5);
  });
});
