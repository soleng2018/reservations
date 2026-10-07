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

## Rationale

The group claim keeps admin management where the owner already creates admins and needs no app change. A 2 hour admin session bounds the lag of removing an admin without an Authentik call on every request.

The token decision follows from Authentik's model: the narrowest real option is global model permissions without access to providers, flows, or tokens, plus code guards that re-read the target before each write. The `pod-*` prefix guard from spec 0001 and the admin refusal in the saga were already the floor. This spec extends them to every user write and adds the `hol_learner` tag, so a hand made lab user can be booked (tagged once) without the app being able to act on arbitrary accounts later. Admin MFA closes the most damaging misuse of a stolen token (taking over an admin by changing its email).

Verification on first sign in is sound because a learner created by the saga has no password until they open the emailed recovery link, so a sign in proves they control the mailbox. The engineer chose a specific "This email can't be used for booking." message for admin emails over a generic error. It does reveal that an email is special, which the engineer accepted, and the refusal is audited.
