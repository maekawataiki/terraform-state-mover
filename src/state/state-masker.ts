/**
 * Sensitive value masking for Terraform state data.
 *
 * Terraform state files contain raw secret values (DB passwords, API keys,
 * private keys, etc.). This module ensures these never appear in logs,
 * reports, or error messages.
 */

/** Attribute names that commonly hold secrets in Terraform state. */
const SENSITIVE_ATTRIBUTE_PATTERNS = [
  "password",
  "secret",
  "private_key",
  "access_key",
  "secret_key",
  "token",
  "api_key",
  "auth_token",
  "connection_string",
  "credentials",
  "certificate_body",
  "certificate_chain",
  "certificate_private_key",
  "master_password",
  "db_password",
  "private_key_pem",
  "tls_private_key",
  "ssh_private_key",
  "client_secret",
  "sensitive",
] as const;

const MASK = "***REDACTED***";

/**
 * Check if an attribute name is likely to contain sensitive data.
 */
export function isSensitiveAttribute(attributeName: string): boolean {
  const lower = attributeName.toLowerCase();
  return SENSITIVE_ATTRIBUTE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Mask sensitive values in a state resource's attributes object.
 * Returns a new object with sensitive values replaced by MASK.
 * Non-sensitive values are preserved as-is.
 */
export function maskAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isSensitiveAttribute(key)) {
      masked[key] = MASK;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      masked[key] = maskAttributes(value as Record<string, unknown>);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Mask all sensitive values in a raw Terraform state JSON string.
 * Use this before logging or including state content in error messages.
 */
export function maskStateJson(json: string): string {
  try {
    const state = JSON.parse(json);
    if (state.resources && Array.isArray(state.resources)) {
      for (const resource of state.resources) {
        if (resource.instances && Array.isArray(resource.instances)) {
          for (const instance of resource.instances) {
            if (instance.attributes && typeof instance.attributes === "object") {
              instance.attributes = maskAttributes(instance.attributes);
            }
          }
        }
      }
    }
    return JSON.stringify(state);
  } catch {
    // If JSON parsing fails, redact the entire string to prevent leak
    return "[STATE CONTENT REDACTED - PARSE ERROR]";
  }
}

/**
 * Sanitize a string that might contain state values (for use in error messages).
 * Scans for common secret patterns and redacts them.
 */
export function sanitizeForLog(message: string): string {
  // Redact AWS-style access keys (AKIA...)
  let sanitized = message.replace(/AKIA[A-Z0-9]{16}/g, "AKIA" + MASK);

  // Redact long base64-ish strings that look like private keys
  sanitized = sanitized.replace(
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    "-----BEGIN REDACTED PRIVATE KEY-----",
  );

  // Redact strings that look like passwords in key=value patterns
  sanitized = sanitized.replace(
    /(password|secret|token|api_key|private_key)\s*[:=]\s*"[^"]*"/gi,
    `$1: "${MASK}"`,
  );

  return sanitized;
}
