import { z } from "zod";

/**
 * Zod schemas for validating Terraform plan JSON output (`terraform show -json <plan>`).
 *
 * Uses z.object().passthrough() (equivalent to looseObject) — Terraform versions
 * may add fields that we don't consume, so we must not reject them.
 */

const rootModuleSchema = z.object({
  resources: z.array(z.object({}).passthrough()).optional(),
  module_calls: z.record(z.string(), z.object({}).passthrough()).optional(),
  child_modules: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

const configurationSchema = z.object({
  root_module: rootModuleSchema.optional(),
}).passthrough();

const plannedValuesSchema = z.object({
  root_module: rootModuleSchema.optional(),
}).passthrough();

const changeSchema = z.object({
  actions: z.array(z.string()).optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  after_unknown: z.unknown().optional(),
}).passthrough();

const resourceChangeSchema = z.object({
  address: z.string().optional(),
  mode: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  index: z.union([z.number(), z.string()]).optional(),
  change: changeSchema.optional(),
}).passthrough();

const variableSchema = z.object({
  value: z.unknown().optional(),
}).passthrough();

/**
 * Top-level schema for Terraform plan JSON.
 *
 * All fields are optional because:
 * - `configuration` may be absent in `terraform show -json` of state-only outputs
 * - `planned_values` may be absent for destroy-only plans
 * - `resource_changes` is the most reliable section but can be empty
 * - `format_version` is present in all modern outputs but we don't gate on it
 */
export const terraformPlanSchema = z.object({
  format_version: z.string().optional(),
  configuration: configurationSchema.optional(),
  planned_values: plannedValuesSchema.optional(),
  resource_changes: z.array(resourceChangeSchema).optional(),
  variables: z.record(z.string(), variableSchema).optional(),
}).passthrough();

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
      .map((issue: z.ZodIssue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid Terraform plan JSON format:\n${issues}\n` +
      "Ensure the input is the output of `terraform show -json <plan-file>`.",
    );
  }

  return result.data;
}
