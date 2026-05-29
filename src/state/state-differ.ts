import { parseStateJson } from "./state-reader.js";

export function verifyMigration(opts: {
  expectedResources: string[];
  targetStateJson: string;
}): { missing: string[]; extra: string[]; verified: string[] } {
  const stateFile = parseStateJson(opts.targetStateJson, "target");
  const actual = new Set(stateFile.resources.map((r) => r.address));

  const expected = new Set(opts.expectedResources);
  const verified: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  for (const addr of expected) {
    if (actual.has(addr)) {
      verified.push(addr);
    } else {
      missing.push(addr);
    }
  }

  for (const addr of actual) {
    if (!expected.has(addr)) {
      extra.push(addr);
    }
  }

  return { missing, extra, verified };
}
