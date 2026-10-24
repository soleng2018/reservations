// `npm run db:up | db:bootstrap | db:reset -- --yes` (spec 0001, Database
// container). They call `docker compose`, so they work on any OS with Docker.
// The superuser password and the hol_app password live in files under the
// secrets folder and never appear on a command line.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  bootstrapInput,
  databaseName,
  resolveSecretsDir,
  secretNames,
  secretsDirFromEnv,
} from "./db-container";

const root = path.resolve(import.meta.dirname, "..");
const composeFile = path.join(root, "docker", "compose.yaml");
const envFile = path.join(root, "docker", ".env");

const secretsDir = resolveSecretsDir(
  root,
  existsSync(envFile)
    ? secretsDirFromEnv(readFileSync(envFile, "utf8"))
    : undefined,
);

function compose(
  args: readonly string[],
  input?: string,
): { readonly ok: boolean } {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  return { ok: result.status === 0 };
}

// 32 random bytes as hex: no quote or backslash to trip the \set line.
function ensureSecrets(): void {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  secretNames
    .filter((name) => !existsSync(path.join(secretsDir, name)))
    .forEach((name) => {
      writeFileSync(
        path.join(secretsDir, name),
        `${randomBytes(32).toString("hex")}\n`,
        { mode: 0o600 },
      );
      console.log(`created ${path.join(secretsDir, name)}`);
    });
}

function bootstrap(): boolean {
  const password = readFileSync(
    path.join(secretsDir, "hol_app_password"),
    "utf8",
  ).trim();
  const sqlText = readFileSync(path.join(root, "db", "bootstrap.sql"), "utf8");
  return compose(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      databaseName,
    ],
    bootstrapInput(password, sqlText),
  ).ok;
}

function up(): boolean {
  ensureSecrets();
  return compose(["up", "-d", "--wait", "db"]).ok && bootstrap();
}

function reset(): boolean {
  if (!process.argv.includes("--yes")) {
    console.error(
      "db:reset deletes the database. Run `npm run db:reset -- --yes` to confirm.",
    );
    return false;
  }
  // Through Compose, never a hard coded volume name. The secret files stay, so
  // .env.local keeps working.
  return compose(["down", "-v", "db"]).ok && up();
}

const commands: Readonly<Record<string, () => boolean>> = {
  up,
  bootstrap: () => {
    ensureSecrets();
    return bootstrap();
  },
  reset,
};

const run = commands[process.argv[2] ?? ""];
if (!run) {
  console.error("usage: db.ts up | bootstrap | reset --yes");
  process.exit(2);
}
process.exit(run() ? 0 : 1);
