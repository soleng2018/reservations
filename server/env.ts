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

const hours = (fallback: number) =>
  z.coerce.number().int().min(1).max(24).default(fallback);

// Web only. The Authentik master token is deliberately absent (spec 0003):
// only scripts/authentik-setup.ts reads it.
const authSchema = z.object({
  APP_URL: z.url().transform((u) => new URL(u).origin),
  ADMIN_ENTRY_PATH: z
    .string()
    .regex(/^\/[A-Za-z0-9_-]+$/, "a single path segment like /l0gin")
    .default("/l0gin"),
  AUTHENTIK_URL: z.url().transform((u) => new URL(u).origin),
  AUTHENTIK_CLIENT_ID: z.string().min(1),
  AUTHENTIK_CLIENT_SECRET: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  ADMIN_SESSION_HOURS: hours(2),
  LEARNER_SESSION_HOURS: hours(8),
});

export type AuthEnv = z.infer<typeof authSchema>;

let cachedAuth: AuthEnv | undefined;

export function authEnv(): AuthEnv {
  cachedAuth ??= authSchema.parse({
    APP_URL: process.env.APP_URL,
    ADMIN_ENTRY_PATH: process.env.ADMIN_ENTRY_PATH || undefined,
    AUTHENTIK_URL: process.env.AUTHENTIK_URL,
    AUTHENTIK_CLIENT_ID: process.env.AUTHENTIK_CLIENT_ID,
    AUTHENTIK_CLIENT_SECRET: secret("AUTHENTIK_CLIENT_SECRET"),
    AUTH_SECRET: secret("AUTH_SECRET"),
    ADMIN_SESSION_HOURS: process.env.ADMIN_SESSION_HOURS || undefined,
    LEARNER_SESSION_HOURS: process.env.LEARNER_SESSION_HOURS || undefined,
  });
  return cachedAuth;
}

// The provisioning token only: RBAC limited, and every write it makes passes
// server/authentik/guard.ts (spec 0003). Used by web and worker.
const authentikSchema = z.object({
  AUTHENTIK_URL: z.url().transform((u) => new URL(u).origin),
  AUTHENTIK_PROVISIONING_TOKEN: z.string().min(1),
});

export type AuthentikEnv = z.infer<typeof authentikSchema>;

let cachedAuthentik: AuthentikEnv | undefined;

export function authentikEnv(): AuthentikEnv {
  cachedAuthentik ??= authentikSchema.parse({
    AUTHENTIK_URL: process.env.AUTHENTIK_URL,
    AUTHENTIK_PROVISIONING_TOKEN: secret("AUTHENTIK_PROVISIONING_TOKEN"),
  });
  return cachedAuthentik;
}

// Cloudflare Turnstile (spec 0001). Dev uses Cloudflare's test keys.
const turnstileSchema = z.object({
  TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
});

export type TurnstileEnv = z.infer<typeof turnstileSchema>;

let cachedTurnstile: TurnstileEnv | undefined;

export function turnstileEnv(): TurnstileEnv {
  cachedTurnstile ??= turnstileSchema.parse({
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: secret("TURNSTILE_SECRET_KEY"),
  });
  return cachedTurnstile;
}

// The admin entry path only, for proxy.ts (it must not need the auth secrets).
export function adminEntryPath(): string {
  return authSchema.shape.ADMIN_ENTRY_PATH.parse(
    process.env.ADMIN_ENTRY_PATH || undefined,
  );
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
