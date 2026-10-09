# server/authentik

The app's side of the shared Authentik: the API client, the write guard, and learner provisioning. Governing spec: [0003](../../docs/specs/0003-authentik-sign-in-provisioning/index.md).

## Files

- `client.ts`: `authentik()` builds the pinned `@goauthentik/api` `CoreApi` on the provisioning token (`AUTHENTIK_PROVISIONING_TOKEN_FILE`), with a 10 second timeout. Wrap every SDK call in `call(label, fn)`, which returns a `Result` (`unavailable` | `not_found`).
- `guard.ts`: the only gate for Authentik writes. It re-reads the target before each write.
- `learners.ts`: `findOrCreateLearner` (guest saga), `issueSetPasswordLink`, `deactivateLearner`, `reactivateLearner`, `deleteSagaLearner`.
- `groups.ts`: testbed `pod-` group membership.
- `sessions.ts`: ends every Authentik session of a user (used by sign out and deactivate).
- `testing.ts`: test support only, an in memory fake Authentik behind the real SDK that records every write.

## Rules

- Every user or group write goes through `guardUserWrite` / `guardGroupWrite` first. The guard refuses users in `hol-admins`, users without `attributes.hol_learner = true` (except the saga's tag step), and any group not named `pod-*`. Never add a code path that creates an admin, changes one, or adds anyone to `hol-admins`.
- Runtime code (web and worker) never reads the master token. Only `scripts/authentik-setup.ts` uses it, passed for that one run.
- New learners: username = lowercased email, path `hol/learners`, type `external`, no password, attributes `hol_learner` and `hol_user_id`. Reuse only adds missing attributes and never changes `type` or `path`.
- Recovery links are asked for with `tokenDuration: "hours=72"` on every request. Authentik returns the same link while a token is still valid; never store the link.
- Reading and deleting sessions writes no user, so the guard does not apply there.
- Tests use the fake from `testing.ts` and assert on `writes` (a refusal must record no write). DB backed functions run inside `inRollback` with `asConn(trx)`.

## Agent skills

Declined: Authentik community Agent Skills (`gabri-sanchez/authentik-skill`, `danieldekay/ai-ops`) and Authentik MCP servers (`@cdmx/authentik-mcp`, `@cdmx/authentik-diag-mcp`), 2026-10-08.

_Drafted by /sync from the introducing change, worth a quick human pass._
