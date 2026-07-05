import type { ParsedFile, StateResource, StateFile } from "../types.js";

export type { StateResource, StateFile } from "../types.js";

export function parseStateJson(json: string, repo: string): StateFile {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(json);
  } catch {
    // Never leak raw state content in error messages — it may contain secrets
    throw new Error(
      `Failed to parse state JSON for "${repo}": invalid JSON format. ` +
      `Ensure the file is valid output of \`terraform state pull\`.`,
    );
  }
  const resources: StateResource[] = [];

  for (const resource of (state.resources ?? []) as Array<Record<string, unknown>>) {
    const type = resource.type as string;
    const name = resource.name as string;
    const baseAddress = `${type}.${name}`;

    for (const instance of (resource.instances ?? []) as Array<Record<string, unknown>>) {
      const attributes = (instance.attributes ?? {}) as Record<string, unknown>;
      const arn = (attributes.arn ?? attributes.id ?? undefined) as string | undefined;

      // Resolve indexed address for count/for_each resources
      let address = baseAddress;
      if (instance.index_key !== undefined) {
        if (typeof instance.index_key === "number") {
          address = `${baseAddress}[${instance.index_key}]`;
        } else if (typeof instance.index_key === "string") {
          // Escape backslashes and quotes in for_each keys to produce valid state addresses
          const escaped = instance.index_key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          address = `${baseAddress}["${escaped}"]`;
        }
        // Other types (null, boolean, object) are ignored — not valid state index keys
      }

      resources.push({ address, type, name, arn, attributes });
    }
  }

  return { resources, repo };
}

export function buildArnMap(stateFiles: StateFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sf of stateFiles) {
    for (const r of sf.resources) {
      if (r.arn) {
        map.set(`${sf.repo}:${r.address}`, r.arn);
      }
    }
  }
  return map;
}

export function enrichWithState(parsedFiles: ParsedFile[], stateFiles: StateFile[]): ParsedFile[] {
  // Build a lookup: repo+address → ARN
  const arnByRepoAddress = new Map<string, string>();
  for (const sf of stateFiles) {
    for (const r of sf.resources) {
      if (r.arn) {
        arnByRepoAddress.set(`${sf.repo}:${r.address}`, r.arn);
      }
    }
  }

  return parsedFiles.map((file) => ({
    ...file,
    blocks: file.blocks.map((block) => {
      if (block.type !== "resource") return block;
      const key = `${file.repo}:${block.resourceType}.${block.name}`;
      const arn = arnByRepoAddress.get(key);
      if (arn && !block.arns.includes(arn)) {
        return { ...block, arns: [...block.arns, arn] };
      }
      return block;
    }),
  }));
}
