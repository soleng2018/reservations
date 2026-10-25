# Review, feat/spec-0019-nile-followup, 2026-10-25

**Reviewed by**: claude-opus-5-5 (author on a different session/model)
**Scope**: 8 files, branch vs main (merge base 8710da9)
**Verdict**: Changes requested

## Summary
A follow up to PR #33 (spec 0019, Nile identity per domain), with no production code changes. It adds DB backed tests: the Nile login read at send time in the booked, rescheduled, cancelled, and reminder emails; the reschedule refusals for a conflict and an untagged user; and a numbered login and an admin refusal in the guest saga. It also fixes an e2e lookup that broke once usernames stopped being the email, and records the `nile-idp` ownership split and the live tenant results in the spec, the scope, and `server/authentik/AGENTS.md`. The new tests run green against the local DB (12 passed with `-t Nile`), and most of them check real behavior against `nile-login.ts`, `manage.ts`, `send-email.ts`, and `lab-access.ts`. The main issue is that the spec now puts a real person's personal email address into a public repository. One "admin refusal" test is also credited to the wrong code path.

## Major
### 🟠 Personal email address committed to a public repo, `docs/specs/0019-nile-identity-per-domain.md:222`
**Problem**: The follow-up entry names a real account and its private address (a named Nile account and its private address, now removed). `soleng2018/reservations` is PUBLIC (`gh repo view`). The address came in with commit 76f5a27, which is already pushed to `origin/feat/spec-0019-nile-followup`.
**Why it matters**: This is personal data of an identifiable person in a public, indexed repository. It also documents which staff account authenticates with which external address, which helps targeted phishing or account recovery attacks against the Authentik that gates the labs.
**Suggested fix**: Replace both addresses with placeholders (for example "an admin user whose email differs from its username"). Squash merge so `main` never carries 76f5a27's text, and consider force pushing a rewritten branch, or deleting it after the merge, since the remote branch already exposes it. While editing, consider whether the Authentik and provider pks and the "isolation block bypassed" detail need to be in a public spec at all.

## Minor
### 🟡 "Admin refusal in the guest saga" test never reaches the Nile login guard, `server/booking/guest-booking.test.ts:155`
**Problem**: The test sits in the "bookAsGuest Nile login (spec 0019)" block, and the scope marks it as the AC-12 admin refusal. But with an Authentik admin who holds the booking email, `bookAsGuest` refuses earlier, in `findOrCreateLearner` → `reuseLearner` → `guardUserWrite(api, pk, "tag")` → `is_admin` (`server/authentik/learners.ts:133-135`). `ensureNileLogin` is never called. The test also asserts only `r.ok === false`, not the error.
**Why it matters**: Spec 0003 behavior that `learners.test.ts:94` already covers gets counted as spec 0019 coverage. If the guard in `ensureNileLogin` were removed, this test would still pass. (The direct unit test in `server/authentik/nile-login.test.ts:230` does cover that guard.)
**Suggested fix**: Assert the exact error (`admin_email` or whatever the saga maps `is_admin` to), and relabel the test as a regression guard that the saga refuses before any rename. Or drop it and correct the scope note at `docs/scope/scope.md:352`, which says "admin refusal in the guest saga".

### 🟡 `server/authentik/AGENTS.md` gains a Nile line but keeps rules it now contradicts, `server/authentik/AGENTS.md:9`
**Problem**: The diff adds the spec 0019 rule, but the same file still says `updateLearnerIdentity` makes "the new email also become the username". AC-8 changed that: a learner with a stored login keeps their username. Line 18 ("New learners: username = lowercased email") is true only until the first booking on a domain testbed. The spec's own follow-up (`docs/specs/0019...` "After the build, `/sync` should add ... the login read rule to the root `AGENTS.md`, and note in spec 0003") is still open, and the root AGENTS.md has no `learner_domain_logins` or `nileLoginForEmail` read rule.
**Why it matters**: Agents read this file as canonical. A stale rule invites someone to "fix" `updateLearnerIdentity` back to renaming, or to look up learners by `username = email`, which is the exact bug the e2e change here just fixed.
**Suggested fix**: In this file, update the `learners.ts` and New learners lines to reflect AC-8 and the rename on booking. Then run `/sync`, or tick the follow-up when it is done.

### 🟡 Spec ownership section states things the follow-up notes do not support, `docs/specs/0019-nile-identity-per-domain.md:215`
**Problem**: The "Contract" paragraph says as fact that "The NameID falls back to the username, never `user.email`". The follow-up 7 lines below says that fallback is in `nile-idp` PR #1 and "takes effect when the owner runs `apply`", which has not been confirmed. Line 209 implies SCIM is what provisions learners into Nile, but the tenant notes conclude that learners get in through SAML once the Nile group mapping is active. Tenant 5 worked after activation, and the earlier "no SCIM is the cause for tenant 5" was superseded.
**Why it matters**: The ownership table is now the reference for onboarding a new tenant. A reader will take the fallback as live, and may think a SCIM provider is required for learner access.
**Suggested fix**: Phrase the fallback as pending until the owner runs `apply` after merging PR #1, and tick it once verified. Add to the SCIM row that learner access depends on the active Nile group mapping, not on SCIM.

## Nits
- ⚪ `server/booking/manage.test.ts:207`: `fakeUser(...) as never` is unnecessary (`ak.users` elements are structurally `FakeUser`) and turns off type checking for the push; drop the cast.
- ⚪ `server/booking/manage.test.ts:222-231`: the conflict audit query filters by `created_at >= now()` but not by `target_id = w.user.id`; scoping by target would show that the row names this learner (the random domain keeps it from being flaky today).
- ⚪ `server/jobs/jobs.test.ts:311`: `[booked, rescheduled]` relies on send order, and neither the subject nor the kind is checked; asserting each request's `Subject:` (or `toHaveLength(2)`) would make it clear both kinds were sent.
- ⚪ `server/booking/guest-booking.test.ts:114`: the numbered login test could also assert the `user.nile_login_set` audit row has `numbered: true` (AC-11).
- ⚪ `docs/specs/0019-nile-identity-per-domain.md:197`: "Owner confirms the open Authentik check" is stale now that every Authentik follow-up is ticked.
- ⚪ `server/booking/guest-booking.test.ts:113`: a blank line is missing before the new `it` (Prettier keeps it as is, but the rest of the block is spaced).

## Strengths
- The conflict reschedule test sets up the "not the latest domain" state precisely (an older row for the target domain plus a newer one elsewhere), so it drives `settle` into the stored login path and checks the AC-3 contract. The refusal is `unavailable`, the booking is unchanged, no email is queued, the learner's own Authentik name is kept, and the conflict audit row survives the rollback.
- The email tests check the secret handling rule end to end. The login appears in the rendered MIME, not in `email_messages.details`, `jobs.payload`, or `last_error`, and not in the cancelled email. This mirrors the `clientLoginsForBooking` rule and covers the "no stored login for this domain" omission.
- The e2e fix (`?username=` → `?email=`) is correct and minimal: after spec 0019 the username is the domain login, so the old lookup would miss the renamed learner.

## Test coverage
The new tests cover the AC-6 send time read for booked, rescheduled, reminder, and cancelled emails, plus the missing login case. They also cover the AC-3 reschedule conflict, the AC-12 untagged refusal on reschedule (`guardUserWrite` before any write, `writes` empty), and the AC-2 numbered login on the guest path. All pass against the local DB (`vitest -t Nile`: 12 passed). Gaps: the guest saga admin test exercises spec 0003's guard rather than spec 0019's (see Minor). There is no saga level test for an untagged existing Authentik user (the tag step would tag them, so the Nile guard is reachable only on reschedule, which is covered). AC-6's screen surfaces (success screen, lab card) are not part of this diff.
