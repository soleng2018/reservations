import "server-only";
import { randomInt } from "node:crypto";
import { sql, type Kysely } from "kysely";
import {
  DRAW_COUNT,
  drawNumbers,
  nameWords,
  nileLoginCandidates,
} from "@/lib/nile-login";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import { call, type AuthentikFailure, type CoreApi, type User } from "./client";
import { guardUserWrite } from "./guard";

// Spec 0019: one Authentik user per learner, whose username follows the
// domain of the booked testbed. Only the booking flows call
// `ensureNileLogin` (tests/nile-login-scan.test.ts), always inside their own
// transaction, with the learner row already locked.

export const BUDGET_MS = 15_000;
const MAX_ATTEMPTS = 3;

export type NileLoginError =
  | "unavailable" // Authentik down, no free login, or out of time
  | "refused" // the write guard: an admin or an untagged user
  // AC-3: the stored login is another Authentik user's now. The caller
  // writes the conflict audit row after its rollback.
  | {
      readonly taken: { readonly domain: string; readonly username: string };
    };

// What a rename changed, kept so a later failure can put it back (AC-4).
export type RenamedFrom = {
  readonly pk: number;
  readonly username: string;
  readonly attributes: Readonly<Record<string, unknown>>;
};

export type NileLoginSet = {
  readonly username: string;
  readonly numbered: boolean;
  readonly changed: boolean; // the Authentik username changed
  readonly renamedFrom: RenamedFrom | null;
};

export type NileLoginInput = {
  readonly userId: string;
  readonly pk: number;
  readonly name: string;
  readonly email: string;
  readonly domain: string;
};

const timedOut = Symbol("timed out");

// Runs `work` against a total time budget, so the locks the caller holds are
// not held for long (AC-2). A timed out call is left to finish on its own.
async function withinBudget<T>(work: Promise<T>): Promise<T | typeof timedOut> {
  const timer = new AbortController();
  const limit = new Promise<typeof timedOut>((resolve) => {
    const id = setTimeout(() => resolve(timedOut), BUDGET_MS);
    timer.signal.addEventListener("abort", () => clearTimeout(id));
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    timer.abort();
  }
}

// Authentik users other than `pk` that hold this exact username.
async function holdersOf(
  api: CoreApi,
  pk: number,
  username: string,
): Promise<Result<readonly User[], AuthentikFailure>> {
  const found = await call("users.list by username", () =>
    api.coreUsersList({ username, pageSize: 5 }),
  );
  return found.ok
    ? ok(
        found.value.results.filter(
          (u) => u.username === username && u.pk !== pk,
        ),
      )
    : found;
}

// The candidates nobody holds: asked of Authentik one by one by exact
// username, and of the table.
async function freeCandidates(
  api: CoreApi,
  trx: Kysely<DB>,
  input: NileLoginInput,
  candidates: readonly string[],
): Promise<Result<readonly string[], "unavailable">> {
  const [checked, stored] = await Promise.all([
    Promise.all(candidates.map((c) => holdersOf(api, input.pk, c))),
    trx
      .selectFrom("learner_domain_logins")
      .select("username")
      .where("username", "in", candidates)
      .where("user_id", "!=", input.userId)
      .execute(),
  ]);
  if (checked.some((r) => !r.ok)) return err("unavailable");
  const taken = new Set(stored.map((r) => r.username));
  return ok(
    candidates.filter(
      (c, i) =>
        !taken.has(c) &&
        (checked[i]?.ok ? checked[i].value.length === 0 : false),
    ),
  );
}

// AC-2, AC-10: pick a free login and claim it with an insert that cannot
// abort the transaction. No row back means another learner claimed it a
// moment ago, so draw again.
async function claimLogin(
  api: CoreApi,
  trx: Kysely<DB>,
  input: NileLoginInput,
  domain: string,
  draw: (below: number) => number,
  attempt: number,
): Promise<Result<string, NileLoginError>> {
  if (attempt >= MAX_ATTEMPTS) return err("unavailable");
  const candidates = nileLoginCandidates(
    { name: input.name, email: input.email, domain },
    drawNumbers(DRAW_COUNT, draw),
  );
  const free = await freeCandidates(api, trx, input, candidates);
  if (!free.ok) return free;
  const [username] = free.value;
  if (username === undefined) return err("unavailable");
  const row = await trx
    .insertInto("learner_domain_logins")
    .values({
      user_id: input.userId,
      domain,
      username,
      used_at: sql<Date>`now()`,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  return row
    ? ok(username)
    : claimLogin(api, trx, input, domain, draw, attempt + 1);
}

const refusalOf = (e: AuthentikFailure | "is_admin" | "not_learner") =>
  e === "is_admin" || e === "not_learner" ? "refused" : "unavailable";

// The Authentik side: bring username, `mail`, `firstName`, `lastName` to the
// login, leaving `email` and the other attributes alone. Nothing is written
// when the user already matches.
async function applyLogin(
  api: CoreApi,
  pk: number,
  name: string,
  username: string,
): Promise<
  Result<
    { readonly changed: boolean; readonly renamedFrom: RenamedFrom | null },
    NileLoginError | "patch_failed"
  >
> {
  const guarded = await guardUserWrite(api, pk, "learner");
  if (!guarded.ok) return err(refusalOf(guarded.error));
  const user = guarded.value;
  const attributes = user.attributes ?? {};
  const words = nameWords(name);
  const wanted = {
    mail: username,
    firstName: words.first,
    lastName: words.last ?? "",
  };
  const matches =
    user.username === username &&
    Object.entries(wanted).every(([k, v]) => attributes[k] === v);
  if (matches) return ok({ changed: false, renamedFrom: null });

  const patched = await call("users.nile_login", () =>
    api.coreUsersPartialUpdate({
      id: pk,
      patchedUserRequest: {
        username,
        attributes: { ...attributes, ...wanted },
      },
    }),
  );
  if (!patched.ok) return err("patch_failed");
  return ok({
    changed: user.username !== username,
    renamedFrom: { pk, username: user.username, attributes },
  });
}

// AC-4: put a user back after a failure that came after the rename. Best
// effort: a failure is logged and never masks the outcome the learner sees.
export async function restoreNileLogin(
  api: CoreApi,
  from: RenamedFrom | null,
): Promise<void> {
  if (from === null) return;
  const guarded = await guardUserWrite(api, from.pk, "learner");
  const restored = guarded.ok
    ? await call("users.nile_login_restore", () =>
        api.coreUsersPartialUpdate({
          id: from.pk,
          patchedUserRequest: {
            username: from.username,
            attributes: from.attributes,
          },
        }),
      )
    : guarded;
  if (!restored.ok)
    console.error(`nile login: could not rename ${from.pk} back`);
}

// AC-3 to AC-5, AC-10 to AC-12. Brings the learner's Authentik user to the
// login of `domain`, remembering it per learner and domain. Returns at once
// when this domain's row is already the learner's latest in use. The
// Authentik write is the last step that can fail; a caller whose commit then
// fails calls `restoreNileLogin` with `renamedFrom`.
export async function ensureNileLogin(
  api: CoreApi,
  trx: Kysely<DB>,
  input: NileLoginInput,
  draw: (below: number) => number = randomInt,
): Promise<Result<NileLoginSet, NileLoginError>> {
  const domain = input.domain.toLowerCase();
  const plain = nileLoginCandidates({ ...input, domain }, [])[0];
  const rows = await trx
    .selectFrom("learner_domain_logins")
    .select(["domain", "username", "used_at"])
    .where("user_id", "=", input.userId)
    .execute();
  const stored = rows.find((r) => r.domain === domain);
  if (stored && rows.every((r) => r.used_at <= stored.used_at))
    return ok({
      username: stored.username,
      numbered: stored.username !== plain,
      changed: false,
      renamedFrom: null,
    });

  // Refuse an admin or an untagged user before any write (AC-12).
  const guarded = await guardUserWrite(api, input.pk, "learner");
  if (!guarded.ok) return err(refusalOf(guarded.error));

  const settled = await withinBudget(
    settle(api, trx, input, domain, stored?.username, draw, 0),
  );
  return settled === timedOut ? err("unavailable") : settled;
}

async function settle(
  api: CoreApi,
  trx: Kysely<DB>,
  input: NileLoginInput,
  domain: string,
  storedUsername: string | undefined,
  draw: (below: number) => number,
  attempt: number,
): Promise<Result<NileLoginSet, NileLoginError>> {
  const plain = nileLoginCandidates({ ...input, domain }, [])[0];
  const claimed =
    storedUsername === undefined
      ? await claimLogin(api, trx, input, domain, draw, attempt)
      : ok(storedUsername);
  if (!claimed.ok) return claimed;
  const username = claimed.value;

  // A stored login another user holds now is not redrawn (AC-3).
  if (storedUsername !== undefined) {
    const holders = await holdersOf(api, input.pk, username);
    if (!holders.ok) return err("unavailable");
    if (holders.value.length > 0) return err({ taken: { domain, username } });
  }

  const applied = await applyLogin(api, input.pk, input.name, username);
  if (!applied.ok && applied.error === "patch_failed") {
    // Taken between the check and the write: give the row up and draw again.
    const holders = await holdersOf(api, input.pk, username);
    if (!holders.ok || holders.value.length === 0) return err("unavailable");
    if (storedUsername !== undefined)
      return err({ taken: { domain, username } });
    await trx
      .deleteFrom("learner_domain_logins")
      .where("user_id", "=", input.userId)
      .where("domain", "=", domain)
      .execute();
    return settle(api, trx, input, domain, undefined, draw, attempt + 1);
  }
  if (!applied.ok)
    return err(
      applied.error === "patch_failed" ? "unavailable" : applied.error,
    );

  const numbered = username !== plain;
  await trx
    .updateTable("learner_domain_logins")
    .set({ used_at: sql<Date>`now()` })
    .where("user_id", "=", input.userId)
    .where("domain", "=", domain)
    .execute();
  await audit(trx, {
    actorUserId: null,
    action: "user.nile_login_set",
    targetType: "user",
    targetId: input.userId,
    summary: "Nile login set",
    metadata: {
      domain,
      username,
      numbered,
      changed: applied.value.changed,
    },
  });
  return ok({
    username,
    numbered,
    changed: applied.value.changed,
    renamedFrom: applied.value.renamedFrom,
  });
}

// AC-3: the conflict row for an admin to resolve, written on the pool after
// the booking's transaction rolled back.
export async function auditNileLoginConflict(
  conn: Kysely<DB>,
  userId: string,
  taken: { readonly domain: string; readonly username: string },
): Promise<void> {
  await audit(conn, {
    actorUserId: null,
    action: "user.nile_login_conflict",
    targetType: "user",
    targetId: userId,
    summary: "Stored Nile login is held by another Authentik user",
    metadata: { domain: taken.domain, username: taken.username },
  });
}

// Every failure of `ensureNileLogin` reads to the learner as "try again
// shortly" (AC-5); a taken stored login also leaves its audit row.
export async function nileLoginRefusal(
  conn: Kysely<DB>,
  userId: string,
  error: NileLoginError,
): Promise<"unavailable"> {
  if (typeof error === "object")
    await auditNileLoginConflict(conn, userId, error.taken);
  return "unavailable";
}
