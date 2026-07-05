import * as z from "zod/v4-mini";

/**
 * Zod schemas for validating Terraform plan JSON output (`terraform show -json <plan>`).
 *
 * Uses z.looseObject() per coding guidelines — Terraform versions may add
 * fields that we don't consume, so we must not reject them.
 */

const rootModuleSchema = z.looseObject({
  resources: z.optional(z.array(z.looseObject({}))),
  module_calls: z.optional(z.record(z.string(), z.looseObject({}))),
  child_modules: z.optional(z.array(z.looseObject({}))),
});

const configurationSchema = z.looseObject({
  root_module: z.optional(rootModuleSchema),
});

const plannedValuesSchema = z.looseObject({
  root_module: z.optional(rootModuleSchema),
});

const changeSchema = z.looseObject({
  actions: z.optional(z.array(z.string())),
  before: z.optional(z.unknown()),
  after: z.optional(z.unknown()),
  after_unknown: z.optional(z.unknown()),
});

const resourceChangeSchema = z.looseObject({
  address: z.optional(z.string()),
  mode: z.optional(z.string()),
  type: z.optional(z.string()),
  name: z.optional(z.string()),
  index: z.optional(z.union([z.number(), z.string()])),
  change: z.optional(changeSchema),
});

const variableSchema = z.looseObject({
  value: z.optional(z.unknown()),
});

/**
 * Top-level schema for Terraform plan JSON.
 *
 * All fields are optional because:
 * - `configuration` may be absent in `terraform show -json` of state-only outputs
 * - `planned_values` may be absent for destroy-only plans
 * - `resource_changes` is the most reliable section but can be empty
 * - `format_version` is present in all modern outputs but we don't gate on it
 */
export const terraformPlanSchema = z.looseObject({
  format_version: z.optional(z.string()),
  configuration: z.optional(configurationSchema),
  planned_values: z.optional(plannedValuesSchema),
  resource_changes: z.optional(z.array(resourceChangeSchema)),
  variables: z.optional(z.record(z.string(), variableSchema)),
});

export type TerraformPlanJson = z.infer<typeof terraformPlanSchema>;

/**
 * Validate parsed JSON against the Terraform plan schema.
 *
 * @param data - The parsed JSON value (unknown)
 * @returns The validated plan data
 * @throws Error with descriptive message if validation fails
 */
export function validatePlanJson(data: unknown): TerraformPlanJson {
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      "Invalid Terraform plan JSON format: expected a JSON object at the top level. " +
      "Ensure the input is the output of `terraform show -json <plan-file>`.",
    );
  }

  const result = terraformPlanSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid Terraform plan JSON format:\n${issues}\n` +
      "Ensure the input is the output of `terraform show -json <plan-file>`.",
    );
  }

  return result.data;
}
