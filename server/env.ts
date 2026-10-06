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

// Parsed lazily on first use, never at import, so `next build` needs no values.
export function dbEnv(): DbEnv {
  cached ??= dbSchema.parse({
    ...process.env,
    DATABASE_PASSWORD: secret("DATABASE_PASSWORD"),
  });
  return cached;
}
