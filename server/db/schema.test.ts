import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { hasDb } from "./testing";

// AC-10: only the owner touches hol_app; RLS is on everywhere. Reruns as each
// later migration lands, so a new table without RLS or with a stray grant fails.
describe.skipIf(!hasDb)("hol_app schema security", () => {
  afterAll(() => db().destroy());

  it("enables RLS on every table", async () => {
    const { rows } = await sql<{ relname: string; relrowsecurity: boolean }>`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'hol_app' and c.relkind = 'r'`.execute(db());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("grants table privileges to hol_app only", async () => {
    const { rows } = await sql<{ grantee: string }>`
      select distinct grantee from information_schema.role_table_grants
      where table_schema = 'hol_app'`.execute(db());
    expect(rows.map((r) => r.grantee)).toEqual(["hol_app"]);
  });

  it("defines no RLS policies", async () => {
    const { rows } = await sql`
      select policyname from pg_policies where schemaname = 'hol_app'`.execute(
      db(),
    );
    expect(rows).toEqual([]);
  });
});
