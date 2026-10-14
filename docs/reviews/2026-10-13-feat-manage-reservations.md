# Review, feat/manage-reservations, 2026-10-13

**Reviewed by**: Sonnet 5.5 (author on Opus; a different model family)
**Scope**: 53 files, branch vs main
**Verdict**: Approve with nits

## Summary
Adds the signed in learner area for spec 0011: the `/reservations` list, a locked in place cancel, a locked reschedule (own testbed preferred, overlap constraint as last word, idempotent retry), a reschedule page reusing the `/book` steps through a shared `lib/time-pick.ts` slice, and a signed in `/book` that takes identity from the session row. Authorization, locking order, DB clock use, audit in the same transaction, and per user buckets all match the spec. typecheck, eslint, prettier, and the Vitest run are clean. Only small deviations and nits remain.

## Minor
### 🟡 same_time is checked before the offerable check, `server/booking/manage.ts:~288`
**Problem**: Spec AC-9 step (3) runs `isOfferableStart` (else `slot_taken`) first and then `same_time`. The code checks `same_time` first.
**Why it matters**: A Current or near start booking whose own start is inside the lead time, re-picked, gets `same_time` here but `slot_taken` per spec. The code order is arguably friendlier, but the spec is the contract and no test pins either order.
**Suggested fix**: Either reorder to match the spec, or update AC-9 and add a test that fixes the chosen order.

### 🟡 Retry shortcut does not require the booking to be live, `server/booking/manage.ts:~236`
**Problem**: `alreadyRescheduled` reads without a lock and without `ends_at > now()`. A lost reply retried after the moved booking has since ended still answers `rescheduled`.
**Why it matters**: Low (the learner sees a success for a move that did commit), but it is the only path in the feature that reports success without the `ends_at > now()` guard that the spec's key invariants name.
**Suggested fix**: Add the `ends_at > now()` filter, or note in a comment that reporting the committed move is intended.

## Nits
- ⚪ `app/reservations/actions.ts:~100`, `CancelInput.version` is `z.number().int()` while `rescheduleAction` uses `.positive()`; make them the same.
- ⚪ `server/booking/availability.ts:~88`, `excludeBookingId ?? ""` inside `$if` is a workaround for narrowing; restructure so no empty string stands in for an id.
- ⚪ `app/reservations/page.tsx:~23`, `cn` import sits after the relative imports; group with the other `@/lib` imports.
- ⚪ `server/booking/manage.ts` `learnerBookings` uses SQL `now()` for `reschedulable` while the page reads `dbNow()` separately for the phase; the two can differ by milliseconds across a boundary (display only, harmless).
- ⚪ `docs/specs/0011-manage-reservations/index.md:4`, Status still "In Progress" with every build step ticked; flip it when merging.

## Strengths
- Ownership is enforced in every query (`user_id` plus `z.uuid()`), so another learner's id behaves like an unknown one on the page and in all actions; every new action calls `requireLearner()` first and none joins the public allow list.
- The transaction is correct and complete: `users` row `FOR SHARE`, booking `FOR UPDATE` with the version, type `FOR SHARE`, `lockBookableTestbed` per candidate, `anyLocked` rule for `slot_taken` vs `unavailable`, audit inside `refusable()`, and deadlock, serialization, and overlap mapped to `slot_taken` outside it with everything else rethrown.
- The server side time decisions use the DB clock throughout (`now()`, `dbNow`), and the `/book` override takes name, company, email, and zone from the session row so a crafted post cannot book under another email, with `signed_out` for a claimed account without a session.
- Good reuse: the extracted `time-pick` slice, `preferFirst`, `firstName`, and exhaustive `never` switches in the reducer and `cardActions`.

## Test coverage
Strong. `server/booking/manage.test.ts` covers list, reschedulable rules, `hasLiveBooking`, cancel (stale, Past, other learner, deactivated, audit), every reschedule outcome in AC-9, the race halves (constraint error, `40P01`, `40001`, rethrow) using `inRollback`, and `toRescheduleError`. `server/worker/reconcile.test.ts` covers AC-16 (cancel and move of a Current booking, new group on a later start, app session untouched). Action tests, reducer tests, `time-pick`, `sessionAccount`, and Playwright journey, axe, and screenshots are added. Not covered: the order of `same_time` against the lead time check, and the retry shortcut after the booking has ended.

## Follow up (2026-10-13)
- same_time order: kept the code order (same_time first, the truer reply for a Current booking's past start), stated it in spec 0011 AC-9, and pinned it with a test in `server/booking/manage.test.ts`.
- Retry shortcut: kept without the `ends_at > now()` guard on purpose (it reports a move that did commit and writes nothing); a comment in `server/booking/manage.ts` says so.
- `CancelInput.version` is now `.positive()`, like `rescheduleAction`.
- Spec 0011 status is now Accepted. The other nits are left as they are.
