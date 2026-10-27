# 0017 rationale: testbed domain and predefined groups

The build spec is [index.md](index.md). This file is the decision record: why, and what else was weighed.

## Context

Today the app makes an Authentik group for every testbed, `pod-<slug>`, stamps it with the testbed's id, adds learners to it while their booking is Current, and deletes it when the testbed is deleted. The owner binds that group to the lab apps by hand. The app's safety rests on that name: the guard refuses any group write unless the name starts with `pod-`, and the HOL Labs gate (`hol-labs-access`) lets a learner through only while they are in a group that starts with `pod-`.

The labs have changed shape. Each Nile tenant is tied to one email domain, and the owner already defines one group per tenant with a separate script (for example `NileWorkshop1Admin`). Cloudflare Access rules for the lab VMs and the tenant's own sign in use that group name. A learner must also sign in to the tenant under a user in the tenant's domain (feature 20), so a testbed has to carry that domain. A second, app made group per testbed is now a duplicate name for the same thing.

If the admin types the testbed's name and that name picks the group, the name prefix can no longer protect anything. The provisioning token cannot tell an admin group from a lab group, so the app's own check is the only thing between a typo, or a bad name, and a learner landing in `hol-admins` or a superuser group. The same prefix assumption sits in the gate.

The system is live and shared. Dev and prod use one database, there is one production worker that reconciles every 30 seconds, and two live testbeds exist that the owner will delete before this ships. A testbed's group pk is stored and used by booking and availability, so it has to stay correct if the owner's script ever recreates a group, and a testbed deleted and added again under the same name will point at the same group as its deleted twin.

## Options considered

### Option 1: Fix in place, keep the app made groups and only add the Domain

Add `testbeds.domain` with its checks and keep creating `pod-<slug>` groups, the guard, the gate, and the teardown exactly as they are.

**Pros**:
- Smallest change. No guard, gate, worker, or owner step changes.
- Nothing to coordinate with the owner's script.

**Cons**:
- Two group names for one lab: the owner's tenant group and the app's `pod-` group, with the owner binding the second by hand for every testbed.
- It does not do what the scope asks. The owner decided the app stops creating and deleting groups.
- The Cloudflare rules would need `pod-<slug>` names that nobody else uses.

### Option 2: Side by side, support both kinds of group for a while

Add a column saying whether a testbed's group is app made or predefined. Keep the `pod-` code for the old kind and add the new path for the other, then retire the old one later.

**Pros**:
- No order of owner steps. The migration never has to refuse.
- Old testbeds keep working during the change.

**Cons**:
- Two guards (prefix and marker), two release paths, and two gate rules, all live at once.
- There is nothing to migrate: two testbeds exist and the owner is deleting them. The extra paths would exist only to serve rows that will be gone.
- The gate would have to accept both forms, so the weaker one (a name prefix) stays alive.

### Option 3: Replace directly with predefined, marked groups

Find the group by the typed name, accept it only if it carries a marker, store its pk, manage only membership, and release (not delete) a deleted testbed's group. The marker also drives the gate. The migration refuses while a live testbed exists, so the change happens after the owner's cleanup.

**Pros**:
- One kind of group, one guard, one gate rule, and a smaller app: no create saga, undo, sweeper, or badge.
- The allow list is explicit, and the app cannot create a group that passes it by accident.

**Cons**:
- Owner steps must happen in order, and a migration run too early touches production.
- A group that vanishes or loses its marker after save is only visible in the worker log.

## Rationale

Option 3 fits the forces in Context. The scope already settled that the app makes no groups, which rules out Option 1. Option 2 adds a second code path for data that will not exist: with two live testbeds and an owner who deletes them first, a side by side period buys safety against a situation that is already handled by a single migration check.

The risk that decides the design is the typed name. A marker attribute is the only check that does not depend on how groups happen to be named, and it costs the owner one attribute in a script they already run. A deny list alone would leave the gate saying "member of any group", which assumes learners are in no other group. A name pattern would need a code change for the next tenant. The marker is only as strong as who can create groups in Authentik: the app code never does (a scan proves it), but the provisioning token still holds `add_group`, so removing that right is the proper follow up. Because a marked group could still be nested under a superuser group or carry roles, the guard also refuses groups with a parent or a role.

The rest follows from keeping the group's meaning stable. The name is locked after create so a testbed's group never changes underneath a live booking, and a stale pk is healed by name because the owner's script is the one thing that can recreate a group. Release instead of delete honours "the app deletes no group", and the shared pk rule stops a deleted testbed from emptying the group its replacement is using.

## Decisions inside the chosen option

Each row is a call made while designing Option 3. Rows marked "engineer" were put to the engineer on 2026-10-23; the others were settled by the architect and are open to override.

| Decision | Pick | Runner up | Why |
|---|---|---|---|
| How a group is recognised as a testbed group (engineer) | Marker attribute `hol_testbed_group = true`, plus a refusal of superuser groups and `hol-admins` | Deny list only | The only strict allow list; also lets the gate stop depending on names. The runner up needs no script change but weakens the gate. A name pattern was the third option. |
| What else the guard refuses (cross check) | Superuser groups, groups with a parent or a role, `hol-admins` by pk and by name ignoring case, a marker that is not the boolean `true`, and two groups with one exact name | Refuse only superuser groups and `hol-admins` | A marked group can still inherit admin rights through a parent or a role. Lab groups are flat, so the stricter rule costs nothing. |
| One live testbed per group pk (cross check) | A unique index on the live pk, plus a stale check that compares the group's name with the testbed's | Trust the stored pk | A renamed and remade group would otherwise leave learners in the wrong group, and a later testbed could end up on the same pk. |
| Reconciler shape (cross check) | Work per distinct pk, with the wanted members as the union over live testbeds | Skip a deleted row whose pk a live testbed holds | Removes any dependence on row order inside a tick. A deleted row simply adds no one. |
| Check order on create (cross check) | Zod, a database precheck of name then domain, the Authentik lookup, then the transaction | Lookup first | A taken name should show its own message even when Authentik is down, and needs no Authentik call. |
| Migration guard (cross check) | Lock the table, then raise on live testbeds and on a pending release | Raise on live testbeds only, and ask the owner to check the rest | Removes a manual step that could orphan a `pod-` group. |
| Sequence on a shared database (cross check) | Owner steps 1 and 2, then `/develop` applies `0013`, then the gate, then the deploy | Apply `0013` only at the deploy | DB tests and codegen cannot run without the column, and the gate must be live before its real test can pass. |
| Group reads (cross check) | `includeUsers: false` | Default reads | A tenant group can hold many members, and a read happens before every write. |
| Marker spelling (engineer) | Boolean `hol_testbed_group` | `hol_testbed = <domain>` | Matches `hol_learner` and `hol_user_id`; the domain in the marker would have to be kept in step by the script. |
| Can the Name change (engineer) | Locked after create | Editable with no live bookings | Keeps "a testbed's group never changes" true, and avoids a learner left in the old group with nothing watching it. |
| Can the Domain change (engineer) | Only with no Upcoming or Current reservations | Locked after create | Fixes a typo without delete and add, and no booking in flight holds a user in the old domain. |
| Stale pk (engineer) | Self heal by name in the reconciler | Pin the pk and log | Costs nothing on a healthy tick and survives the owner re running a script that recreates groups. |
| The old "Not ready" state (engineer) | Removed, backed by `testbeds_live_group_check` | Keep as dead code | Create is one insert, so the state cannot occur. |
| Domain in the list (engineer) | A column, searchable | Edit dialog only | Shows at once which tenant each testbed is. |
| Refusal text (engineer) | Two messages (not found; found but unusable) | One message | The common mistake is a new group without the marker, and a single message makes it look like a typo. |
| Group disappears after save (engineer) | Log only, follow up | Audit row once per outage | Matches every other reconciler failure today; cheapest. |
| References (engineer) | None | | Everything here comes from the repo. |
| What happens to a deleted testbed's group | Release: stamp the row when the group is empty of tagged learners, gone, or held by a live testbed | Delete the group; or stamp at delete time | Deleting breaks "the app deletes no group". Stamping at delete time could leave a just ended learner in the group with nothing left to remove them. |
| Add versus remove strictness | Add needs the marker; remove needs only "not `hol-admins`" | Same rule for both | A removal never grants anything, and it must still work if the owner removes a marker while learners are inside. |
| Existing column `authentik_group_deleted_at` | Keep the name, change the meaning | Rename to "released" | A rename would break the running worker between the migration and the new worker. Listed as a later cleanup. |
| Migration for old rows | A guard that raises while live testbeds exist, plus live row checks | Nullable columns with app only checks; a placeholder domain for old rows | Matches the owner's plan to delete them first, and makes "a live testbed has a domain and a group" a database fact. Rollback is a two line drop. |
| Domain pattern | Strict: letters, digits, inner hyphens, last label letters only, no trailing dot | Accept anything with a dot | The domain will build usernames and emails in feature 20, so a loose value would travel far. The pattern is shared with the database check. |
| Provisioning role | Unchanged in this spec | Remove `add_group` and `delete_group` now | A shared Authentik change the owner approves; the Playwright tests still use those rights. Listed as a follow up. |
| Slug | Kept, immutable, names nothing in Authentik | Drop it | Dropping needs a migration and touches audit history for no gain now. |

## Amendment 2026-10-26: pick the group, fill the domain

**Context.** Admins typed the group name exactly. The scope amendment (2026-10-26) asked for a dropdown of the groups that carry the `hol_testbed_group` marker. A live read that day showed Authentik lists groups filtered by that attribute with the token the app already holds (15 marked groups: NileWorkshop1 to 5, each as Admin, Contractor, and Employee), so no new permission is needed. The domain cannot be read from Authentik today: the marked groups carry only the marker, and the provisioning token is refused (403) on the SAML provider list.

| Decision | Chosen | Runner up | Why |
|---|---|---|---|
| Where the dropdown stops trusting | Convenience only; save runs the same lookup and marker check | Trust the posted choice | A list can be stale or forged, and the guard already sits at save. No new rule to keep in step. |
| What the select posts | The group name, as `groupName` | The group pk | The create path, the unique name rules, and the refusal messages all key on the name. Posting a pk would change `TestbedInput`, `createTestbed`, and every test for no gain. |
| Which groups are offered (owner, 2026-10-26) | Marked groups whose name ends in `Admin` | All marked groups (recommended) | The owner's call: a testbed uses the Admin group, so the other 10 are noise. The cost is a naming rule that only the list uses; the save still accepts any marked group. |
| Domain source | A string attribute `hol_testbed_domain` on the group, parsed with the existing `DomainInput` | Guess it from `NileWorkshopN`; read it from the SAML provider | A guess breaks the first time a name changes, and the token is refused on the provider list. An attribute is the owner's own data, read with a permission the app holds. |
| A bad or missing domain attribute | The group is still offered; Domain is typed | Hide the group; block with an error | Nothing should block on an owner step that is optional. The format check and the unique domain rule at save still catch a wrong value. |
| When the list is read | On dialog open, no cache | A 60 second cache | Matches `loadTestbedForEdit`. Always current, one call per open, no shared cache to invalidate. |
| Unreachable Authentik | Alert, select disabled, Save off | Fall back to free text | A free text field would bring back the typo path and a second form to test. The old path failed at save with the same cause. |
| Hiding used groups | Compare with live testbeds' group pks in the same call | Show all and refuse at save | Fewer dead choices; `testbeds_group_pk_uq` still decides. |
| Domain fill rule | Fill until the admin types; never overwrite typed text | Always overwrite on choice | Overwriting would lose a deliberate edit. |
| References | None | | Everything here comes from the repo and the live read recorded in the scope. |
