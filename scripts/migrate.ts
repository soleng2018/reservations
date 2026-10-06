// Applies db/migrations/NNNN_name.sql forward only, as the hol_app role.
// Run by the `migrate` compose service (or `npm run db:migrate`), never by dev.
// Take a pg_dump first: dev and production share one database.
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { Pool } from "pg";

const dir = path.resolve(process.cwd(), "db/migrations");

class SqlFileProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const text = await readFile(path.join(dir, file), "utf8");
      migrations[file.replace(/\.sql$/, "")] = {
        up: async (trx) => {
          await sql.raw(text).execute(trx);
        },
      };
    }
    return migrations;
  }
}

function password(): string {
  const file = process.env.DATABASE_PASSWORD_FILE;
  const value = file ? readFileSync(file, "utf8").trim() : process.env.DATABASE_PASSWORD;
  if (!value) throw new Error("Set DATABASE_PASSWORD_FILE (or DATABASE_PASSWORD in dev)");
  return value;
}

async function main() {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({
        host: process.env.DATABASE_HOST ?? "127.0.0.1",
        port: Number(process.env.DATABASE_PORT ?? 5432),
        database: process.env.DATABASE_NAME ?? "insforge",
        user: process.env.DATABASE_USER ?? "hol_app",
        password: password(),
        max: 1,
      }),
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new SqlFileProvider(),
    migrationTableSchema: "hol_app",
  });

  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    console.log(`${r.status === "Success" ? "applied" : r.status}: ${r.migrationName}`);
  }
  if (!results?.length && !error) console.log("nothing to apply");
  await db.destroy();
  if (error) {
    console.error("migration failed:", error);
    process.exit(1);
  }
}

main();
