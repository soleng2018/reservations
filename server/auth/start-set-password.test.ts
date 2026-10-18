import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ADMINS, fakeAuthentik, fakeLearner } from "@/server/authentik/testing";
import { db } from "@/server/db";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { hourlyCount } from "@/server/rate-limit";
import { linkState, newToken } from "./set-password-links";
import {
  beginSetPassword,
  MISS_LIMIT,
  missKey,
  type StartDeps,
} from "./start-set-password";

// covers: spec 0014 AC-9, AC-10, AC-12, AC-13, AC-18 (the click), with the
// fake Authentik and a stand in for Better Auth's signInSocial.

const AUTHORIZE =
  "https://auth.test/application/o/authorize/?response_type=code&state=s1";

let pks = 700_000 + Math.floor(Math.random() * 99_999);
const nextPk = () => (pks += 1);

// A pending learner in the app and in the fake Authentik.
async function learner(
  trx: Transaction<DB>,
  over: Parameters<typeof makeUser>[1] = {},
) {
  const pk = nextPk();
  const user = await makeUser(trx, {
    email: `Pat-${crypto.randomUUID().slice(0, 6)}@Acme.com`,
    authentik_user_pk: pk,
    set_password_pending: true,
    ...over,
  });
  return { user, pk };
}

// A sent welcome and its link, as the handler writes them.
async function sentLink(
  trx: Kysely<DB>,
  user: { readonly id: string; readonly email: string },
  over: { readonly email?: string } = {},
) {
  const { token, hash } = newToken();
  const email = await trx
    .insertInto("email_messages")
    .values({
      user_id: user.id,
      kind: "welcome",
      to_address: user.email,
      sent_to: user.email,
      subject: "Set your password for Nile Hands-On Labs",
      details: JSON.stringify({ name: "Pat", expiresAt: "x", timeZone: "UTC" }),
      status: "sent",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const link = await trx
    .insertInto("set_password_links")
    .values({
      user_id: user.id,
      email_message_id: email.id,
      token_hash: hash,
      email: over.email ?? user.email.toLowerCase(),
      expires_at: sql<Date>`now() + interval '72 hours'`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, linkId: link.id };
}

const linkRow = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("set_password_links")
    .select(["ended_at", "ended_reason"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const deps = (
  trx: Transaction<DB>,
  api: StartDeps["api"],
  over: Partial<StartDeps> = {},
): StartDeps => ({
  conn: asConn(trx),
  api,
  ip: `test-${crypto.randomUUID()}`,
  startSignIn: async () => AUTHORIZE,
  ...over,
});

afterAll(() => (hasDb ? db().destroy() : undefined));
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!hasDb)("beginSetPassword (spec 0014 AC-10)", () => {
  it("issues a 10 minute recovery link with next, and ends this link and its siblings (AC-10, AC-13)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const first = await sentLink(trx, user);
      const second = await sentLink(trx, user);
      const d = deps(trx, ak.api);

      // The resend's link works too (AC-13).
      const r = await beginSetPassword(d, second.token);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const target = new URL(r.value);
      expect(target.origin).toBe("https://auth.test");
      expect(target.pathname).toBe(`/recover/${pk}`);
      expect(target.searchParams.get("for")).toBe("minutes=10");
      expect(target.searchParams.get("next")).toBe(
        "/application/o/authorize/?response_type=code&state=s1",
      );
      expect(ak.writes).toEqual([`POST /core/users/${pk}/recovery/`]);

      expect(await linkRow(trx, second.linkId)).toMatchObject({
        ended_reason: "used",
      });
      expect(await linkRow(trx, first.linkId)).toMatchObject({
        ended_reason: "other_used",
      });
      // Live clicks never count toward the miss limit.
      expect(await hourlyCount(trx, missKey(d.ip))).toBe(0);
    }));

  it("refuses a second click while the learner is still pending, and counts the miss (AC-12)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const { token } = await sentLink(trx, user);
      const d = deps(trx, ak.api);
      expect((await beginSetPassword(d, token)).ok).toBe(true);
      expect(await beginSetPassword(d, token)).toEqual({
        ok: false,
        error: "dead",
      });
      expect(await hourlyCount(trx, missKey(d.ip))).toBe(1);
      expect(ak.writes).toHaveLength(1);
    }));

  it("answers already_set once the learner has signed in (AC-9, AC-12)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const { token } = await sentLink(trx, user);
      const d = deps(trx, ak.api);
      expect((await beginSetPassword(d, token)).ok).toBe(true);
      await trx
        .updateTable("users")
        .set({ set_password_pending: false })
        .where("id", "=", user.id)
        .execute();
      expect(await beginSetPassword(d, token)).toEqual({
        ok: false,
        error: "already_set",
      });
      expect(await linkState(trx, token)).toEqual({ view: "already_set" });
    }));

  it("keeps the link live when Authentik is unavailable, and a second try works (AC-10)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      let down = true;
      const ak = fakeAuthentik([fakeLearner(pk)], {
        fail: (method, path) => down && path.endsWith("/recovery/"),
      });
      const { token, linkId } = await sentLink(trx, user);
      const d = deps(trx, ak.api);
      expect(await beginSetPassword(d, token)).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect(await linkRow(trx, linkId)).toEqual({
        ended_at: null,
        ended_reason: null,
      });
      down = false;
      expect((await beginSetPassword(d, token)).ok).toBe(true);
      expect(await hourlyCount(trx, missKey(d.ip))).toBe(0);
    }));

  it("keeps the link live when sign in can't start (AC-10)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const { token, linkId } = await sentLink(trx, user);
      const r = await beginSetPassword(
        deps(trx, ak.api, { startSignIn: async () => undefined }),
        token,
      );
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(await linkRow(trx, linkId)).toMatchObject({ ended_at: null });
    }));

  it("answers dead when the guard refuses, and issues nothing (AC-10)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk, { groups: [ADMINS.pk] })]);
      const { token } = await sentLink(trx, user);
      expect(await beginSetPassword(deps(trx, ak.api), token)).toEqual({
        ok: false,
        error: "dead",
      });
      expect(ak.writes).toEqual([]);
    }));

  it("throws when the authorize origin is not the recovery origin, and ends nothing (AC-10)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const { token, linkId } = await sentLink(trx, user);
      await expect(
        beginSetPassword(
          deps(trx, ak.api, {
            startSignIn: async () =>
              "https://other.test/application/o/authorize/?state=s",
          }),
          token,
        ),
      ).rejects.toThrow(/same public host/);
      expect(await linkRow(trx, linkId)).toMatchObject({ ended_at: null });
    }));

  it.each([
    ["an unknown token", "unknown"],
    ["a malformed token", "malformed"],
    ["an expired link", "expired"],
    ["a deactivated learner", "deactivated"],
    ["an address that no longer matches", "moved"],
  ] as const)("answers the same dead for %s (AC-9)", (_why, kind) =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const { token, linkId } = await sentLink(
        trx,
        user,
        kind === "moved" ? { email: "old@acme.com" } : {},
      );
      if (kind === "expired")
        await trx
          .updateTable("set_password_links")
          .set({ expires_at: sql<Date>`now()` })
          .where("id", "=", linkId)
          .execute();
      if (kind === "deactivated")
        await trx
          .updateTable("users")
          .set({ status: "deactivated", deactivated_at: sql<Date>`now()` })
          .where("id", "=", user.id)
          .execute();
      const clicked =
        kind === "unknown"
          ? newToken().token
          : kind === "malformed"
            ? "not-a-token"
            : token;
      expect(await beginSetPassword(deps(trx, ak.api), clicked)).toEqual({
        ok: false,
        error: "dead",
      });
      expect(ak.writes).toEqual([]);
    }),
  );

  it("limits misses per IP, and live clicks from that IP never count (AC-10)", () =>
    inRollback(async (trx) => {
      const { user, pk } = await learner(trx);
      const ak = fakeAuthentik([fakeLearner(pk)]);
      const { token } = await sentLink(trx, user);
      const d = deps(trx, ak.api);
      for (let i = 0; i < MISS_LIMIT - 1; i += 1)
        expect(await beginSetPassword(d, "not-a-token")).toMatchObject({
          error: "dead",
        });
      // A real click among the misses still works.
      expect((await beginSetPassword(d, token)).ok).toBe(true);
      expect(await hourlyCount(trx, missKey(d.ip))).toBe(MISS_LIMIT - 1);
      expect(await beginSetPassword(d, "not-a-token")).toMatchObject({
        error: "dead",
      });
      expect(await beginSetPassword(d, newToken().token)).toEqual({
        ok: false,
        error: "limited",
      });
      // Another IP is not limited.
      expect(
        await beginSetPassword(
          { ...d, ip: `test-${crypto.randomUUID()}` },
          "x",
        ),
      ).toMatchObject({ error: "dead" });
    }));

  it("writes the token to no audit row or log (AC-18)", () =>
    inRollback(async (trx) => {
      const lines: string[] = [];
      for (const level of ["log", "info", "warn", "error"] as const)
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      const { user, pk } = await learner(trx);
      let down = true;
      const ak = fakeAuthentik([fakeLearner(pk)], {
        fail: (_m, path) => down && path.endsWith("/recovery/"),
      });
      const { token } = await sentLink(trx, user);
      const d = deps(trx, ak.api);
      await beginSetPassword(d, token);
      down = false;
      await beginSetPassword(d, token);
      await beginSetPassword(d, token);
      const stored = JSON.stringify([
        await trx
          .selectFrom("audit_events")
          .selectAll()
          .where("target_id", "=", user.id)
          .execute(),
        await trx
          .selectFrom("rate_limits")
          .selectAll()
          .where("bucket_key", "=", missKey(d.ip))
          .execute(),
        lines,
      ]);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain("/set-password/");
    }));
});
