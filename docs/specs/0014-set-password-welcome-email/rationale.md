# 0014. Set password and welcome email: rationale

## Context

Feature 16 sends the email a new learner needs to set a password, which also verifies their email (first sign in sets `email_verified_at`, spec 0003 AC-7). Jobs already queue from five places (guest saga, admin add, admin resend, public resend, admin email change), but no handler runs them.

These forces shaped the choice:

- **Specs disagree on uniqueness.** Spec 0002 planned one welcome email per user (a unique index). Spec 0008 added resend and email change jobs, which need more than one. Spec 0008 also asked that an unsent original plus an email change job never send twice.
- **Authentik's recovery link API returns the same token while one is valid** (one token per user, keyed by the user's uid). A resend or an email change would mail the identical link. So a typo address that got the first email keeps a working link after the admin fixes it. The only Authentik side revoke is deleting the token, which needs token view and delete rights. Authentik RBAC can't narrow those to learners, so a leaked provisioning token could delete any token, admin API tokens included. Spec 0008 recorded this as a known gap that needs owner approval.
- **An API recovery token is used up when its flow opens.** That gives "works once" nearly for free, but a mail scanner that runs scripts can use it up before the learner does.
- **`hol-recovery` ends at done**: prompt plus user write, no login stage, so the learner is not signed in to the app. Authentik follows `next` only to a relative path. Dev and prod share one Authentik, one brand recovery flow, and one worker, so a fixed redirect can name only one app URL.
- **The scope requires** "each new user gets exactly one such email; the link expires, works once, and lands them signed in". There is no mock for this email, so the subject and copy are the owner's call.

## Options considered

### Option 1: app link handed off on click, login stage plus `next` (chosen)

The email links to `APP_URL/set-password/<token>`, and the app stores only a hash with expiry and end state. A POST asks Authentik for a 10 minute recovery link, starts the app's own OIDC sign in, and redirects to the recovery link with `next` set to the authorize path. A user login stage in `hol-recovery` then hands the learner back signed in.

**Pros**: works once, expiry, and revoke are app rules on the DB clock; no new Authentik rights; scanner safe (GET changes nothing); lands signed in on whichever app URL was clicked; the worker needs no Authentik.
**Cons**: a table plus a public route and action; Authentik must be up at click time; relies on Authentik honoring `next` on a token flow (checked first, with a fallback); the token sits in access log paths.

### Option 2: Authentik link in the email (spec 0003's plan)

The worker asks Authentik for a 72 hour link at send and mails it.

**Pros**: no new table or route; the least code.
**Cons**: every resend and email change mails the same token, so revoke needs token delete rights (owner approval, broad RBAC); a script running scanner can use it up; the app is not in the path, so landing signed in needs a fixed Redirect stage that serves only one app URL; the worker depends on Authentik at send.

### Option 3: Option 2 plus Authentik token delete on email change

The same as Option 2, plus `view_token` and `delete_token` for the provisioning role. The guard deletes only `<uid>-password-reset` of a guarded learner.

**Pros**: closes the typo gap without an app table.
**Cons**: the RBAC grant covers every token in Authentik; it keeps Option 2's scanner and landing problems; it needs owner approval for a shared change.

### Sub decisions

- **Landing**: `next` back to the app's own authorize request (chosen; correct host, real state cookie). The runner up is a fixed Redirect stage to `<first APP_URLS>/auth/start` (no Authentik check needed, but dev lands on prod); it is kept as the fallback. A done page plus a manual sign in misses the scope's criterion.
- **One send**: a skip at send when an email to the same address was already sent after this job was queued (chosen; robust to the address changing while queued). The runner up is a dedupe at queue time (racy without a new jobs index, and the address still has to be read at send). The spec 0002 unique index would break resend.
- **Several links**: any live link works and the first click ends the rest (chosen; they all went to one address). The runner up, newest only, surprises a learner who opens the first email after a resend.
- **Revoke on email change**: app side only (chosen). Deleting the Authentik token too would close only the 10 minute window after a click, at the cost of a broad RBAC grant.
- **Lifetime**: 72 hours (chosen; what spec 0003 and the resend copy assume). Runners up: 7 days (longer exposure), 24 hours (more resends).
- **Ops BCC**: never on welcome (chosen; a copy is a working sign in for another person's account).
- **Backlog**: skip jobs over 72 hours old (chosen; no surprise emails for weeks old accounts, and resend still works).
- **Rows written at send, not at queue**: queuing has five callers and no address is fixed until send. Writing at send keeps one writer and needs no "queued welcome" state.
- **Token in the path, not the fragment**: the page can render its state on the server. The runner up, a fragment, keeps the token out of logs but needs client JS before any state shows. A single use, 72 hour token makes log exposure minor.
- **One end column with a reason, not `used_at` plus `revoked_at`**: one "is it live" test, and it records why the link died.
- **Slow learner (AC-19, amended 2026-10-17)**: a `timed_out` view on `/auth/error` with a Sign in button, plus `onAPIError.errorURL` (chosen; one click, and the copy says what happened). The first draft assumed the page already had a sign in button, but it had none. Runner up: a Sign in button on the existing `unavailable` view (less code, but "temporarily unavailable" is wrong here). Rejected: amending AC-19 to the page as built (three steps through the home page, under a misleading message). The cross check found that Better Auth's database state strategy gives a 5 minute cookie and, once the row is cleared after 10 minutes, falls back to its own error page; `onAPIError.errorURL` closes that second path. Better Auth fixes both lifetimes, so the app can't lengthen the window.

## Rationale

The scope's three link properties (works once, expires, lands signed in) and spec 0008's revoke gap all hinge on one fact: Authentik reuses one token per user. Any design that mails Authentik's token inherits that reuse, so it either accepts the typo email takeover or buys broad token rights in a shared Authentik that the owner guards closely. Putting the app's own single use link in the email moves every one of those rules into the app's DB, on the DB clock the project already uses for every access decision. It leaves the provisioning role unchanged.

Being in the click path also solves the landing. The app can start its own OIDC request on the exact host the learner clicked and hand Authentik a relative `next`. That is the one thing a shared flow with a static redirect can't do for two app URLs. The cost is a dependency on Authentik at click time, which the learner sees as a "try again" message rather than a broken email. Because the Authentik link now lives 10 minutes instead of 72 hours, Authentik's same token behavior is no longer a risk.

Collapsing at send rather than at queue fits the existing runner: one worker, one job at a time, rows written by the handler. "Already covered" becomes a single read with no new lock or index, and it follows the address as it is when the email goes out, which is what spec 0008's "must not send twice" case needs.
