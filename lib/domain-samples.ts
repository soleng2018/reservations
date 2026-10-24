// Test support only: the domain samples of spec 0017 AC-1, shared by the Zod
// input test (lib/catalog-input.test.ts) and the database check test
// (server/db/testbed-domain-schema.test.ts), so the two cannot drift apart.

export const VALID_DOMAINS = [
  "nile.global",
  "rw.nile.global",
  "nileworkshop-1.com",
  "a.bc",
  "1.2.co",
  `${"a".repeat(63)}.com`,
] as const;

export const INVALID_DOMAINS = [
  "nile",
  "a..b.com",
  "-a.com",
  "a-.com",
  "a_b.com",
  "nile.global.",
  "nile.c0m",
  "nile.c",
  "nile .global",
  `${"a".repeat(64)}.com`,
  `${"a.".repeat(126)}com`,
] as const;
