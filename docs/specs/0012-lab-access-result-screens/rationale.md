# 0012. Lab access and booking result screens: rationale

## Context

Feature 14 is the last part of the learner portal (Slice 3). The scope asks for lab links (Nile Portal, LMS, clients) right after booking and on Current booking details, "to a learner whose email is verified", greyed out on Past details, and left the success screen before verification for `/architect` to settle. The mock (`context/reservations_mock.html`) fixes the layouts: a "Your lab access" card on the success screen, "View lab access" on Current and Past cards only, and a detail page whose Past card fades to 50% opacity with clicks turned off.

Most of the access side already exists. Spec 0004's reconciler adds and removes `pod-*` members on the DB clock every 30 seconds and ends Authentik sessions on removal. Spec 0007 stores https only testbed URLs and keeps client OS credentials out of every learner screen. Spec 0003 sets `email_verified_at` at a learner's first sign in, so every signed in learner is verified. Spec 0001 chose the Cloudflare Access revoke as the only hard cut for open browser rendered VM sessions and deferred it here, behind spike 3. Without it, a VM session survives the booking by up to its 1 hour Access session.

The forces that shaped this:
- `/book` is public. Anyone can type any email there, and a reused account books with no proof of ownership (spec 0010). "Verified" describes the account, not the person at the keyboard.
- Feature 15 (the booking email that carries the links) is not built yet, so the app screens are, for now, the only place the links appear.
- No job runner exists yet (feature 15 builds it), and the reconciler removes membership before any revoke, so a failed revoke is never seen again by the state diff.
- The worker runs each step under a 60 second timeout, and many bookings can end on the same half hour.
- The design system has a contrast guard and keyboard tests; the mock's faded, unclickable anchors fail both.

## Options considered

### Option 1: session proven ownership through one shared read, inline bounded revoke (chosen)

Links are returned only by `ownLabAccess`, filtered by the session learner. Public replies never carry them. The reconciler calls Cloudflare revoke after each removal with a few quick retries and a per run breaker, then logs and audits the outcome.

**Pros**:
- Meets "access details reach only the booking's own verified learner" without trusting a typed email.
- One read and one owner of access. No migration, no new dependency.
- Bounded worst case per run, inside the step timeout.

**Cons**:
- Anonymous guests see no links on the success screen until feature 15's email exists.
- A revoke that fails all its tries is not retried later; the 1 hour backstop covers it.

### Option 2: gate on the verified flag alone (the mock taken literally)

Show links on the success screen whenever the booked user has `email_verified_at`, signed in or not.

**Pros**:
- Matches the mock and the scope wording, with the least friction for returning learners.
- The URLs are behind Authentik groups anyway, so seeing them does not grant access.

**Cons**:
- Anyone who types a verified learner's email books in their name and sees that testbed's portal tenant, LMS, and client URLs, a map of lab endpoints keyed to a person.
- "Verified" stops meaning anything on a public form.

### Option 3: durable revoke job

Enqueue an `access_revoke` row in `jobs` on each removal and add a worker step that drains that kind with backoff.

**Pros**:
- Survives a worker crash and a long Cloudflare outage, and retries until it works.

**Cons**:
- A migration for `jobs.kind`, a new `JobKind`, and part of feature 15's runner built early, for a failure the 1 hour backstop already bounds.

### Option 4: defer the VM cut and keep the 1 hour backstop

Ship only the screens, and leave open VM sessions to expire on their own.

**Pros**:
- The least to build, with no Cloudflare token to hold.

**Cons**:
- Fails the done line "an open lab session stops working right after the lab time is over" for the only systems that can be hard cut.

## Rationale

The public `/book` form is the deciding force for the screens. Spec 0003 made "verified" mean "has signed in once", which only proves something when a session is present, so the gate is the session plus the verified flag (Option 1) rather than the flag alone (Option 2). The cost lands on anonymous returning learners for a short window, and feature 15's email removes it.

For the VM cut, the deferral in spec 0001 was always to this feature, and Option 4 would fail its done line. Between inline and durable retries, the forces are that no job runner exists yet and the 1 hour session already bounds the failure. A few inline retries catch the common transient error. The breaker stops a Cloudflare outage at a booking boundary from multiplying into a step timeout, and that timeout matters because a timed out step keeps running in the background and can overlap the next tick. Option 3 is the upgrade path if the logs show revokes failing after their retries.

Smaller calls made with the engineer, each with its runner up:
- Upcoming detail page by direct URL: render it with a "not started" note, because the signed in success screen already shows the same links. Runner up: redirect to the list.
- Past links: plain "Ended" text, not faded anchors, so the card passes the contrast guard and keyboard users can't reach dead links. Runner up: the mock's opacity with `aria-disabled` and an exception in the guard.
- Cancel speed: keep the 30 second tick, which matches spec 0011's shipped copy ("within a minute"). Runner up: `LISTEN/NOTIFY` to wake the worker, which adds a second wake path on the lock connection.
- Cloudflare client: plain `fetch` plus Zod for one endpoint. Runner up: the official `cloudflare` SDK, which is far more surface than one call needs.
- Cloudflare config: optional (both or neither), so the worker isn't blocked on the owner's Access setup. Runner up: required, failing fast.
- Audit: the outcome folded into the existing `access.revoked` row. Runner up: a separate `access.vm_revoked` action, which leaves no row on failure.
- Start delay: the card says links can take up to a minute. Runner up: the mock's copy alone.

Calls made while writing:
- Retry schedule: 3 tries at 0, 2, and 5 seconds, each with a 5 second timeout, about 22 seconds worst case. Retrying only 429, 5xx, timeouts, and network errors. A 401 or 403 means bad configuration that no retry fixes, so it trips the breaker; any other 4xx is about that one address, so it fails only that learner (a cross check finding: tripping on every 4xx would let one odd email silence the rest of the run). Runner up: 10 second timeouts, which could pass 40 seconds on one learner.
- Logs name the user id, not the email, matching the reconciler's existing practice of logging Authentik pks.
- `rel="noopener noreferrer"` on every lab link, so the booking id in the page URL never reaches a lab site as a Referer.

## Spike 3 evidence

_To be filled by build task 1: the confirmed endpoint and token permission, whether an open browser rendered session ends after revoke (and how fast), a fresh sign in after revoke, the `groups` claim policy match, and the RDP GA status._
