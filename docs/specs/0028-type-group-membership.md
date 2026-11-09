# 0028. Type group membership

**Date**: 2026-11-09
**Status**: Accepted (amends spec 0026 AC-13)

## Summary

Spec 0026 gave every Testbed Type an Authentik group for the LMS but said no learner is ever added to it, so nobody got LMS access unless the owner added them by hand (found 2026-11-09: a learner reached the clients and the Nile Portal but the LMS said he was not in the group). The access reconciler now also keeps each live type's group in step with bookings: a learner is a member while a confirmed booking on a testbed of that type is Current by the DB clock, and leaves when none is.

## Acceptance criteria

- **AC-1**: Each worker run, for every live type with a stored `authentik_group_pk`, the desired members are the active learners (with an Authentik pk) whose confirmed booking on any testbed of that type is Current. The group is read; members are added and removed through `membershipDiff`, so only members tagged `hol_learner` are ever removed and untagged members are never touched.
- **AC-2**: A type with no group yet (not backfilled) is skipped. The pk is never relinked or changed here.
- **AC-3**: Every add re-reads the group through the guard (`add_type`): refused for the admin group (pk or name), a superuser group, a group with a parent or a role (or unknown), or any group carrying the `hol_testbed_group` key. A reused (owner made) group passes the same test spec 0026 AC-3 applies. A removal needs only that the group is not the admin group.
- **AC-4**: Adds and removals are audited (`access.granted`, `access.revoked`, metadata `kind: "type"`). A type group removal does not end sessions or call Cloudflare; the testbed group's removal in the same run does that.
- **AC-5**: Failures are logged once per type and kind with a count, never per learner, and never stop other groups.
- **AC-6**: The reconciler still never creates, renames, or deletes any group; `tests/group-writes-scan.test.ts` is unchanged.

Access ends with the booking, as testbed access does. A learner with an upcoming booking is added when it starts, within one worker tick.

## Safety and rollout

- A type group is skipped, with one logged line, when its pk is also a testbed's group pk, or when it no longer passes the `add_type` guard (for example the owner later marks it `hol_testbed_group`). Nothing is added or removed there, so the two passes never fight over one group. (Found in review 2026-11-09.)
- The first run after deploy removes tagged learners who are in a type group but have no Current booking of that type, including learners the owner added by hand. Untagged users are never touched.
- A soft deleted type is no longer visited, so a reused group left in place keeps its members. Accepted.
