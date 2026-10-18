# server/authentik

The app's side of the shared Authentik: the API client, the write guard, and learner provisioning. Governing spec: [0003](../../docs/specs/0003-authentik-sign-in-provisioning/index.md).

## Files

- `client.ts`: `authentik()` builds the pinned `@goauthentik/api` `CoreApi` on the provisioning token (`AUTHENTIK_PROVISIONING_TOKEN_FILE`), with a 10 second timeout. Wrap every SDK call in `call(label, fn)`, which returns a `Result` (`unavailable` | `not_found`).
- `guard.ts`: the only gate for Authentik writes. It re-reads the target before each write; `guardGroupWrite` returns the fresh group so a delete can check its `hol_testbed_id`.
- `learners.ts`: `findOrCreateLearner` (guest saga), `issueSetPasswordLink`, `updateLearnerIdentity` (an admin's name or email fix; the new email also becomes the username), `deactivateLearner`, `reactivateLearner`, `deleteSagaLearner`.
- `groups.ts`: testbed `pod-` groups: create (stamped with `hol_testbed_id`), find by name, delete, and membership. Only the worker's access reconciler (`server/worker/reconcile.ts`) adds or removes members.
- `sessions.ts`: ends every Authentik session of a user (used by sign out and deactivate).
- `testing.ts`: test support only, an in memory fake Authentik behind the real SDK that records every write. Users it creates get pks from `FAKE_NEW_PK` (900100), clear of the real learners in the shared database; never pin a low pk a real learner may hold.

## Rules

- Every user or group write goes through `guardUserWrite` / `guardGroupWrite` first. The guard refuses users in `hol-admins`, users without `attributes.hol_learner = true` (except the saga's tag step), and any group not named `pod-*`. Never add a code path that creates an admin, changes one, or adds anyone to `hol-admins`.
- Runtime code (web and worker) never reads the master token. Only `scripts/authentik-setup.ts` uses it, passed for that one run.
- New learners: username = lowercased email, path `hol/learners`, type `external`, no password, attributes `hol_learner` and `hol_user_id`. Reuse only adds missing attributes and never changes `type` or `path`.
- A recovery link is asked for only when a learner clicks the app's own set password link, with `tokenDuration: "minutes=10"` (`RECOVERY_DURATION` in `server/auth/start-set-password.ts`); never store it. Authentik keeps one token per user, so a second request returns the same link with the later expiry, and the token is used up when its flow opens ([spec 0014](../../docs/specs/0014-set-password-welcome-email/index.md) AC-10, AC-12).
- The click adds `next=<the app's authorize path and query>` to the recovery link. Authentik keeps `next` on a token flow, and the `hol-recovery-login` stage (order 30 in `hol-recovery`, made by `npm run authentik:setup`) signs the learner in, so they land on the app signed in. This is the main path; the `hol-recovery-return` fallback was not built. Both origins must be the same public Authentik host.
- Reading and deleting sessions writes no user, so the guard does not apply there.
- `deactivateLearner` and `reactivateLearner` run in one transaction under the learner row lock (`FOR UPDATE`), calling Authentik while holding it, and raise `Refusal` so every write rolls back ([spec 0008](../../docs/specs/0008-admin-users/index.md)). Deactivate also cancels every confirmed booking that has not ended, and refuses while a booking is still `provisioning`.
- Tests use the fake from `testing.ts` and assert on `writes` (a refusal must record no write). DB backed functions run inside `inRollback` with `asConn(trx)`.

## Agent skills

Declined: Authentik community Agent Skills (`gabri-sanchez/authentik-skill`, `danieldekay/ai-ops`) and Authentik MCP servers (`@cdmx/authentik-mcp`, `@cdmx/authentik-diag-mcp`), 2026-10-08.

_Drafted by /sync from the introducing change, worth a quick human pass._
