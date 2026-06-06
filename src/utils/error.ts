import { stat } from "node:fs/promises";

/**
 * Custom error class for CLI errors that should be displayed to the user
 * without a stack trace.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Format an unknown error value into a human-readable message.
 */
export function formatError(error: unknown): string {
  if (error instanceof CliError) {
    return error.message;
  }
  if (error instanceof Error) {
    if ("code" in error && error.code === "ENOENT") {
      const path = "path" in error ? (error as { path: string }).path : "unknown";
      return `Path not found: ${path}`;
    }
    if ("code" in error && error.code === "EACCES") {
      const path = "path" in error ? (error as { path: string }).path : "unknown";
      return `Permission denied: ${path}`;
    }
    return error.message;
  }
  return String(error);
}

/** Available preset names */
const VALID_PRESETS = ["gatekeeper", "terralith", "spaghetti"] as const;
export type PresetName = (typeof VALID_PRESETS)[number];

/**
 * Validate that a preset name is known.
 * @throws {CliError} if the preset is not recognized
 */
export function validatePreset(name: string): PresetName {
  if (!VALID_PRESETS.includes(name as PresetName)) {
    throw new CliError(
      `Unknown preset: "${name}". Available presets: ${VALID_PRESETS.join(", ")}`,
    );
  }
  return name as PresetName;
}

/**
 * Validate that a path exists and is a directory.
 * @throws {CliError} if the path does not exist or is not a directory
 */
export async function validateDirectory(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      throw new CliError(`Not a directory: ${path}`);
    }
  } catch (error: unknown) {
    if (error instanceof CliError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`Directory not found: ${path}`);
    }
    throw error;
  }
}

/**
 * Validate that a path exists and is a file.
 * @throws {CliError} if the path does not exist or is not a file
 */
export async function validateFile(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      throw new CliError(`Not a file: ${path}`);
    }
  } catch (error: unknown) {
    if (error instanceof CliError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`File not found: ${path}`);
    }
    throw error;
  }
}

/**
 * Parse JSON content with a descriptive error on failure.
 */
export function parseJson<T>(content: string, sourcePath: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new CliError(`Invalid JSON in ${sourcePath}`);
  }
}
