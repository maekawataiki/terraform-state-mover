import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { NamespaceConfig, Namespace, GraphNode, TfMoverConfig } from "../types.js";

export type { TfMoverConfig } from "../types.js";

/**
 * Parse a .tf-mover.yaml config file content.
 */
export function parseConfig(content: string): TfMoverConfig {
  const raw = parseYaml(content) as Record<string, unknown> | null;
  if (!raw) return {};

  const config: TfMoverConfig = {};
  const classification = raw.classification as Record<string, unknown> | undefined;

  if (classification) {
    config.classification = {};

    if (Array.isArray(classification.patterns)) {
      config.classification.patterns = classification.patterns.map((p: { match: string; namespace: string }) => ({
        match: String(p.match),
        namespace: String(p.namespace),
      }));
    }

    if (classification.explicit && typeof classification.explicit === "object") {
      config.classification.explicit = {};
      for (const [key, value] of Object.entries(classification.explicit as Record<string, string>)) {
        config.classification.explicit[key] = String(value);
      }
    }

    if (typeof classification.default === "string") {
      config.classification.default = classification.default;
    }
  }

  return config;
}

/**
 * Build a NamespaceConfig from a TfMoverConfig.
 * Patterns are compiled into a customClassifier function.
 */
export function buildNamespaceConfig(config: TfMoverConfig): NamespaceConfig {
  const classification = config.classification;
  if (!classification) return {};

  const compiledPatterns = (classification.patterns || []).map((p) => ({
    regex: new RegExp(p.match),
    namespace: p.namespace,
  }));

  const explicit = classification.explicit || {};
  const defaultPattern = classification.default || "service-{repo}";

  const customClassifier = (node: GraphNode): Namespace | null => {
    // Check explicit mapping first
    if (explicit[node.repo]) {
      return explicit[node.repo] as Namespace;
    }

    // Check patterns
    for (const { regex, namespace } of compiledPatterns) {
      const match = node.repo.match(regex);
      if (match) {
        // Replace $1, $2, etc. with capture groups
        let resolved = namespace;
        for (let i = 1; i < match.length; i++) {
          resolved = resolved.replace(`$${i}`, match[i] || "");
        }
        return resolved as Namespace;
      }
    }

    // Apply default pattern
    const resolved = defaultPattern.replace("{repo}", node.repo);
    return resolved as Namespace;
  };

  return {
    customClassifier,
    groupByRepo: true,
  };
}

/**
 * Load and parse a config file.
 */
export async function loadConfigFile(filePath: string): Promise<TfMoverConfig> {
  const content = await readFile(filePath, "utf-8");
  return parseConfig(content);
}
