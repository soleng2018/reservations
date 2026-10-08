import "server-only";
import { err, ok, type Result } from "@/lib/result";
import { call, type CoreApi, type User } from "./client";

// Ends every Authentik authenticated session of a user, on every device.
// Used by sign out (AC-12) and deactivation (AC-9). It writes no user, so
// the guard does not apply. The list filters by username, so the user pk
// is checked again on each row.
export async function endSessionsOf(
  api: CoreApi,
  user: Pick<User, "pk" | "username">,
): Promise<Result<number, "unavailable">> {
  const sessions = await call("sessions.list", () =>
    api.coreAuthenticatedSessionsList({
      userUsername: user.username,
      pageSize: 100,
    }),
  );
  if (!sessions.ok) return err("unavailable");
  const mine = sessions.value.results.filter(
    (s) => s.user === user.pk && s.uuid,
  );
  const ends = await Promise.all(
    mine.map((s) =>
      call("sessions.destroy", () =>
        api.coreAuthenticatedSessionsDestroy({ uuid: s.uuid ?? "" }),
      ),
    ),
  );
  // A session already gone (404) counts as ended.
  return ends.some((r) => !r.ok && r.error === "unavailable")
    ? err("unavailable")
    : ok(mine.length);
}

// The same, starting from the Authentik user pk (spec 0003 API surface).
// A user Authentik no longer has has no sessions to end.
export async function endAuthentikSessions(
  api: CoreApi,
  pk: number,
): Promise<Result<number, "unavailable">> {
  const user = await call("users.retrieve", () =>
    api.coreUsersRetrieve({ id: pk }),
  );
  if (!user.ok) return user.error === "not_found" ? ok(0) : err("unavailable");
  return endSessionsOf(api, user.value);
}
