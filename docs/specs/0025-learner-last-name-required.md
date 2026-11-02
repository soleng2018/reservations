# 0025. Learner last name required

**Date**: 2026-11-01
**Status**: Accepted

## Summary

A learner's name must have a first and a last name. The booking form and the admin Add and Edit learner form both refuse a name with one word, and the backend refuses to build a Nile login from a name that has no last name. This is needed because the Nile Portal rejects a sign in when the Authentik `lastName` is empty (the error page says "400 Login Failed, GENERAL_NONSUCCESS"). An admin name edit now also updates the first and last name that Nile reads, so a fix reaches Nile at once. This amends spec 0019 AC-1, which allowed a one word name.

## Context

On 2026-11-01 a learner booked Workshop 2 with a one word name. Spec 0019 AC-1 allowed that: the login became `first@nileworkshop-2.com` and Authentik `attributes.lastName` was written as an empty string. The Nile Portal then refused their sign in with "400 Login Failed, GENERAL_NONSUCCESS". Setting a placeholder last name on their Authentik user by hand fixed it, and the owner confirmed the empty last name was the cause.

Two things make this likely to repeat. The booking form and the admin form both have one "Full name" field that only checks the name is not empty. And `ensureNileLogin` (spec 0019) writes `lastName` from the stored name on every booking and reschedule, so a manual fix is undone the next time a learner with a one word name reschedules.

There is a second gap. An admin name edit (`updateLearnerIdentity`) changes only Authentik's `name` field. The `firstName` and `lastName` attributes that Nile reads are written only by `ensureNileLogin`, at a booking or reschedule. So correcting a name in the admin form does nothing for Nile until the learner books again.

Only one existing learner has a one word name (with one live booking). The other learner and the admin have two words. No backfill job is needed.

## Requirements

**User stories**:
- As a learner, I want the booking form to tell me up front that my first and last name are needed, so that my Nile login works when I arrive.
- As an admin, I want the Add and Edit learner form to refuse a one word name, and to fix a bad name in one save, so that I never create a learner who cannot sign in to Nile.
- As the owner, I want the backend to refuse a booking whose name has no last name, so that a path that skips the form cannot recreate this failure.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: One pure function, `hasFullName(name)` in `lib/nile-login.ts` beside `nameWords`, decides the rule. A name is valid when, split on whitespace after trimming, it has at least two words and both the first and the last word contain at least one letter or digit (Unicode `\p{L}` or `\p{N}`). "Ana" is invalid, "Ana ." is invalid, "Ana de Souza" is valid (last word "Souza"), and a name in another script such as "李 明" is valid. A Zod schema built on that function (`fullName(message)` in `lib/full-name.ts`) is the only way a form or action checks a name, so the rule exists once.
- **AC-2**: The public booking form (Step 1) uses the rule. The field keeps the label "Full name" and gains the hint "First and last name". A name that is empty, one word, or fails AC-1 shows the field error "Enter your first and last name." and blocks Continue, because `checkDetailsAction` runs before the learner picks a time (spec 0010 AC-2). The final booking action parses the same schema, so a post that skips Step 1 is refused with the same field error.
- **AC-3**: The admin Add and Edit learner form uses the same rule with the error "Enter the first and last name." (`LearnerInput.name`). Saving an edit for a learner whose stored name has one word needs a full name in that same save, even when the admin is changing only the company.
- **AC-4**: `ensureNileLogin` refuses with the new error `name_incomplete` when the stored `users.name` fails `hasFullName`. The check runs before any Authentik write. Nothing is saved: the guest saga and the reschedule roll back exactly as in spec 0019 AC-5. The name used is the stored name, never a posted one (spec 0019 AC-1).
- **AC-5**: A learner refused with `name_incomplete` sees "Your account needs a first and last name. Please contact the lab admin." On /book this is a new `BOOK_ERRORS.name_incomplete` outcome. On the reschedule form it is the same text. It is never shown as "try again shortly", because retrying cannot help.
- **AC-6**: An admin name edit also writes `attributes.firstName` and `attributes.lastName` on the learner's Authentik user, from `nameWords` of the new name, in the same call that sets `name`. Existing attributes (`hol_learner`, `hol_user_id`, `mail`) are kept by merging. The write goes through `guardUserWrite(api, pk, "learner")` as every learner write does. A failure is refused and rolled back exactly as an Authentik failure is today.
- **AC-7**: No existing data changes. There is no migration, no database CHECK, and no backfill job. the affected learner's stored name stays one word until an admin edits it. The placeholder last name "Learner" on their Authentik user stays until that edit overwrites it (AC-6).
- **AC-8**: Nothing else changes: the login format in spec 0019 (`first.last@domain`, with `first@domain` kept only as the pure function's fallback for a last word that cleans to nothing), stored logins per domain, the booked, rescheduled and reminder emails, and the audit actions.

## Options considered

### Option 1: Keep one Full name field and require two words

The field stays as it is. A shared rule checks for a first and a last word. `ensureNileLogin` refuses an incomplete name as a backstop, and an admin name edit syncs the Nile attributes.

**Pros**:
- No schema change and no migration.
- Matches how `nameWords` already splits the stored name into a first and last word.
- One rule, checked in the forms and again in the backend.

**Cons**:
- A person with one name must still type two words. The error asks for a first and last name, and the owner can decide a placeholder case by case.
- "Ana de Souza" style names have the last word "Souza" sent as the last name, not "de Souza".

### Option 2: Split into First name and Last name fields

Two inputs in both forms, and a migration that splits `users.name` into two columns (or a derived pair).

**Pros**:
- The clearest form for a learner, and no guessing which word is the last name.

**Cons**:
- Needs a migration and a backfill, and changes both forms, the emails, the audit text, the admin list and every place that reads `users.name`. That is far larger than the problem.

### Option 3: Add a database CHECK on `users.name`

Reject a one word name in Postgres.

**Pros**:
- The strongest guarantee, and no path can skip it.

**Cons**:
- the affected learner's existing row would violate it, so it could not be added without fixing that row first, and a one off data fix inside a migration is fragile.
- Constraint names are a contract with `mapConstraintError`, so a new one adds a mapping and a test for little gain over the backend refusal in AC-4.

## Decision

**Chosen option**: Option 1: keep one Full name field and require two words.

One shared rule checks the name in both forms and again in `ensureNileLogin`, and an admin name edit keeps Authentik's `firstName` and `lastName` in step.

**Implementation skills**: `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`)

## Rationale

The failure is narrow: Nile needs a non empty `lastName`, and the app already derives that from the last word of one stored name. The smallest change that closes it is to make the stored name carry two words, which needs no migration and no new columns. Splitting the field (Option 2) fixes a problem that does not exist, since the stored name already splits cleanly.

The backstop in AC-4 matters because the forms are not the only door. A row made before this rule, a future import, or a path that forgets the schema would otherwise write an empty `lastName` again and the learner would find out at the Nile login screen, minutes before a lab. Refusing in `ensureNileLogin` turns that into a clear message at booking time. A database CHECK (Option 3) was rejected because the affected learner's row would block it and the backend refusal covers the same risk.

The admin sync in AC-6 closes the gap found while investigating: without it, correcting a name in the Users page would look like a fix but change nothing for Nile until the next booking.

## Feature design

**Data model sketch**: no change. `users.name` stays one text column. `lastName` is derived: the last whitespace separated word of `users.name`.

**State transitions**: none.

**API surface** (Server Actions and library functions that change):

| Surface | Change | Errors |
|---|---|---|
| `BookInput.name`, `DetailsInput.name` (`lib/booking-input.ts`) | schema becomes `fullName("Enter your first and last name.")` | field error on `name` |
| `LearnerInput.name` (`lib/learner-input.ts`) | schema becomes `fullName("Enter the first and last name.")` | field error on `name` |
| `ensureNileLogin` (`server/authentik/nile-login.ts`) | refuses with `name_incomplete` before any write | `NileLoginError` gains `"name_incomplete"` |
| `nileLoginRefusal` | returns `"unavailable"` or `"name_incomplete"` instead of always `"unavailable"` | |
| `BOOK_ERRORS` (`lib/booking-input.ts`) | new `name_incomplete` message | |
| `RescheduleRefusal` (`server/booking/manage.ts`) | gains `"name_incomplete"` | |
| `updateLearnerIdentity` (`server/authentik/learners.ts`) | on a name change, also patches `attributes.firstName` and `attributes.lastName`, merged with the existing attributes | existing refusals |

**Value sourcing**:
| Action | Value produced or displayed | Source |
|---|---|---|
| Form field error | "Enter your first and last name." / "Enter the first and last name." | decided in this spec (AC-2, AC-3) |
| `ensureNileLogin` | the name it checks | the stored `users.name`, never a posted value (spec 0019 AC-1) |
| /book for a signed in learner | the name it checks | the session learner's `users` row (`sessionAccount`), since no name is posted |
| Learner refusal text | "Your account needs a first and last name. Please contact the lab admin." | decided in this spec (AC-5) |
| Admin sync | `firstName`, `lastName` | `nameWords` of the new `users.name` |

**Key invariants**:
- No Authentik user is patched with an empty `lastName` by any booking path.
- The rule exists in one function (`hasFullName`); forms and the backend call it, nothing else re-implements it.
- A refused booking or reschedule saves nothing (spec 0019 AC-5).

**Security model**: unchanged. The admin sync goes through the existing learner write guard, which refuses admins and users without the `hol_learner` attribute. No secret is involved. The message to a learner names no internal detail.

**Critical test scenarios**:
- Rule: "Ana", "", "  ", "Ana ." fail; "Ana Souza", "Ana de Souza", "李 明" pass, verifies **AC-1**.
- /book Step 1 and the final action refuse a one word name with the field error, even when Step 1 is skipped, verifies **AC-2**.
- Admin add and edit refuse a one word name, and an edit of a one word learner needs a full name in the same save, verifies **AC-3**.
- `ensureNileLogin` with a stored one word name returns `name_incomplete` and records no Authentik write (fake Authentik `writes` is empty), verifies **AC-4**.
- A signed in learner with a one word stored name who books or reschedules sees the "contact the lab admin" message and nothing is saved, verifies **AC-5**.
- An admin name edit patches `name`, `firstName` and `lastName` once, keeps `hol_learner`, `hol_user_id` and `mail`, and an admin or untagged target is refused with no write, verifies **AC-6**.
- A database parity check and `mapConstraintError` tests are untouched (no schema change), verifies **AC-7**.
- Existing login format tests for "Ana Souza" style names still pass, verifies **AC-8**.

## Build plan

Build approach: Tracer Bullet (from `AGENTS.md`). The first slice is one thin thread through every layer, the admin form to the Authentik attributes, then the other strands are added.

1. Add `hasFullName` to `lib/nile-login.ts` and `fullName(message)` in `lib/full-name.ts`, with plain input and output tests for the cases in AC-1, satisfies **AC-1**.
2. Thin thread: use `fullName` in `LearnerInput`, update the admin form field hint, and extend `updateLearnerIdentity` to patch `firstName` and `lastName` on a name change, with the edit test against the fake Authentik, satisfies **AC-3**, **AC-6**.
3. Use `fullName` in `BookInput` and `DetailsInput`, add the "First and last name" hint to the Step 1 field, and confirm `checkDetailsAction` returns the field error, satisfies **AC-2**.
4. Add the `name_incomplete` refusal to `ensureNileLogin` (before any write), widen `nileLoginRefusal`, and map it in `guest-booking.ts` and `manage.ts`; add `BOOK_ERRORS.name_incomplete` and the reschedule form message, satisfies **AC-4**, **AC-5**.
5. Update existing tests and fixtures that use a one word name (nile login, guest booking, manage, learners, e2e) and add the new scenarios, satisfies **AC-7**, **AC-8**.
6. Amend spec 0019 AC-1 and AC-4 with a pointer to this spec (done in this change), satisfies **AC-8**.

## Consequences

**Positive**:
- A learner with a one word name can no longer reach the Nile login screen with a broken account.
- The failure shows up at the booking form or as a clear message, not as a Nile error minutes before a lab.
- An admin fix for a name now reaches Nile at once.

**Negative / tradeoffs**:
- A person with only one name must type something for a second word. This is rare for this audience and the owner can handle it case by case.
- A signed in learner who already has a one word name finds out at the end of booking, not at the start. Only the affected learner is affected today, so a pre check on /book is not built.
- An admin cannot save any edit to a one word learner (even a company fix) without also fixing the name.
- A reschedule by that learner is refused until an admin fixes their name. That is intended, because it stops the placeholder last name being wiped.

**Neutral**:
- No migration, no schema change, no new audit action. The existing user edit audit row already records a name change.
- Spec 0019 AC-1 still describes the pure login function, which keeps its fallback for a last word that cleans to nothing. AC-1 of this spec is the form and backend rule that runs before it.

## Follow-up

- [ ] Owner: edit the affected learner's name in the admin Users page to their real first and last name. With AC-6 built this replaces the placeholder "Learner" in Authentik. Until then do not let him reschedule.
- [ ] The scope file (`docs/scope/scope.md`, feature 19 text on a one word name) still says a one word name becomes `firstname@domain`. `/scope` or `/sync` should update that line once this is built.
- [ ] Optional later: a pre check on /book that shows the "contact the admin" message before a signed in learner picks a time, if more learners with one word names appear.
