import "server-only";
import { readFileSync } from "node:fs";
import { z } from "zod";

// Secrets arrive as `NAME_FILE` paths (compose secrets). A plain `NAME` is
// accepted too, for local dev only.
function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return process.env[name];
}

const dbSchema = z.object({
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().min(1).default("insforge"),
  DATABASE_USER: z.string().min(1).default("hol_app"),
  DATABASE_PASSWORD: z.string().min(1),
});

export type DbEnv = z.infer<typeof dbSchema>;

let cached: DbEnv | undefined;

// True when a database is configured. DB integration tests skip without one (CI).
export function hasDbEnv(): boolean {
  return Boolean(process.env.DATABASE_HOST);
}

// Parsed lazily on first use, never at import, so `next build` needs no values.
// Shared by web, worker, and the migrate script.
export function dbEnv(): DbEnv {
  cached ??= dbSchema.parse({
    DATABASE_HOST: process.env.DATABASE_HOST,
    DATABASE_PORT: process.env.DATABASE_PORT,
    DATABASE_NAME: process.env.DATABASE_NAME,
    DATABASE_USER: process.env.DATABASE_USER,
    DATABASE_PASSWORD: secret("DATABASE_PASSWORD"),
  });
  return cached;
}
