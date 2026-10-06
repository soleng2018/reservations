import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { checkLists } from "@/lib/db-enums";
import { db } from "@/server/db";
import { hasDb } from "./testing";

// Every `col in (...)` CHECK in hol_app matches exactly one Zod enum.
describe.skipIf(!hasDb)("db enum parity", () => {
  afterAll(() => db().destroy());

  it("matches every CHECK list in hol_app", async () => {
    const { rows } = await sql<{ table: string; def: string }>`
      select c.relname as table, pg_get_constraintdef(k.oid) as def
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'hol_app' and k.contype = 'c'`.execute(db());

    const live = Object.fromEntries(
      rows.flatMap(({ table, def }) => {
        const m = /\((\w+) = ANY \(ARRAY\[(.*?)\]\)\)/.exec(def);
        if (!m) return [];
        const values = [...m[2].matchAll(/'([^']*)'::text/g)].map((v) => v[1]);
        return [[`${table}.${m[1]}`, values]];
      }),
    );

    expect(live).toEqual(checkLists);
  });
});
