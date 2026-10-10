# 0003. Rationale: Authentik sign in and learner provisioning

## Context

Spec 0001 put every sign in on one dedicated Authentik and fixed the plumbing: Better Auth generic OAuth with DB sessions, a master key used only by a setup script, and a provisioning token for runtime calls. It left four questions to this feature. How is an admin recognized? What can the provisioning token do, and what is the fallback if Authentik can't narrow it to learners? How does a learner's email become verified? How does deactivation block sign in?

The forces at play: admins are created by hand in Authentik and the app must never create one. Dev and prod share one Authentik, so a bug in dev hits real accounts. Guest booking creates real identities without anyone signing in, so the token is reachable from a public form. The labs trust Authentik group membership, so a token that can edit groups is effectively lab access.

Authentik's RBAC grants permissions per model (for example "change user") globally, or per object. It has no rule like "only users on this path" or "not users in group X". Per object grants would need the master key at runtime to grant rights on each new learner.

## Options considered

### Option 1: Group claim roles, guarded token, verify on first sign in (chosen)

**Pros**: everything lives in Authentik; no extra Authentik flows or SMTP; the guards are plain code and unit tested.
**Cons**: the guards only bind the app's own calls, not a stolen token; admin removal lags up to one session length.

### Option 2: Email allow list for admins in env

**Pros**: trivial to build.
**Cons**: needs a redeploy to change admins; trusts the email claim alone; two places to manage admins.

### Option 3: Per object RBAC for each learner

**Pros**: the token truly can't touch admins.
**Cons**: needs a privileged key at runtime to grant object rights, which breaks the scope rule that the master key is never used for day to day calls.

### Option 4: Authentik flow attribute for verification

**Pros**: marks verification exactly when the password is set.
**Cons**: a custom flow stage to maintain on a shared instance, plus a claim mapping. First sign in proves the same mailbox ownership.

### Learner isolation (added 2026-10-07)

Found during verify: every application in the shared Authentik (Cloudflare Integration, leo, Traefik Apps, HOL) has zero policy bindings, so any active user may open any of them. Before this feature only staff had accounts. The guest saga now gives anyone who books an Authentik password, so they could open internal apps. The owner ruled out editing the other apps.

- **A. Flow policy on the shared authorization flows (chosen).** All four apps authorize through `default-provider-authorization-implicit-consent`, which runs on every app open, signed in or not, and knows which app is being opened. One policy bound there, and on the unused `default-provider-authorization-explicit-consent` for future apps, covers every app without touching one. Risk: these flows gate every app for everyone.
  - *Corrected 2026-10-07 (found during /develop):* the first version bound the policy to `default-authentication-flow`. That is only the login form: it runs once, and a learner who already has an Authentik session (for example right after signing in to HOL) opens other apps without it, so AC-17 would fail.
  - *Reworked 2026-10-07 (spike failed):* the policy used to read the app being opened (`request.context["application"]`) and allow only HOL. The spike showed that Authentik saves a flow policy's result per binding, user, and session, not per app. So after a learner passed on HOL, `leo` and `cloudflare-integration` reused that pass and opened. Also, the `ak_message` text never appeared on the denial page. The fix is a policy whose answer depends only on the user: it denies every learner on the default flows. HOL moves to its own empty authorization flow, `hol-authorization`, so the deny never reaches it. This changes only the HOL provider, which the setup script already owns. The custom denial message was dropped.
  - *Considered and declined (at first):* new HOL owned flows instead of touching defaults. A new flow only runs for providers that point at it, so blocking the other apps would mean switching their three providers to it, which edits the apps the owner wants left alone, and a new app stays open until switched. The owner chose bindings on both default authorization flows (one removable binding each, no stage or setting changes).
- **B. Bindings on each other app.** The standard Authentik way, but edits apps the owner wants left alone, and a new app is open until someone remembers.
- **C. A separate Authentik for learners.** Full isolation, but another instance to run and admins sign in twice.
- **D. A custom learner login flow only.** Does not work: the other apps never run it, so a learner with a password still gets in through the default flow.
- **E. External user type only.** Hides the overview, but direct app URLs still work. Kept as an extra layer (AC-18).

The block keys on the `hol/learners` path, not the `hol_learner` attribute, so a staff member who books with a work email (tagged, not moved) keeps their apps. Sign out ends the whole Authentik session (owner's choice: shared lab computers).

### Sign out (reworked 2026-10-07)

The first design sent the browser to Authentik's end session URL, with a HOL owned invalidation flow (`hol-invalidation`) that was meant to follow `post_logout_redirect_uri`. The spike showed it ends the session but then lands on `default-authentication-flow`, so the user never comes back to HOL.

- **A. The server deletes the user's Authentik sessions through the API, then redirects (chosen).** The provisioning token already has this right for deactivation. It works the same on any Authentik version and on every base URL, and the browser never sees an Authentik page. Tradeoff: it ends that user's sessions on every device, not just this browser.
- **B. Keep the end session redirect and accept the login page.** Simple, but the user is left on Authentik's login page and not back in HOL.
- **C. A redirect stage in `hol-invalidation`.** Authentik's redirect stage takes one fixed URL, but dev and prod share the provider, so one of them would land on the wrong host, and it can't pick by role.

## Rationale

The group claim keeps admin management where the owner already creates admins and needs no app change. A 2 hour admin session bounds the lag of removing an admin without an Authentik call on every request.

The token decision follows from Authentik's model: the narrowest real option is global model permissions without access to providers, flows, or tokens, plus code guards that re-read the target before each write. The `pod-*` prefix guard from spec 0001 and the admin refusal in the saga were already the floor. This spec extends them to every user write and adds the `hol_learner` tag, so a hand made lab user can be booked (tagged once) without the app being able to act on arbitrary accounts later. Admin MFA closes the most damaging misuse of a stolen token (taking over an admin by changing its email).

Verification on first sign in is sound because a learner created by the saga has no password until they open the emailed recovery link, so a sign in proves they control the mailbox. The engineer chose a specific "This email can't be used for booking." message for admin emails over a generic error. It does reveal that an email is special, which the engineer accepted, and the refusal is audited.
