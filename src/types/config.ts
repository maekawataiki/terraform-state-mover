/**
 * Types for the config domain — .tf-mover.yaml configuration.
 */

export interface TfMoverConfig {
  classification?: {
    patterns?: Array<{ match: string; namespace: string }>;
    explicit?: Record<string, string>;
    default?: string;
  };
}
