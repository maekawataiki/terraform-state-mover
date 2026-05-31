/**
 * Simple logger that suppresses output when NODE_ENV=test.
 * CLI uses this instead of console.log directly.
 */

const isTest = process.env.NODE_ENV === "test";

export const logger = {
  log(...args: unknown[]): void {
    if (!isTest) console.log(...args);
  },
  error(...args: unknown[]): void {
    if (!isTest) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (!isTest) console.warn(...args);
  },
};
