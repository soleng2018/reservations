import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

// A direct database connection for the few e2e fixtures the app can't make
// through its UI (spec 0014: a set password link whose token the test knows,
// since the real one only exists in an inbox). Read from .env.local, like
// `npm run dev`; without it the suites that need it skip. Dev and prod share
// one database, so fixtures belong to `dev-` or `hol-test-` learners only.
const env = (() => {
  const file = join(process.cwd(), ".env.local");
  if (!existsSync(file)) return undefined;
  const pairs = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1] ?? "", (m[2] ?? "").trim()] as const);
  return Object.fromEntries(pairs);
})();

const password = (() => {
  const file = env?.DATABASE_PASSWORD_FILE?.replace(/^~/, homedir());
  return file && existsSync(file)
    ? readFileSync(file, "utf8").trim()
    : undefined;
})();

export const haveDb = Boolean(env?.DATABASE_HOST && password);

export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: env?.DATABASE_HOST,
    port: Number(env?.DATABASE_PORT ?? 5432),
    database: env?.DATABASE_NAME,
    user: env?.DATABASE_USER,
    password,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// The booking limits (spec 0004 AC-4) are per IP and per email. In dev every
// request shares the one `untrusted` IP bucket (server/request-ip.ts), so one
// full run of the booking specs would trip the 5 per 10 minutes limit and fail
// the later ones with "Please try again in a little while". The specs that
// book clear it first. Only the dev bucket and the fixture learner's email
// bucket go; a real address's bucket is never touched.
export async function resetDevBookingLimits(): Promise<void> {
  if (!haveDb) return;
  await withDb((c) =>
    c.query(
      `delete from hol_app.rate_limits
        where bucket_key like '%:ip:untrusted'
           or bucket_key like '%:email:hol-test-learner@example.test'`,
    ),
  );
}
