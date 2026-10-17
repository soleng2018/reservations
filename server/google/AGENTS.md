# server/google

## Overview

Every call the app makes to Google: minting an access token for the sender mailbox, Gmail send, Calendar events, the save time check of a `GOOGLE` API key, and the admin's Google sign in. The worker uses it through `server/jobs/`; the web process uses only the save check and the sign in.

## Key files

| File | Owns |
|---|---|
| `http.ts` | `googleRequest` (10 second timeout, injected `fetch`), `classifyStatus` into `rejected` (401), `retry`, or `final` |
| `token.ts` | `GOOGLE_SCOPES` (`gmail.send`, `calendar.events`), `mintAccessToken` by method, `googleAccessToken` (a cached token, `fresh` forces a new one) |
| `gmail.ts` | `sendRaw`: one raw MIME message as the token's mailbox |
| `calendar.ts` | insert, put, and delete on the shared "HOL bookings" calendar |
| `verify.ts` | `verifyGoogleKey`: mint a token, then read one calendar event; run on save from `server/catalog/api-keys.ts` |
| `oauth.ts` | Google sign in: PKCE, the code exchange, the refresh token mint |
| `sign-in-cookie.ts` | the sign in in progress, an encrypted cookie for at most 10 minutes |
| `testing.ts` | fake key files, a fake `id_token`, and a scripted fake `fetch` that records requests (tests only) |

## Conventions

- Two sign in methods, from the key's `google_auth` column: `service_account` (domain wide delegation, the production path) and `oauth` (Google sign in, for a personal Gmail sender while testing). Switch on `GoogleAuthMethod` exhaustively.
- `fetch` is always injected, so tests use the fake in `testing.ts`; never call the real Google in a test.
- Nothing here logs, and no error carries a key, token, code, verifier, client secret, or a Google reply body (it can echo request data). `oauth.ts` reads Google's error body only for its `error` code.
- A timeout or network error is a retry, never final. A 401 is `rejected`: the caller (`googleCaller` in `server/jobs/runner.ts`) retries once with a fresh token, then trips the breaker.
- Calendar events have no attendees and use `sendUpdates=none`, so Google never mails a learner; the invite travels inside our own email.
- The web process never decrypts a stored `GOOGLE` key. The save check runs on the typed values, outside any transaction, and is not audited; only the worker decrypts the key, through `googleMailConfig` in `server/catalog/api-keys.ts`.
- The sign in cookie is the one thing the web process decrypts here. Its AAD carries the admin's user id, so another admin's session can't use it; it is `Secure` only over https, so dev over plain http works.

## Gotchas

- `google-auth-library` retries the token POST itself, so a mint is raced against the timeout as a whole, not just per request.
- A Google sign in token stops working on a password change, revoked access, about 6 months unused, more than 100 sign ins for the client, or after 7 days while the consent screen is in Testing. The breaker message in `server/jobs/runner.ts` lists these for the admin.
- `verifyGoogleKey` proves read access to the calendar, not write permission.

## Agent skills

- [gws-gmail](../../.claude/skills/gws-gmail/): `googleworkspace/cli`, Gmail send and read
- [gws-calendar](../../.claude/skills/gws-calendar/): `googleworkspace/cli`, Google Calendar events

## Related specs

- [0013 Email delivery and booking confirmations](../../docs/specs/0013-email-delivery-booking-confirmations/index.md) (AC-2, AC-9, AC-15, AC-19, AC-25 to AC-34)
- [0006 Admin API keys](../../docs/specs/0006-admin-api-keys/index.md) (the `GOOGLE` key type)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
