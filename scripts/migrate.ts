// Applies db/migrations/NNNN_name.sql forward only, as the hol_app role.
// Run by the `migrate` compose service (or `npm run db:migrate`), never by dev.
// Take a pg_dump first (scripts/deploy.sh does).
// Runs under `tsx --conditions=react-server` so `server-only` resolves to its
// empty stub. The image runs the bundled dist/migrate.mjs (scripts/bundle.ts).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
} from "kysely/migration";
import { createDb } from "@/server/db";
import { dbEnv } from "@/server/env";
import { seedPortalReset } from "@/server/portal-reset/seed";

const dir = path.resolve(process.cwd(), "db/migrations");

const sqlMigration = (text: string): Migration => ({
  up: async (trx) => {
    await sql.raw(text).execute(trx);
  },
});

const sqlFileProvider = (folder: string): MigrationProvider => ({
  getMigrations: async () => {
    const files = (await readdir(folder))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    const entries = await Promise.all(
      files.map(
        async (file) =>
          [
            file.replace(/\.sql$/, ""),
            sqlMigration(await readFile(path.join(folder, file), "utf8")),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  },
});

async function main(): Promise<number> {
  const db = createDb(dbEnv(), 1);
  try {
    const migrator = new Migrator({
      db,
      provider: sqlFileProvider(dir),
      migrationTableSchema: "hol_app",
    });
    const { error, results } = await migrator.migrateToLatest();
    (results ?? []).forEach((r) =>
      console.log(
        `${r.status === "Success" ? "applied" : r.status}: ${r.migrationName}`,
      ),
    );
    if (!results?.length && !error) console.log("nothing to apply");
    if (error) {
      console.error("migration failed:", error);
      return 1;
    }
    // Data the app ships with, loaded once (spec 0022). A bad starting list
    // file throws here, so the web container never starts on it.
    const seed = await seedPortalReset(db);
    if (seed.seeded) {
      console.log(`seeded: ${seed.inserted.length} Nile Portal Reset steps`);
    }
    return 0;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error("migrate:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
