/**
 * Types for the state domain — state file parsing, plan parsing, tfmigrate.
 */

export interface StateResource {
  address: string;
  type: string;
  name: string;
  arn?: string;
  attributes: Record<string, unknown>;
}

export interface StateFile {
  resources: StateResource[];
  repo: string;
}

/**
 * Represents a resource from `terraform show -json` plan output's
 * configuration.root_module.resources[].
 */
export interface PlanConfigResource {
  address: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  /** All references extracted from expressions across all attributes. */
  references: string[];
}

/**
 * Represents a resource from `planned_values.root_module.resources[]`.
 */
export interface PlanValueResource {
  address: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  values: Record<string, unknown>;
}

/**
 * Represents a resource change from `resource_changes[]`.
 */
export interface PlanResourceChange {
  address: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  index?: number | string;
  change: {
    actions: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    after_unknown: Record<string, unknown>;
  };
}

/**
 * Parsed plan output combining all relevant sections.
 */
export interface ParsedPlan {
  /** Resources with their expression references (from configuration section). */
  configResources: PlanConfigResource[];
  /** Resources with their planned values (from planned_values section). */
  plannedResources: PlanValueResource[];
  /** Resource changes (from resource_changes section). */
  resourceChanges: PlanResourceChange[];
  /** Variables defined in the plan. */
  variables: Record<string, { value: unknown }>;
}
