import type { Insertable, Kysely, Transaction } from "kysely";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bookings, DB } from "@/server/db/types";

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  // The signed in learner's users.id; undefined is anyone else, whom
  // requireLearner() redirects.
  learnerId: undefined as string | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/require", () => ({
  requireLearner: async () => {
    if (!ctx.learnerId) throw new Error("NEXT_REDIRECT");
    return { user: { id: ctx.learnerId, timezone: "America/New_York" } };
  },
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});
// The frame reads the session for its sign out button; the page is the test.
vi.mock("@/components/learner-frame", () => ({
  LearnerFrame: ({ children }: { readonly children: ReactNode }) => children,
}));

const { default: LabAccessPage } = await import("./page");
const { asConn, hasDb, inRollback, makeTestbed, makeType, makeUser, slot } =
  await import("@/server/db/testing");

const PORTAL = "https://detail-portal.example.test";

const withConn = (fn: (trx: Transaction<DB>) => Promise<void>) =>
  inRollback(async (trx) => {
    ctx.conn = asConn(trx);
    try {
      await fn(trx);
    } finally {
      ctx.conn = undefined;
      ctx.learnerId = undefined;
    }
  });

// A verified learner signed in, with a booking builder on one testbed.
async function signedIn(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id, { portal_url: PORTAL });
  const user = await makeUser(trx, { email_verified_at: new Date() });
  ctx.learnerId = user.id;
  const book = (
    from: number,
    to: number,
    extra: Partial<Insertable<Bookings>> = {},
  ) =>
    trx
      .insertInto("bookings")
      .values({
        user_id: user.id,
        testbed_id: testbed.id,
        testbed_type_id: type.id,
        starts_at: slot(from),
        ends_at: slot(to),
        status: "confirmed",
        ...extra,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  return { type, testbed, user, book };
}

const render = async (id: string) =>
  renderToStaticMarkup(
    await LabAccessPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    } as PageProps<"/reservations/[id]">),
  );

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

// covers: AC-7, AC-8
describe.skipIf(!hasDb)("/reservations/[id] (AC-7, AC-8)", () => {
  it("redirects anyone who is not a signed in learner", () =>
    withConn(async (trx) => {
      const { book } = await signedIn(trx);
      const b = await book(-1, 1);
      ctx.learnerId = undefined;
      await expect(render(b.id)).rejects.toThrow("NEXT_REDIRECT");
    }));

  it("is not found for another learner's, a cancelled, or a malformed id", () =>
    withConn(async (trx) => {
      const { book } = await signedIn(trx);
      const other = await makeUser(trx, { email_verified_at: new Date() });
      const theirs = await book(-1, 1, { user_id: other.id });
      const cancelled = await book(10, 12, {
        status: "cancelled",
        cancelled_at: new Date(),
        cancel_source: "learner",
      });
      for (const id of [theirs.id, cancelled.id, "not-a-booking"])
        await expect(render(id)).rejects.toMatchObject(NOT_FOUND);
    }));

  it("shows a Current booking with its links in the account zone", () =>
    withConn(async (trx) => {
      const { book, testbed, type } = await signedIn(trx);
      const b = await book(-1, 1);
      const html = await render(b.id);
      expect(html).toContain("All reservations");
      expect(html).toContain('href="/reservations"');
      expect(html).toContain(`<h1`);
      expect(html).toContain(testbed.name);
      expect(html).toContain(">Current<");
      expect(html).toContain(type.name);
      expect(html).toMatch(/E[DS]T/); // users.timezone, America/New_York
      expect(html).toContain("Testbed assigned");
      expect(html).toContain(`href="${PORTAL}"`);
      expect(html).toContain("Access can take up to a minute");
      expect(html).toContain("Close your lab tabs when your time ends.");
    }));

  it("shows an Upcoming booking with the start note", () =>
    withConn(async (trx) => {
      const { book } = await signedIn(trx);
      const html = await render((await book(10, 12)).id);
      expect(html).toContain(">Upcoming<");
      expect(html).toContain(
        "These links start working at your start time (allow up to a minute).",
      );
      expect(html).toContain(`href="${PORTAL}"`);
    }));

  it("shows a Past booking ended, with no URL anywhere in the page", () =>
    withConn(async (trx) => {
      const { book } = await signedIn(trx);
      const b = await book(-50, -48, { status: "completed" });
      const html = await render(b.id);
      expect(html).toContain(">Past<");
      expect(html).toContain("access is no longer active");
      expect(html).toContain(">Ended<");
      expect(html).not.toContain(PORTAL);
      expect(html).not.toContain("lms.example.test");
      // The only anchor left is the way back to the list.
      expect(html.match(/<a /g)).toHaveLength(1);
    }));
});
