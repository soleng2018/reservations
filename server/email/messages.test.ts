import { sql } from "kysely";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { listUserEmails, listUserEmailsQuery } from "./messages";

// covers: spec 0013 AC-21
describe("listUserEmailsQuery (spec 0013 AC-21)", () => {
  it("never reads the details snapshot, which holds the lab links", () => {
    const offline = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const compiled = listUserEmailsQuery(
      offline,
      crypto.randomUUID(),
    ).compile();
    expect(compiled.sql).not.toContain("details");
    expect(compiled.sql).toContain("limit");
  });
});

describe.skipIf(!hasDb)("listUserEmails (spec 0013 AC-21)", () => {
  afterAll(() => db().destroy());

  it("lists the learner's emails newest first, showing where each went", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx);
      const other = await makeUser(trx);
      const row = (
        kind: string,
        status: string,
        minutesAgo: number,
        extra: { sent_to?: string; last_error?: string } = {},
      ) => ({
        user_id: user.id,
        kind,
        status,
        to_address: user.email,
        subject: `${kind} subject`,
        details: JSON.stringify({}),
        created_at: sql<Date>`now() - make_interval(mins => ${minutesAgo})`,
        ...extra,
      });
      await trx
        .insertInto("email_messages")
        .values([
          row("booked", "sent", 30, { sent_to: "dev-inbox@nile.example" }),
          row("rescheduled", "failed", 20, {
            last_error: "Gmail refused the message (400).",
          }),
          row("cancelled", "suppressed", 10, {
            last_error: "The booking had already ended.",
          }),
          { ...row("welcome", "queued", 5), user_id: other.id },
        ])
        .execute();
      const emails = await listUserEmails(trx, user.id);
      expect(emails.map((e) => [e.kind, e.status, e.to, e.lastError])).toEqual([
        [
          "cancelled",
          "suppressed",
          user.email,
          "The booking had already ended.",
        ],
        [
          "rescheduled",
          "failed",
          user.email,
          "Gmail refused the message (400).",
        ],
        ["booked", "sent", "dev-inbox@nile.example", null],
      ]);
      expect(await listUserEmails(trx, crypto.randomUUID())).toEqual([]);
    }));
});
