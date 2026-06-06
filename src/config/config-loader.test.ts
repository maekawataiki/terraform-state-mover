import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupTestDirectory } from "../test-utils/test-directories.js";
import { parseConfig, buildNamespaceConfig, loadConfigFile } from "./config-loader.js";
import type { GraphNode } from "../types.js";

function makeNode(repo: string): GraphNode {
  return {
    id: `resource.test.${repo}`,
    type: "resource",
    resourceType: "aws_iam_role",
    name: "test",
    repo,
    filePath: `${repo}/main.tf`,
  };
}

describe("parseConfig", () => {
  it("parses a valid YAML config with patterns, explicit, and default", () => {
    const content = `# .tf-mover.yaml
classification:
  patterns:
    - match: "^infra-(.*)"
      namespace: "foundation"
    - match: "^shared-(.*)"
      namespace: "platform"
    - match: "^(team|squad|service|svc|app)-(.+)"
      namespace: "service-$2"
  explicit:
    legacy-monolith: "platform"
    auth-service: "service-auth"
  default: "service-{repo}"
`;
    const config = parseConfig(content);

    expect(config.classification).toBeDefined();
    expect(config.classification!.patterns).toHaveLength(3);
    expect(config.classification!.patterns![0]).toEqual({
      match: "^infra-(.*)",
      namespace: "foundation",
    });
    expect(config.classification!.patterns![1]).toEqual({
      match: "^shared-(.*)",
      namespace: "platform",
    });
    expect(config.classification!.patterns![2]).toEqual({
      match: "^(team|squad|service|svc|app)-(.+)",
      namespace: "service-$2",
    });
    expect(config.classification!.explicit).toEqual({
      "legacy-monolith": "platform",
      "auth-service": "service-auth",
    });
    expect(config.classification!.default).toBe("service-{repo}");
  });

  it("parses config with only patterns", () => {
    const content = `classification:
  patterns:
    - match: "^infra-(.*)"
      namespace: "foundation"
`;
    const config = parseConfig(content);

    expect(config.classification!.patterns).toHaveLength(1);
    expect(config.classification!.explicit).toBeUndefined();
    expect(config.classification!.default).toBeUndefined();
  });

  it("parses config with only explicit mappings", () => {
    const content = `classification:
  explicit:
    my-repo: "platform"
    other-repo: "foundation"
`;
    const config = parseConfig(content);

    expect(config.classification!.patterns).toBeUndefined();
    expect(config.classification!.explicit).toEqual({
      "my-repo": "platform",
      "other-repo": "foundation",
    });
  });

  it("parses config with only default", () => {
    const content = `classification:
  default: "service-{repo}"
`;
    const config = parseConfig(content);

    expect(config.classification!.patterns).toBeUndefined();
    expect(config.classification!.explicit).toBeUndefined();
    expect(config.classification!.default).toBe("service-{repo}");
  });

  it("returns empty config for empty content", () => {
    const config = parseConfig("");
    expect(config.classification).toBeUndefined();
  });

  it("ignores comment lines", () => {
    const content = `# This is a comment
classification:
  # Another comment
  patterns:
    - match: "^infra-(.*)"
      namespace: "foundation"
`;
    const config = parseConfig(content);
    expect(config.classification!.patterns).toHaveLength(1);
  });

  it("handles values without quotes", () => {
    const content = `classification:
  default: service-{repo}
`;
    const config = parseConfig(content);
    expect(config.classification!.default).toBe("service-{repo}");
  });

  it("handles single-quoted values", () => {
    const content = `classification:
  default: 'service-{repo}'
`;
    const config = parseConfig(content);
    expect(config.classification!.default).toBe("service-{repo}");
  });
});

describe("buildNamespaceConfig", () => {
  it("returns empty config when no classification section", () => {
    const nsConfig = buildNamespaceConfig({});
    expect(nsConfig.customClassifier).toBeUndefined();
    expect(nsConfig.groupByRepo).toBeUndefined();
  });

  it("creates a classifier that applies explicit mappings first", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        patterns: [{ match: "^infra-(.*)", namespace: "foundation" }],
        explicit: { "infra-special": "platform" },
        default: "service-{repo}",
      },
    });

    // Explicit takes priority over pattern match
    const result = nsConfig.customClassifier!(makeNode("infra-special"));
    expect(result).toBe("platform");
  });

  it("creates a classifier that applies patterns with capture groups", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        patterns: [
          { match: "^infra-(.*)", namespace: "foundation" },
          { match: "^(team|squad|service|svc|app)-(.+)", namespace: "service-$2" },
        ],
        default: "service-{repo}",
      },
    });

    expect(nsConfig.customClassifier!(makeNode("infra-central"))).toBe("foundation");
    expect(nsConfig.customClassifier!(makeNode("service-orders"))).toBe("service-orders");
    expect(nsConfig.customClassifier!(makeNode("app-analytics"))).toBe("service-analytics");
    expect(nsConfig.customClassifier!(makeNode("team-payments"))).toBe("service-payments");
  });

  it("applies default pattern when no pattern matches", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        patterns: [{ match: "^infra-(.*)", namespace: "foundation" }],
        default: "service-{repo}",
      },
    });

    expect(nsConfig.customClassifier!(makeNode("my-random-repo"))).toBe("service-my-random-repo");
  });

  it("uses 'service-{repo}' as default when no default is specified", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        patterns: [],
      },
    });

    expect(nsConfig.customClassifier!(makeNode("unknown-repo"))).toBe("service-unknown-repo");
  });

  it("sets groupByRepo to true", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        default: "service-{repo}",
      },
    });

    expect(nsConfig.groupByRepo).toBe(true);
  });

  it("handles pattern with $1 capture group", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        patterns: [{ match: "^shared-(.*)", namespace: "platform-$1" }],
      },
    });

    expect(nsConfig.customClassifier!(makeNode("shared-networking"))).toBe("platform-networking");
  });

  it("patterns are evaluated in order (first match wins)", () => {
    const nsConfig = buildNamespaceConfig({
      classification: {
        patterns: [
          { match: "^service-auth$", namespace: "foundation" },
          { match: "^service-(.*)", namespace: "service-$1" },
        ],
      },
    });

    // First pattern matches service-auth specifically
    expect(nsConfig.customClassifier!(makeNode("service-auth"))).toBe("foundation");
    // Second pattern matches other service-* repos
    expect(nsConfig.customClassifier!(makeNode("service-orders"))).toBe("service-orders");
  });
});

describe("loadConfigFile", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("loads and parses a config file from disk", async () => {
    const configContent = `classification:
  patterns:
    - match: "^infra-(.*)"
      namespace: "foundation"
  explicit:
    my-repo: "platform"
  default: "service-{repo}"
`;
    const configPath = join(testDir, ".tf-mover.yaml");
    await writeFile(configPath, configContent);

    const config = await loadConfigFile(configPath);

    expect(config.classification).toBeDefined();
    expect(config.classification!.patterns).toHaveLength(1);
    expect(config.classification!.explicit).toEqual({ "my-repo": "platform" });
    expect(config.classification!.default).toBe("service-{repo}");
  });

  it("throws when file does not exist", async () => {
    const configPath = join(testDir, "nonexistent.yaml");
    await expect(loadConfigFile(configPath)).rejects.toThrow();
  });
});
