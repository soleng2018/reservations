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
- Cloudflare config: optional (both or neither), so the worker isn't blocked on the owner's Access setup. Runner up: required, failing fast. (Superseded on 2026-10-14: the config moved to a `CLOUDFLARE` API key, still optional, see below.)
- Audit: the outcome folded into the existing `access.revoked` row. Runner up: a separate `access.vm_revoked` action, which leaves no row on failure.
- Start delay: the card says links can take up to a minute. Runner up: the mock's copy alone.

Calls made while writing:
- Retry schedule: 3 tries at 0, 2, and 5 seconds, each with a 5 second timeout, about 22 seconds worst case. Retrying only 429, 5xx, timeouts, and network errors. A 401 or 403 means bad configuration that no retry fixes, so it trips the breaker; any other 4xx is about that one address, so it fails only that learner (a cross check finding: tripping on every 4xx would let one odd email silence the rest of the run). Runner up: 10 second timeouts, which could pass 40 seconds on one learner.
- Logs name the user id, not the email, matching the reconciler's existing practice of logging Authentik pks.
- `rel="noopener noreferrer"` on every lab link, so the booking id in the page URL never reaches a lab site as a Referer.

Calls made on 2026-10-14, after spike 3:
- VM sign in for learners: a dedicated Authentik app, HOL Labs (`hol-labs`, its own authorization flow `hol-lab-authorization`, the policy `hol-labs-access` bound to the app), added to Cloudflare as a second login method used only by the VM apps. Spike 3 found that spec 0003's learner isolation denies every learner on `cloudflare-integration`, the login all VM apps used, so no learner could ever reach a VM. Runners up: point `cloudflare-integration` at a learner friendly flow (edits an existing provider, outside the owner's write boundary, and opens every Cloudflare app on that login to learners), or loosen the isolation policy for `pod-*` members (lets booked learners into `leo` and `traefik-apps`, breaking spec 0003 AC-17). The engineer chose HOL Labs.
- Group link: each VM's Cloudflare policy checks the app made `pod-<slug>`, set by the owner per testbed. The owner's hand made groups `nw1` to `nw4` retire. Runner up: let a testbed adopt an existing `nwN` group, which needs a migration, a wider write guard, and writes to Authentik objects the app did not create. The engineer chose `pod-*`.
- Cloudflare credentials: an API key of a new type `CLOUDFLARE` on the admin API Keys page (spec 0006), asked for by the engineer, so the owner rotates the token without a redeploy and the worker reads it per run. Runner up: the env vars and token file built in task 4 (worker only, simpler, but rotation means a file copy and a restart).
- Account id: carried in the key's base URL (`…/client/v4/accounts/<id>`), which the revoke path extends. No new column, and the field is already https checked, displayed, and audited (not secret). Runner up: an `account_id` column, a migration and a form field for one value.
- One live Cloudflare key, enforced by a partial unique index, so the worker never has to choose. Runner up: pick the newest, which hides a stale duplicate.
- A broken key (the worker can't read the keyring or decrypt) records `failed`, not `off`, because the owner meant revoke to be on. Runner up: `off`, which would silently look intended.
- Save time check: `GET {baseUrl}/access/organizations` instead of Cloudflare's token verify, a cross check finding. One read proves the token is valid, belongs to that account, and can use Access, for user and account tokens alike; token verify proves only "active". Checked 2026-10-14 with the spike token: right account 200 (`auth_domain` `soleng2018.cloudflareaccess.com`), wrong account 403, malformed token 400. Runner up: `/user/tokens/verify` then the account route, which passes a token with the wrong permission.
- The web process never decrypts the token: a save verifies only a token that was just typed, and changing a Cloudflare key's base URL asks for the token again. Runner up: decrypt the stored token to verify an account change, which widens where `decryptSecret` runs.

## Spike 3 evidence

Run on 2026-10-14 by the engineer and Claude, on `nw4-mac1.nile.global` (a QEMU macOS VM over browser rendered VNC), with `hol-test-learner@example.test` (path `hol/learners`) and the app's provisioning token for group changes. Cloudflare team domain `soleng2018.cloudflareaccess.com`; Authentik 2026.8.3.

Starting state found:
- Authentik already acts as Cloudflare's identity provider (`cloudflare-integration`, OAuth2 provider pk 7, on `default-provider-authorization-implicit-consent`), and the VM apps checked hand made groups `nw1` to `nw4` (attribute `pod: nwN`), not the app's `pod-*` groups. `pod-nile-hol-1` existed (made by the app for "Nile HOL 1") with no Cloudflare policy on it.
- A learner opening the VM ended on Authentik's "Permission denied" before Cloudflare was asked: `hol-learner-isolation` is bound to that default flow (spec 0003 AC-17).

What was set up during the spike:
- Authentik (new objects only): the `hol-labs-access` expression policy, the `hol-lab-authorization` flow (no stages, no bindings, a copy of `hol-authorization`), the "HOL Labs" OAuth2 provider (pk 8, copied from pk 7: same signing key, `openid` `email` `profile` mappings, `sub_mode` hashed user id, issuer per provider, strict redirect `https://soleng2018.cloudflareaccess.com/cdn-cgi/access/callback`, grants `authorization_code` and `refresh_token` only), and the `hol-labs` application with the policy bound. The client secret was saved to `~/secrets/hol_labs_client_secret` (mode 600). The `profile` mapping already carries `groups: [group.name for group in request.user.groups.all()]`.
- Cloudflare (by the owner): login method "Reservations HOL Labs"; `nw4-mac1` set to that method only, with an Allow policy on OIDC claim `groups` = `pod-nile-hol-1`.

Results:

| Check | Result |
|---|---|
| Cloudflare test of the HOL Labs login (owner's staff account) | succeeded; `oidc_fields.groups` present |
| Learner in no `pod-*` group, through HOL Labs | refused by Authentik (`hol-labs-access`); policy test: learner false, `hol-test-admin` true |
| Learner in `pod-nile-hol-1`, before the Cloudflare policy was right | Authentik passed, Cloudflare said "That account does not have access" (the policy still pointed at the old login method) |
| Learner in `pod-nile-hol-1`, policy fixed | reached the VM (page "QEMU (macos)"); `get-identity` showed `groups: ["pod-nile-hol-1"]` and an OIDC identity provider |
| Learner removed from the group, fresh sign in | refused by Authentik within about 7 seconds (no stale policy cache) |
| Learner removed, open session, no revoke | still working: the VM URL answered 200 |
| Token | a user API token, `GET /user/tokens/verify` → `active` (`/accounts/<id>/tokens/verify` → 401 for a user token); permission Account → Access: Organizations, Identity Providers, and Groups → Edit |
| `POST /accounts/e6043d055ee10da55bd8e4b39758c681/access/organizations/revoke_user` `{ "email" }` | HTTP 200, `{ "success": true, "result": true }`, twice |
| After the revoke, new requests | 302 to the Access login within about 5 seconds |
| After the revoke, the open VNC websocket | kept streaming (about 13 frames every 5 seconds) for 37 seconds, then Cloudflare closed it; no frames after, mouse input ignored, a reload landed on the Access login |
| Fresh sign in 1 to 2 minutes after a revoke (learner back in the group) | Cloudflare "Current authentication token is expired. Try again later." |
| Fresh sign in about 2 minutes after a revoke | worked |

Not covered: a Windows RDP session (expected to behave the same, since the cut is at the Access session; owner to confirm once, see Follow-up). The RDP GA status was not checked; the VMs already run browser rendered RDP and VNC in production use.

Cleanup: `hol-test-learner` was removed from `pod-nile-hol-1` after each run; the group was left empty. The HOL Labs objects stay in place for the owner's VM setup.
