import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { SetPasswordLinkEndReason, UserRole, UserStatus } from "@/lib/db-enums";
import { linkView, type LinkView } from "@/lib/set-password-link";
import { SetPasswordToken } from "@/lib/welcome-email";
import type { DB } from "@/server/db/types";

// Spec 0014: the app's own set password links. The raw token lives only in
// the worker's memory while it sends, and in the learner's inbox and
// browser; at rest it is a sha256 hash (AC-4).

// AC-4: 32 random bytes, base64url (43 characters).
export function newToken(): { readonly token: string; readonly hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

export type LiveLink = {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly authentikUserPk: number;
};

export type LinkState =
  | { readonly view: "live"; readonly link: LiveLink }
  | { readonly view: Exclude<LinkView, "live"> };

const DEAD: LinkState = { view: "dead" };

// AC-9, AC-10: the one predicate the page and the action share. Reads only.
// With `lock` (the action's transaction), it takes the locks in the lock
// order of spec 0014: the user FOR SHARE first, then the link FOR UPDATE.
export async function linkState(
  conn: Kysely<DB>,
  token: string,
  { lock = false }: { readonly lock?: boolean } = {},
): Promise<LinkState> {
  if (!SetPasswordToken.safeParse(token).success) return DEAD;
  const hash = hashToken(token);
  const owner = await conn
    .selectFrom("set_password_links")
    .select("user_id")
    .where("token_hash", "=", hash)
    .executeTakeFirst();
  if (!owner) return DEAD;

  const userQuery = conn
    .selectFrom("users")
    .select([
      "role",
      "status",
      "authentik_user_pk",
      "set_password_pending",
      "email",
    ])
    .where("id", "=", owner.user_id);
  const user = await (
    lock ? userQuery.forShare() : userQuery
  ).executeTakeFirst();
  const linkQuery = conn
    .selectFrom("set_password_links")
    .select([
      "id",
      "user_id",
      "email",
      "ended_reason",
      sql<boolean>`expires_at > now()`.as("unexpired"),
    ])
    .where("token_hash", "=", hash);
  const link = await (
    lock ? linkQuery.forUpdate() : linkQuery
  ).executeTakeFirst();
  if (!user || !link) return DEAD;

  const view = linkView(
    {
      endedReason:
        link.ended_reason === null
          ? null
          : SetPasswordLinkEndReason.parse(link.ended_reason),
      unexpired: link.unexpired,
      email: link.email,
    },
    {
      role: UserRole.parse(user.role),
      status: UserStatus.parse(user.status),
      authentikUserPk: user.authentik_user_pk,
      setPasswordPending: user.set_password_pending,
      email: user.email,
    },
  );
  if (view !== "live") return { view };
  // linkView answers live only with a pk.
  if (user.authentik_user_pk === null) return DEAD;
  return {
    view,
    link: {
      id: link.id,
      userId: link.user_id,
      email: link.email,
      authentikUserPk: user.authentik_user_pk,
    },
  };
}

// AC-10, AC-13, AC-14: ends every live link of the user (an email change, or
// a sibling of the clicked link), except `exceptId`. Set once: an ended link
// is never touched again. Answers how many it ended.
export async function endLiveLinks(
  trx: Kysely<DB>,
  userId: string,
  reason: SetPasswordLinkEndReason,
  exceptId?: string,
): Promise<number> {
  const ended = await trx
    .updateTable("set_password_links")
    .set({ ended_at: sql<Date>`now()`, ended_reason: reason })
    .where("user_id", "=", userId)
    .where("ended_at", "is", null)
    .where((eb) =>
      exceptId === undefined ? eb.lit(true) : eb("id", "<>", exceptId),
    )
    .executeTakeFirst();
  return Number(ended.numUpdatedRows);
}

// AC-10 step 7: the clicked link is used, its live siblings other_used.
export async function endClickedLink(
  trx: Kysely<DB>,
  link: LiveLink,
): Promise<void> {
  await endLiveLinks(trx, link.userId, "other_used", link.id);
  await trx
    .updateTable("set_password_links")
    .set({ ended_at: sql<Date>`now()`, ended_reason: "used" })
    .where("id", "=", link.id)
    .where("ended_at", "is", null)
    .execute();
}

// AC-16: the worker's purge, 30 days past expiry.
export async function purgeSetPasswordLinks(conn: Kysely<DB>): Promise<number> {
  const gone = await conn
    .deleteFrom("set_password_links")
    .where("expires_at", "<", sql<Date>`now() - interval '30 days'`)
    .executeTakeFirst();
  return Number(gone.numDeletedRows);
}
