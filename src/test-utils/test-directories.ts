import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_BASE_DIR = join(process.cwd(), "tmp", "tests");

interface SetupTestDirectoryOptions {
  home?: boolean;
}

interface TestDirectoryResult {
  testDir: string;
  cleanup: () => Promise<void>;
}

export async function setupTestDirectory(options?: SetupTestDirectoryOptions): Promise<TestDirectoryResult> {
  const subDir = options?.home ? "home" : "projects";
  const baseDir = join(TEST_BASE_DIR, subDir);

  // Ensure base exists (mkdtemp requires parent to exist)
  const { mkdir } = await import("node:fs/promises");
  await mkdir(baseDir, { recursive: true });

  const testDir = await mkdtemp(join(baseDir, "test-"));

  const cleanup = async () => {
    await rm(testDir, { recursive: true, force: true });
  };

  return { testDir, cleanup };
}
