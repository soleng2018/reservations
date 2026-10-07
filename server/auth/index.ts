import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { Pool } from "pg";
import { db } from "@/server/db";
import { authEnv, dbEnv } from "@/server/env";
import {
  AUTHENTIK_PROVIDER_ID,
  onSessionCreate,
  validateSignIn,
} from "./sign-in";

// Better Auth writes unqualified table names, so it gets its own small pool
// pinned to the hol_auth schema (spec 0001: Better Auth tables live there).
function authPool(): Pool {
  const env = dbEnv();
  const pool = new Pool({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    options: "-c search_path=hol_auth",
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => console.error("auth pool: idle client error", err));
  return pool;
}

function createAuth() {
  const env = authEnv();
  const hours = {
    admin: env.ADMIN_SESSION_HOURS,
    learner: env.LEARNER_SESSION_HOURS,
  };
  const longest = Math.max(hours.admin, hours.learner) * 3600;

  return betterAuth({
    appName: "Nile Hands-On Lab",
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: authPool(),
    // Authentik is the only way in: no passwords in the app (AC-1).
    emailAndPassword: { enabled: false },
    session: {
      // The real expiry is set per role in the create hook. No sliding:
      // updateAge is never reached before a session ends (AC-11).
      expiresIn: longest,
      updateAge: longest,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    user: {
      validateUserInfo: async ({ source }) => {
        if (source.oauth?.providerId !== AUTHENTIK_PROVIDER_ID)
          return { error: "not_authorized" };
        const reason = await validateSignIn(db(), source.oauth.profile);
        return reason ? { error: reason } : undefined;
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const expiresAt = await onSessionCreate(
              db(),
              session.userId,
              hours,
            );
            return expiresAt ? { data: { ...session, expiresAt } } : false;
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: AUTHENTIK_PROVIDER_ID,
            discoveryUrl: `${env.AUTHENTIK_URL}/application/o/hol/.well-known/openid-configuration`,
            requireIdTokenVerification: true,
            clientId: env.AUTHENTIK_CLIENT_ID,
            clientSecret: env.AUTHENTIK_CLIENT_SECRET,
            scopes: ["openid", "email", "profile"],
            overrideUserInfo: true,
          },
        ],
      }),
      nextCookies(), // last, so Server Actions can set the session cookie
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Created on first use (never at import, so `next build` needs no secrets),
// and cached on globalThis so dev reloads reuse one pool.
const cache = globalThis as typeof globalThis & { holAuth?: Auth };

export function auth(): Auth {
  cache.holAuth ??= createAuth();
  return cache.holAuth;
}
