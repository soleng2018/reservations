# 0004. Core booking loop: rationale

## Context

Specs 0001 to 0003 are built: the stack, the data model with its database rules (no overlap, one live booking), and Authentik sign in with the guest saga (`bookAsGuest`). Nothing yet connects them into something a person can use. No admin can create a testbed, no guest can reach a booking form, and there is no worker, so nothing grants lab access or cleans up a crashed saga. Spec 0002's saga already has a sweeper query (`staleProvisioning`), but nothing runs it.

The project builds Tracer Bullet, so the first slice has to be real at every layer and as narrow as possible. Real here means the real database and the real Authentik. On this host they are both shared with production, so whatever the slice writes is live.

Three forces pull against each other. Scope row 6 says the booking "adds the user to the testbed's group". Spec 0001 says only the worker's reconciler owns `pod-*` membership, and grants it only during the booking window. The design system (feature 5) and the admin console (slice 2) aren't built yet, so any UI here is temporary. And the guest form is public on the internet, and every submit can create a real Authentik user.

If this isn't decided, the first slice either skips a layer (and stops being a tracer) or grants access outside the window, which would quietly break the owner's access rule.

## Options considered

### Option 1: Thin slice with a minimal worker that owns access (chosen)

The admin gets create only forms that run a row first group saga. The guest flow reuses `bookAsGuest`, with the server assigning the testbed by trying each free testbed in name order. A hand started worker runs the reconciler and the sweepers.

**Pros**:
- Keeps spec 0001's rule that only the reconciler writes membership, so access never exists outside the window.
- Proves every layer, the worker included, and the reconciler then serves cancel, reschedule, and deactivation for free.
- Reuses the saga, guards, rate limits, and Turnstile already built.

**Cons**:
- A bigger first slice: worker, lock, and sweepers on top of the forms.
- The real membership add can only be seen once a booking's window starts (at least 1 hour after booking).

### Option 2: Add membership in the saga, reconciler later

The saga calls `addToPodGroup` as step 4, and the reconciler comes in a later slice.

**Pros**:
- The membership effect shows up right after booking, which is easy to demo and test.
- No worker in slice 1.

**Cons**:
- Grants access before the window, which breaks the owner's rule and spec 0001's invariant.
- Adds a fourth saga step with its own undo, and a crash leaves a member that nothing removes.
- The reconciler then has to replace this code, so the work is done twice.

### Option 3: Book only, defer access to feature 14

**Pros**:
- The narrowest slice.

**Cons**:
- Skips the Authentik group layer that the scope's done line asks for, so it's no longer a full tracer.
- Crashed sagas wait 10+ minutes for a sweeper that doesn't exist.

## Rationale

Option 1 is the only one that is real at every layer and doesn't break an invariant the owner set. The worker it adds isn't extra scope: spec 0001 needs it anyway, and building it now on the thinnest thread is cheaper than retrofitting it under a feature that already depends on membership. The engineer chose it over the scope wording, so the scope row is reworded (Follow-up).

Testbed assignment tries an `ON CONFLICT DO NOTHING` insert on each bookable testbed in name order, and doesn't lock and pick. The exclusion constraint already serializes writers, so this needs no extra locking and heals races by itself. Because `DO NOTHING` with no target would also swallow the one live booking index, the live booking check runs first as a plain select under the user row's `FOR UPDATE` lock, which can't race (a cross check found that, and that savepoints were unneeded). The name order keeps tests predictable. Least recently booked was the runner up: it spreads wear, but costs a query and makes tests harder to predict.

The testbed create saga runs row first because the slug is settled by the row's unique index before the group is named after it. A crash then leaves a row that isn't bookable (the sweeper removes it), never an orphan group that no row points to. Running the worker by hand (`npm run worker` via `tsx`) avoids pulling spec 0001's image build into the skeleton. The cost, that this hand started process is production, is written down in Consequences.

Recommended items decided while writing: the confirmation is rendered from the action's return state, not a URL (so no booking is exposed by a guessable link); the client IP comes from `CF-Connecting-IP` only when `TRUST_PROXY_HEADERS` is on (the dev port is reachable without the tunnel, so the header could be forged there); `countHourlyAttempt` is generalized to cover spec 0001's 10 minute IP window; reconciler adds and removes are audited, since they are access control changes; `/book` is `noindex` until feature 11 settles SEO.
