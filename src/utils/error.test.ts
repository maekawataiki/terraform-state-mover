import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { CliError, formatError, validatePreset, validateDirectory, validateFile, parseJson } from "./error.js";

describe("CliError", () => {
  it("creates an error with the correct name", () => {
    const err = new CliError("test message");
    expect(err.name).toBe("CliError");
    expect(err.message).toBe("test message");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("formatError", () => {
  it("returns message for CliError", () => {
    expect(formatError(new CliError("cli problem"))).toBe("cli problem");
  });

  it("returns path info for ENOENT errors", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT", path: "/foo/bar" });
    expect(formatError(err)).toBe("Path not found: /foo/bar");
  });

  it("returns path info for EACCES errors", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES", path: "/secret" });
    expect(formatError(err)).toBe("Permission denied: /secret");
  });

  it("returns message for generic Error", () => {
    expect(formatError(new Error("something broke"))).toBe("something broke");
  });

  it("stringifies non-Error values", () => {
    expect(formatError("string error")).toBe("string error");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
  });
});

describe("validatePreset", () => {
  it("accepts valid preset name", () => {
    expect(validatePreset("gatekeeper")).toBe("gatekeeper");
  });

  it("throws CliError for unknown preset", () => {
    expect(() => validatePreset("unknown")).toThrow(CliError);
    expect(() => validatePreset("unknown")).toThrow(/Unknown preset: "unknown"/);
    expect(() => validatePreset("unknown")).toThrow(/Available presets: gatekeeper/);
  });
});

describe("validateDirectory", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("accepts existing directory", async () => {
    await expect(validateDirectory(testDir)).resolves.toBeUndefined();
  });

  it("throws CliError for non-existent path", async () => {
    await expect(validateDirectory(join(testDir, "nope"))).rejects.toThrow(CliError);
    await expect(validateDirectory(join(testDir, "nope"))).rejects.toThrow(/Directory not found/);
  });

  it("throws CliError for file path", async () => {
    const file = join(testDir, "file.txt");
    await writeFile(file, "content");
    await expect(validateDirectory(file)).rejects.toThrow(CliError);
    await expect(validateDirectory(file)).rejects.toThrow(/Not a directory/);
  });
});

describe("validateFile", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("accepts existing file", async () => {
    const file = join(testDir, "test.json");
    await writeFile(file, "{}");
    await expect(validateFile(file)).resolves.toBeUndefined();
  });

  it("throws CliError for non-existent path", async () => {
    await expect(validateFile(join(testDir, "nope.json"))).rejects.toThrow(CliError);
    await expect(validateFile(join(testDir, "nope.json"))).rejects.toThrow(/File not found/);
  });

  it("throws CliError for directory path", async () => {
    await expect(validateFile(testDir)).rejects.toThrow(CliError);
    await expect(validateFile(testDir)).rejects.toThrow(/Not a file/);
  });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    expect(parseJson('{"a": 1}', "test.json")).toEqual({ a: 1 });
  });

  it("throws CliError with filename for invalid JSON", () => {
    expect(() => parseJson("not json", "broken.json")).toThrow(CliError);
    expect(() => parseJson("not json", "broken.json")).toThrow(/Invalid JSON in broken.json/);
  });
});
