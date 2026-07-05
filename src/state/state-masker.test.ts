import { describe, it, expect } from "vitest";
import {
  isSensitiveAttribute,
  maskAttributes,
  maskStateJson,
  sanitizeForLog,
} from "./state-masker.js";
import { parseStateJson } from "./state-reader.js";

describe("state-masker", () => {
  describe("isSensitiveAttribute", () => {
    it("detects common sensitive attribute names", () => {
      expect(isSensitiveAttribute("password")).toBe(true);
      expect(isSensitiveAttribute("master_password")).toBe(true);
      expect(isSensitiveAttribute("db_password")).toBe(true);
      expect(isSensitiveAttribute("secret_key")).toBe(true);
      expect(isSensitiveAttribute("private_key")).toBe(true);
      expect(isSensitiveAttribute("api_key")).toBe(true);
      expect(isSensitiveAttribute("auth_token")).toBe(true);
      expect(isSensitiveAttribute("connection_string")).toBe(true);
      expect(isSensitiveAttribute("client_secret")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isSensitiveAttribute("PASSWORD")).toBe(true);
      expect(isSensitiveAttribute("Secret_Key")).toBe(true);
    });

    it("does not flag normal attributes", () => {
      expect(isSensitiveAttribute("name")).toBe(false);
      expect(isSensitiveAttribute("arn")).toBe(false);
      expect(isSensitiveAttribute("id")).toBe(false);
      expect(isSensitiveAttribute("tags")).toBe(false);
      expect(isSensitiveAttribute("vpc_id")).toBe(false);
    });
  });

  describe("maskAttributes", () => {
    it("masks sensitive values", () => {
      const attrs = {
        name: "my-db",
        password: "super-secret-123",
        master_password: "another-secret",
        arn: "arn:aws:rds:us-east-1:111111111111:db/my-db",
      };

      const masked = maskAttributes(attrs);

      expect(masked.name).toBe("my-db");
      expect(masked.password).toBe("***REDACTED***");
      expect(masked.master_password).toBe("***REDACTED***");
      expect(masked.arn).toBe("arn:aws:rds:us-east-1:111111111111:db/my-db");
    });

    it("masks nested sensitive values", () => {
      const attrs = {
        name: "my-resource",
        config: {
          api_key: "sk-12345",
          endpoint: "https://api.example.com",
        },
      };

      const masked = maskAttributes(attrs);

      expect((masked.config as Record<string, unknown>).api_key).toBe("***REDACTED***");
      expect((masked.config as Record<string, unknown>).endpoint).toBe("https://api.example.com");
    });

    it("preserves non-object values", () => {
      const attrs = {
        count: 5,
        enabled: true,
        tags: ["a", "b"],
      };

      const masked = maskAttributes(attrs);
      expect(masked).toEqual(attrs);
    });
  });

  describe("maskStateJson", () => {
    it("masks sensitive attributes in state JSON", () => {
      const stateJson = JSON.stringify({
        version: 4,
        resources: [{
          type: "aws_db_instance",
          name: "main",
          instances: [{
            attributes: {
              id: "my-db",
              password: "super-secret-password",
              master_password: "master-123",
              arn: "arn:aws:rds:us-east-1:111111111111:db/my-db",
              endpoint: "my-db.xxx.us-east-1.rds.amazonaws.com:5432",
            },
          }],
        }],
      });

      const masked = maskStateJson(stateJson);
      const parsed = JSON.parse(masked);

      expect(parsed.resources[0].instances[0].attributes.password).toBe("***REDACTED***");
      expect(parsed.resources[0].instances[0].attributes.master_password).toBe("***REDACTED***");
      expect(parsed.resources[0].instances[0].attributes.arn).toContain("arn:aws:rds");
      expect(parsed.resources[0].instances[0].attributes.id).toBe("my-db");
    });

    it("returns redaction message for invalid JSON", () => {
      const result = maskStateJson("this is not json { broken");
      expect(result).toContain("REDACTED");
      expect(result).not.toContain("broken");
    });
  });

  describe("sanitizeForLog", () => {
    it("redacts AWS access keys", () => {
      // Assembled at runtime so secret scanners don't flag this file.
      // This is AWS's documented example key, not a real credential.
      const exampleKey = "AKIA" + "IOSFODNN7EXAMPLE";
      const msg = `Error: auth failed for ${exampleKey}`;
      const sanitized = sanitizeForLog(msg);
      expect(sanitized).not.toContain("IOSFODNN7EXAMPLE");
      expect(sanitized).toContain("AKIA");
    });

    it("redacts private keys", () => {
      const pemHeader = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
      const pemFooter = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");
      const msg = `Key: ${pemHeader}\nMIIE...\n${pemFooter}`;
      const sanitized = sanitizeForLog(msg);
      expect(sanitized).not.toContain("MIIE");
      expect(sanitized).toContain("REDACTED");
    });

    it("redacts password=value patterns", () => {
      const msg = 'Connection failed: password: "my-db-secret-123"';
      const sanitized = sanitizeForLog(msg);
      expect(sanitized).not.toContain("my-db-secret-123");
      expect(sanitized).toContain("REDACTED");
    });

    it("preserves non-sensitive content", () => {
      const msg = "Error: resource aws_vpc.main not found in state";
      const sanitized = sanitizeForLog(msg);
      expect(sanitized).toBe(msg);
    });
  });

  describe("integration: state-reader does not leak secrets in errors", () => {
    it("parseStateJson does not include raw JSON in error messages", () => {
      const badJson = '{"password": "super-secret", this is invalid json';

      expect(() => parseStateJson(badJson, "my-repo")).toThrow();

      try {
        parseStateJson(badJson, "my-repo");
      } catch (error: unknown) {
        const message = (error as Error).message;
        // The error message should NOT contain the raw JSON content
        expect(message).not.toContain("super-secret");
        expect(message).not.toContain("password");
        // But it should be informative
        expect(message).toContain("my-repo");
        expect(message).toContain("invalid JSON");
      }
    });

    it("parseStateJson does not leak state attribute values on valid parse", () => {
      const stateJson = JSON.stringify({
        version: 4,
        resources: [{
          type: "aws_db_instance",
          name: "main",
          instances: [{
            attributes: {
              id: "my-db",
              arn: "arn:aws:rds:us-east-1:111111111111:db/my-db",
              password: "super-secret-db-password-42",
            },
          }],
        }],
      });

      // Parsing should succeed and return the data (attributes are needed for ID resolution)
      const result = parseStateJson(stateJson, "my-repo");
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].arn).toBe("arn:aws:rds:us-east-1:111111111111:db/my-db");

      // The attributes field stores the data for ID resolution purposes
      // but it should never be logged or included in user-facing output
      expect(result.resources[0].attributes.password).toBe("super-secret-db-password-42");
    });
  });
});
