# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Every testbed now has a Domain, one per Nile tenant. It shows in the Testbeds list as its own column and in the search (see spec 0017).
- The add testbed form has a Group dropdown. It lists the Authentik groups the owner marked with `hol_testbed_group`, sorted by name. A group already used by a live testbed is not offered.
- The Domain is filled in from the chosen group's `hol_testbed_domain` attribute. It is read only on add and on edit, so the domain and the group can never disagree. A marked group with no valid domain is shown as "(no domain set)" and cannot be chosen.
- The add testbed form says so when it cannot list groups. If Authentik is unreachable it shows "Couldn't load the Authentik groups" and turns Save off. If no listed group has a domain yet, it tells the admin to ask the owner to set `hol_testbed_domain`.
- A worker step releases the group of a deleted testbed. It only removes learners and never touches the group itself. A group still used by a live testbed is left alone.
- New refusal messages on save: the group does not exist, it is not marked for testbeds, it is already in use, or it has no domain.
- New audit actions for the group release, and a source scan (`tests/group-writes-scan.test.ts`) that fails if app code ever creates, updates, or deletes an Authentik group.
- A learner now gets a Nile login in the domain of the testbed they booked, such as `ana.souza@nileworkshop-1.com`, so they can sign in to that Nile tenant. It is still one Authentik user and one password per learner. A booking or a reschedule sets the user's username, `mail`, `firstName`, and `lastName` for that domain (see spec 0019).
- If the plain login is already taken, a random number is added to the name part, as in `ana.souza4821@domain`. A learner who returns to a domain gets the same login again. Two learners booked at the same moment never get the same login.
- The login shows in the booked, rescheduled, and reminder emails, on the booking and reschedule success screens, and on the reservation page. It is read when the email is sent and is never copied into an email record or a job.
- The admin learner page has a read only "Nile logins" list with each domain, its login, and which one a booking set last.
- A new audit action, `user.nile_login_set`, and a source scan (`tests/nile-login-scan.test.ts`) that keeps the login code out of everything except the booking flows.

### Changed

- A testbed now points at a group the owner already made in Authentik. The app no longer creates `pod-<slug>` groups. It only adds and removes learners in the group.
- The access reconciler works per group. When two testbeds share a group, a learner stays in it while any of those testbeds has a current booking for them.
- The HOL Labs access rule now lets a learner through only while they are in a group marked `hol_testbed_group`, instead of matching `pod-` names. The change reaches Authentik only when the owner runs the setup script with `--apply`.
- The Name on edit is read only, because it is the Authentik group. To use another group, delete the testbed and add a new one.
- Testbed audit entries now record the domain and group, and no longer record a group created by the app.
- A learner's name must now have a first and a last name. The booking form, the admin learner form, and the booking flow refuse a one word name, and an admin name edit also updates `firstName` and `lastName` in Authentik (see spec 0025).
- An admin email fix still changes the learner's email. It changes the Authentik username too only when the learner has no Nile login yet, so a learner with a Nile login keeps it.
- If Authentik is down, or every numbered login clashes, the booking or reschedule is refused with the usual "try again shortly" message and nothing is saved.

### Removed

- The "Not ready" badge and the "Still being set up" state on testbeds. A live testbed now always has its group.
- The old teardown step that deleted a testbed's group.

### Upgrade notes

- Migration `0013_testbed_domain.sql` refuses to run while any live testbed exists, or while a deleted testbed still waits for its group release. Delete or release those first.
- Before you pick a group, the owner needs to add `hol_testbed_group` and `hol_testbed_domain` to it in Authentik.
- Migration `0015_learner_domain_logins.sql` adds the `learner_domain_logins` table. It changes no existing data.
- Before Nile logins work, the owner needs to check two things in Authentik: the sign in step accepts the learner's real email, and each tenant's SAML NameID uses the username.
