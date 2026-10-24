// Pure helpers behind `npm run db:up`, `db:bootstrap`, and `db:reset`
// (scripts/db.ts runs them). Kept free of I/O so they have plain tests.
import path from "node:path";

export const databaseName = "reservations";
export const secretNames = ["postgres_password", "hol_app_password"] as const;

// The SECRETS_DIR value in a docker/.env file, or undefined when it is absent
// or empty. Later lines win, and quotes around the value are dropped.
export function secretsDirFromEnv(envText: string): string | undefined {
  const values = envText
    .split(/\r?\n/)
    .map((line) => /^\s*SECRETS_DIR\s*=\s*(.*?)\s*$/.exec(line)?.[1])
    .filter((v): v is string => v !== undefined)
    .map((v) => v.replace(/^(["'])(.*)\1$/, "$2"))
    .filter((v) => v !== "");
  return values.at(-1);
}

// Compose resolves a relative SECRETS_DIR against the compose file's folder,
// and the default `../.secrets` lands in the repo root.
export function resolveSecretsDir(
  root: string,
  fromEnv: string | undefined,
): string {
  return path.resolve(path.join(root, "docker"), fromEnv ?? "../.secrets");
}

// What psql reads on stdin: the password as a psql variable, then the file.
// The password never reaches a command line. It must not contain a quote.
export function bootstrapInput(password: string, sqlText: string): string {
  if (password.includes("'") || /[\r\n]/.test(password)) {
    throw new Error("the hol_app password must not contain a quote or newline");
  }
  return `\\set pw '${password}'\n${sqlText}`;
}
