// Regenerates server/db/types.ts from the live hol_app and hol_auth schemas.
// `npm run db:codegen -- --verify` checks the file is current without writing.
// Builds DATABASE_URL from the same validated env the app uses, so the
// password file is read once here and never typed on a command line.
import { spawnSync } from "node:child_process";
import { dbEnv } from "@/server/env";

const env = dbEnv();
const url = new URL("postgres://");
url.hostname = env.DATABASE_HOST;
url.port = String(env.DATABASE_PORT);
url.pathname = `/${env.DATABASE_NAME}`;
url.username = env.DATABASE_USER;
url.password = env.DATABASE_PASSWORD;

const result = spawnSync(
  "kysely-codegen",
  [
    "--dialect=postgres",
    "--default-schema=hol_app",
    "--include-pattern={hol_app,hol_auth}.*",
    "--exclude-pattern=hol_app.kysely_migration*",
    "--out-file=server/db/types.ts",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url.toString() },
  },
);

process.exit(result.status ?? 1);
