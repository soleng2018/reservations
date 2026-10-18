# server/users

Learner admin from the console: the users list, the user detail page, and every learner change an admin makes, plus the admin's own timezone. Governing spec: [0008](../../docs/specs/0008-admin-users/index.md). The Server Actions that call it are in `app/admin/users/actions.ts`.

## Files

- `learners.ts`: reads (`listLearnersForAdmin`, `getLearnerDetail`, `deactivationPreview`, `isConsoleLearner`) and changes (`createLearner`, `updateLearner`, `resendSetPasswordByAdmin`, `cancelBookingByAdmin`). Deactivate and reactivate live in `server/authentik/learners.ts`.
- `admin-timezone.ts`: `setAdminTimezone`, which learns an admin's zone once from their browser while their row still holds the default `UTC`, and audits only when the row changed.

## Rules

- Only learners with an Authentik pk are shown or changed. A row with a null pk is still being added or booked, so the console treats it as not found.
- The add saga: insert the row with no pk and commit, find or create the Authentik user stamped with that row id, then store the pk, set `set_password_pending` and queue the welcome job (when the account has no password yet), and audit, all in one transaction. Every cleanup delete checks "no pk, no bookings" again inside the statement, so a row a guest booking picked up meanwhile is kept. The worker's `sweepUnlinkedLearners` cleans up after a crashed saga.
- The lock first pattern for changes: one transaction locks the learner row (`FOR UPDATE`), checks every precondition against it, calls Authentik while holding the lock, then writes the app side. An expected failure throws `Refusal` (`server/db/refusal.ts`) inside `refusable()`, so everything rolls back.
- The email can change only while `set_password_pending` is true (the learner has never set a password). A save that changes nothing writes nothing, and a company or timezone only edit makes no Authentik call.
- An email change ends every live set password link of the learner (`endLiveLinks`, reason `email_changed`) under the user lock, then queues the welcome with `emailChangeKey` and the change's DB time, so a link mailed to the old address stops working ([spec 0014](../../docs/specs/0014-set-password-welcome-email/index.md) AC-14).
- An admin cancel goes through `cancelBooking` at the version the admin saw.
- Tests: `learners.test.ts` runs inside `inRollback` with the fake Authentik from `server/authentik/testing.ts`.

_Drafted by /sync from the introducing change, worth a quick human pass._
