/**
 * Types for the reporter domain — pattern detection, report generation.
 */

export interface DetectedPattern {
  name: string;
  severity: "critical" | "warning" | "info";
  description: string;
  evidence: string[];
}

export interface PatternThresholds {
  /** Minimum resources in a repo to flag as Terralith (default: 15) */
  terralithMinResources: number;
  /** Minimum resources + namespace diversity to flag as Terralith (default: 8 resources, 3 namespaces) */
  terralithMinResourcesWithDiversity: number;
  /** Minimum namespaces for diversity-based Terralith detection (default: 3) */
  terralithMinNamespaces: number;
  /** Resource count threshold to escalate Terralith to critical severity (default: 30) */
  terralithCriticalThreshold: number;
  /** Minimum module variable assignments to flag as God Module (default: 10) */
  godModuleMinAssignments: number;
}
