# 0013 verify: mail client matrix (AC-17, AC-23)

Run once before the feature is `done`, after the owner setup in [index.md](index.md). Use a `dev-` learner, with the Dev inbox set to a mailbox you can open in each client below (one Workspace or Gmail mailbox added to every client works).

## Steps

1. Book a slot as the `dev-` learner. Wait for the email (about a minute).
2. Reschedule it to another day.
3. Cancel it.
4. Open the HOL bookings calendar and check that the event appeared with a `[dev] ` prefix, moved, and was removed.

If a client shows the invite with an Add button instead of adding it on its own (Gmail does this for senders it doesn't trust yet), click Add, then continue. That is expected and counts as a pass.

## Matrix

For each client, record pass or fail and a note. "Layout" means it matches the standalone file in `context/` side by side: logo shows, heading, details card, link list, button, footer, and no broken images.

| Client | Booked layout | Invite added (automatically, or with Add) | Rescheduled: event moved, no duplicate | Cancelled layout | Event removed | Notes |
|---|---|---|---|---|---|---|
| Gmail web | | | | | | |
| Gmail Android or iOS | | | | | | |
| Outlook on the web | | | | | | |
| Outlook desktop (Windows) | | | | | | |
| Apple Mail (macOS or iOS) | | | | | | |

Also check: the subject reads `[dev] Your Nile Hands-On Lab access - <start>` with the time in the learner's zone; the Ops BCC mailbox got no copy (rerouted mail is never Bcc'd); the learner's Emails section on `/admin/users/<id>` shows three Sent rows.

Recorded by: ____ on ____
