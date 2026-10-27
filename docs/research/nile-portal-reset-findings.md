# Nile Portal reset: findings and decisions

**Date**: 2026-10-27
**Feeds**: spec 0022 (feature 25, the Nile Portal Reset page) and the engine in feature 24 (reset when a lab ends)
**Companion file**: [db/seed/portal-reset-starting-list.json](../../db/seed/portal-reset-starting-list.json), the exact calls in run order

This note records what was learned by driving a real portal, and the decisions the owner made while doing it, so `/architect` can redesign the feature without this conversation. Everything marked **tested** was run against the live Workshop 4 tenant (`Nile Workshop 4`, tenant id `0be085a9-aa56-4af8-81bd-18677e67db63`, portal `https://u1.nile-global.cloud`). Nothing was tested on workshops 1, 2, 3, or 5 except where stated.

## Overview: the reset list in run order

| # | Step | What it does | Tested on Workshop 4 |
|---|---|---|---|
| 1 | Integrations | For each type (webhook, SIEM, email, DNS/Infoblox): list it, then DELETE each id on that type's own route. | Yes, all four groups |
| 2 | SSIDs | Delete every SSID except the protected one (`ssid.popTunnelUsed` true). | Yes |
| 3 | Guest Service Auth and Geo Control | Read the state. If OFF: PUT true, wait 10 s, PUT false. If ON: PUT false. | Yes, both branches |
| 4 | Wired Access Management and Wired SSO | If Wired SSO is enabled: delete entries except `ALL`, delete the SSO config, then delete `ALL`. If not: delete all entries. | Yes, both branches |
| 5 | Policies (Trust Engine) | Delete policies in Policy Sets, skipping system ones (`isDefault` true). | Yes |
| 6 | Service Profiles | Delete admin defined ones, skipping system ones. | No: delete call and system marker not found |
| 7 | Policy Groups | Delete user and device groups, then admin App groups. System App groups are refused by the portal (expected). | User group only |
| 8 | Segments | Delete all segments. | Yes |
| 9 | Authentication: admin RADIUS and Guest Portals | Delete every RADIUS server except Nile RADIUS (cloud flag) and every Guest Portal. | Yes, twice |
| 10 | Nile RADIUS policies | Delete policies except the Default Network Policy, and make sure that one is REJECT. | Yes, twice |
| 11 | Nile RADIUS certificates and PEAP | One call clears all certificates. PEAP config delete not found. | Certificates yes, twice; PEAP no |
| 12 | DHCP | Delete admin DHCP servers (not Nile DHCP), then remove every Nile DHCP scope with one PUT of the record with no subnets. | Yes, twice |
| 13 | Guest Portal branding | ALWAYS restore to default with `DELETE /api/v1/cloud-profile/value` (the engine cannot know whether a learner used it). Body not captured. | Call seen; body not captured |

Not found yet: the "more" the owner will send. The exact calls, bodies, and rules are in the companion JSON file; the decisions behind them are below (D1 to D11). Discovery, not hardcoded types: D16. Never touched: Global Settings, Identity and Network Setup, Users (D14). Cross cutting rules: D5 (shared password, a failed sign in stops the run and is audited and emailed), D8 and D9 (system defined items are silent; any other refusal is audited and emailed with the portal's message), D10 (an empty or missing step is a success and the run goes on).

## 1. How the portal API works

- **Everything is API driven.** The reset never needs the portal's pages. A browser (or the sign in steps without one, still open in feature 24) is used only to sign in and obtain the token.
- **Sign in** (tested, scripted with Playwright): open the portal URL, enter `admin@nileworkshop-N.com` in `#idp-discovery-username`, press `#idp-discovery-submit`, which redirects to Authentik; enter the same user in `input[name="uidField"]`, press Enter, wait for the password step (about 2.5 s of settling was needed), type the password, press Continue. The password was the same for Workshop 4 as for Workshop 1 (the file `~/secrets/nileportal.pw`). See D5: the owner decided all workshops share this one password.
- **Headers** on every portal API call: `x-id-token`, `x-nile-client`, `x-requested-with`. The portal page itself sends them; a script reads them off the page's own request to `/api/v1/settings/ssids` and reuses them. They are secrets: never print or store them.
- **Content type** for writes: `application/json`.
- **Paging:** the page asks for `?size=2000`. List calls in the seed file keep it. What the default page size is without it was not tested.
- **Tenant name format differs:** Workshop 1 is `Nile Workshop-1` (hyphen), Workshop 4 is `Nile Workshop 4` (space). A safety check that compares the tenant name to the testbed must accept both, or compare the tenant id or the admin's domain instead. The tenant id comes from `GET /api/v1/userinfo` (`tenantId`) and the name from `GET /api/tenants/{tenantId}`.

## 2. Step 2: SSIDs

**Calls (tested):** list `GET /api/v1/settings/ssids?size=2000` (records at `data.content[]`, each with `id`, `instanceName`, `ssid`, `referenceIds`, and more); delete `DELETE /api/v1/settings/ssids/{id}`, which answers 204 with an empty body.

### Decision D1: skip rule for the protected SSID

The portal has a system guest service SSID that cannot be deleted (the page shows it with no delete button). The reset must delete every other SSID and leave this one.

- **Rule chosen (owner confirmed, 2026-10-27):** skip the SSID whose `ssid.popTunnelUsed` is `true`.
- **Why not the name:** the name differs per workshop (Workshop 1 `Pod-1-Guest`, Workshop 4 `BITS-LAB Secure Guest`).
- **Why not `ssid.enableInternalGuest`:** it is `true` for the protected SSID and also for any captive portal SSID a user adds. Workshop 4 gained a second one, `Guest`, which has `enableInternalGuest: true`, `ssidOpmode: "Captive Portal"`, and `popTunnelUsed: false`.
- **Evidence:** a field by field diff of the five SSIDs on Workshop 4 showed `popTunnelUsed` as the only field that marked the protected one and not `Guest`. The protected one is also the one `GET /api/v1/guestpop` names in `ssidName`.
- **Rejected alternative:** read `ssidName` from `GET /api/v1/guestpop` and skip the SSID with that name. It works but costs an extra call and ties the rule to a second endpoint. The owner chose `popTunnelUsed`.
- **Result (tested):** with the rule, `Guest`, `IOT`, `PSK`, and `Cortp` each deleted with 204, `BITS-LAB Secure Guest` stayed, and a repeat list showed nothing deletable left. `Guest` was deleted first and the list re-read before the rest, as a check.
- **The protected SSID can never be deleted (owner, 2026-10-27). This is a rule, not an open question.** The reset must never send a delete for it, and it is not to be tested. The skip rule is therefore a hard guard in the engine, not an optional setting an admin can turn off or remove from the list.
- **Safety checks used in the test run, worth keeping in the engine:** stop if the tenant is wrong; stop unless exactly one SSID has `popTunnelUsed: true` (zero or two means the rule's assumption broke); check the list again at the end.

### Decision D2: order inside the SSID step, and relative to others

Any order inside the step (no SSID depends on another). Relative to other features: `Cortp` carries two `referenceIds` and the others one; these probably point at segments or RADIUS entries (not confirmed). Until confirmed, run SSIDs before segments and RADIUS, as the owner's requirement (the users of a thing go before the thing) says.

## 3. Step 3: Guest Service Auth and Geo Control

This is a feature switch at Global Settings, Advanced. The reset turns it ON and then OFF, which resets the guest portal SSID's settings to defaults. OFF is the default.

**Calls (tested):**
- Read: `GET /api/v1/guestpop/advance` returns a one item array `[{ id, tenantId, advanceSettingsEnabled }]`.
- Write: `PUT /api/v1/guestpop/advance/{id}` with body `{ "id": "<id>", "tenantId": "<tenantId>", "advanceSettingsEnabled": true | false }`. It answers 200 with the same record.

### Decision D3: toggle logic (owner confirmed, 2026-10-27)

Read the state, then branch, so the setting always ends OFF:

| State read | Action |
|---|---|
| OFF (`false`) | `PUT true`, wait 10 seconds, `PUT false` |
| ON (`true`) | `PUT false` only |

Then read again; it must be `false`. Both branches were run and both ended `false`. An earlier version always did true, wait, false even from ON; the owner corrected this, and the table above is the final logic. A `PUT true` while already ON is accepted and harmless, so the logic is a choice, not a workaround.

### Decision D4: use the API, not the page

The page's switch ignores a click while it is ON: no request is sent and no message shows (tried a force click, a click on the parent, and a real mouse click at the switch centre). Turning it ON by clicking works. So the OFF must be sent as the `PUT`. The owner accepted the API approach, since the engine is API driven anyway.

### Observed effects (tested)

- While ON, `GET /api/v1/guestpop` shows `dnsServerIPs` as `[]` and one extra entry in `advAuthServerDTOs` (a geo scoped portal config named `test`, tied to one site). After OFF the DNS servers are back (`8.8.8.8`, `8.8.4.4`) and `advAuthServerDTOs` is `[]`.
- Every PUT raises the guest SSID's `version` (a timestamp). A before and after comparison therefore always differs in `version`; compare the other fields.
- **Not known:** whether turning OFF deletes the `test` entry or only hides it. If the reset depends on that entry being cleared, the engine should read `advAuthServerDTOs` afterwards and expect it empty.
- **Not known:** whether this step changes anything the owner expects beyond the setting itself. The owner reported that the guest SSID did reset after the first cycle; the later API runs started from the already reset state and so could not show a reset.

### Decision D5: one shared password, and what a failed sign in does (owner, 2026-10-27)

- **All five workshops share the same portal password.** One password file, read from disk, covers `admin@nileworkshop-N.com` for every N. No per testbed override is needed. This closes the open question in `docs/scope/scope.md` feature 24 about whether the password differs per workshop.
- **If the sign in fails, the reset does not continue.** The engine must (1) write an audit row for the failed sign in, and (2) send an email to the abort address saved on the Nile Portal Reset page (feature 25). It deletes and changes nothing on the portal when it cannot sign in.
- **Never record the password, the token, or the headers** in the audit row, the email, a log, or an error. The audit row and email say that the sign in failed, for which testbed and workshop, and when. They do not include the password or the portal's raw reply.
- **Not decided here (for `/architect`):** whether a failed sign in is retried before it is reported, whether it counts as an abort or a separate "did not run" outcome in the email wording, and the audit action name (add it to `AuditAction` in `lib/audit-actions.ts`).

## 3b. Step 4: Wired Access Management and Wired SSO

Located at Network Setup, Access Management (tabs Wired, Wireless, Multicast IP, Wired SSO). Wired entries are called MABs in the portal's text and `client-configs` in its API.

**Calls (tested on Workshop 4):**
- Wired SSO state: `GET /api/v1/settings/sso-segment`. Enabled means it returns `ssoSegment.preTransactionSegment` and `ssoSegment.postTransactionSegment` (Workshop 4 had pre auth `guest` and post auth `PSK`). Disabled means a 200 with no `ssoSegment` and no `id`.
- Wired entries: `GET /api/v1/client-configs?size=2000`, items at `[].clientConfig` with `id`, `macAddress`, `rule`, and `ruleType` (`OUI`, `INDIVIDUAL`, `ALL`, and an Operating System rule were seen). The page itself lists with `POST /api/v1/client-config-paginated?pageNumber=0&pageSize=10`.
- Delete entries: `DELETE /api/v1/client-configs` with body `{"ids": ["<clientConfig.id>", ...]}`, answers 204, accepts several ids in one call. Ids look like `<tenantId>-00:11:33` or `<tenantId>-Operating System/Windows OS`: they hold spaces and slashes, so they go in the body, never in a URL path. The first delete was done through the page's own Delete button, the second through this API; both worked.
- Delete the SSO config: `DELETE /api/v1/settings/sso-segment`, no id, no body, answers 204. The page shows "Successfully deleted the Wired SSO". Afterwards the read returns the empty shell above.

### Decision D6: Wired SSO branch logic (owner, 2026-10-27)

The portal will not delete the `ALL` entry while Wired SSO is enabled. That is why it comes last in the enabled case.

| Wired SSO | Action, in this order |
|---|---|
| Enabled (pre auth and post auth segment present) | 1. Delete every Wired entry except the `ALL` entry. 2. Delete the Wired SSO config. 3. Delete the `ALL` entry (possible now that SSO is gone). |
| Not enabled | Delete every entry in the Wired table, `ALL` included, in one call. |

Both cases end with no approved Wired entry and no Wired SSO config. A deleted device can come back in and show as Waiting for Approval; the owner accepts that (2026-10-27), so a post check must not require an empty table (ignore or expect entries in a waiting state; the rule types seen are OUI, INDIVIDUAL, ALL, an Operating System rule, and FINGER_PRINT).

- An earlier version of this decision said to keep `ALL` when SSO is enabled. That was wrong: the owner corrected it, saying `ALL` cannot be deleted while SSO is enabled, so it must be deleted afterwards.
- The `ALL` entry is identified by `ruleType` `ALL` (its MAC column also reads `ALL`), not by position.
- The order matters: non ALL entries, then the SSO config, then `ALL`.
- The portal's confirm text warns that a deleted device onboards again if it matches an OUI rule or an `ALL` rule is configured, which is another reason `ALL` goes last.
- **Tested (Workshop 4):** the enabled branch (deleted `windows os`, `00:11:33`, `00:e0:4c:68:56:39`; deleted the SSO config; then deleted `ALL`, 204; run again with the owner's new rules `00:11:22` OUI, `ALL`, and `voip device` fingerprint, with the same order and all 204), and the not enabled branch (with SSO off, `ALL` deleted on its own in one call, 204). Not tested: a delete of `ALL` while SSO is still enabled (we rely on the owner's statement that the portal refuses it, so the engine must not try).
- **Ordering against segments:** the SSO config and each Wired entry point at a segment, so this step goes before the Segments step. The SSO config's `referenceIds` hold its two segment ids.

## 3c. Steps 5 to 8: policies, service profiles, policy groups, segments

Found while trying to delete Segments (owner instruction, 2026-10-27). The page refused to delete the segment `IOT-Seg` with "Policy Groups are using IOT-Seg" and sent no request. The owner then set the order (D7).

### Decision D7: order for the Trust Engine items and segments (owner, 2026-10-27)

1. Delete the policies inside Policy Sets. System defined policies cannot be deleted; the admin defined ones can.
2. Delete the Service Profiles that are admin defined, not system defined.
3. Delete User Groups and Device Groups.
4. Delete the App Groups that are admin defined, not system defined.
5. Then delete the Segments.

This runs after Integrations (1), SSIDs (2), the guest toggle (3), and Wired Access Management and Wired SSO (4).

**Calls found (Workshop 4):**
- Policies: list `GET /api/v3/policy/policysets` (`content[].policies[]`); delete `DELETE /api/v3/policy/policysets/{policySetId}/rules/{policyId}` with body `{id, policySetId}`, 204, effective at once (no DONE press). **Tested** on the admin policy `dfdsfds`.
- Policy groups: list `GET /api/v3/policy/groups?size=2000` (`content[]`, `groupType` is `User`, `Device`, or `App`); delete `DELETE /api/v3/policy/groups/{id}`, 204. **Tested** on the user group `sfsdf`. Device group and App group deletes were not tested (none existed to delete).
- Service profiles: list `GET /api/v3/policy/service-profiles`. The delete call was **not found**: all three profiles on Workshop 4 are system defined, so there was nothing to delete and the page's call was never seen.
- Segments: list `GET /api/v1/settings/segments?size=2000` (`data.content[]`); delete `DELETE /api/v1/settings/segments/{id}`, 204 (a trash icon in the segment's edit view, then "Are you sure you want to delete X?"). **Tested** on `IOT-Seg` once the `sfsdf` group was gone. The page sends the whole segment record as the body, but the API does not need it: `guest`, `Contractor`, `PSK`, and `Corp` were deleted through the API with the id in the path only, 204 each. A `DHCP_CLIENT` link did not block a delete.

**How system defined is marked:**

| Item | Marker | Confidence |
|---|---|---|
| Policy | `policyAttribute.isDefault` is `true` (8 of 9 on Workshop 4; `dfdsfds` was `false`). The page also draws them in gold with a dimmed checkbox. | Clear |
| Service profile | No flag. All three were created at tenant creation (2025-12-03); two have a description starting "Default Service Profile", and "Open Service Profile" does not. | Not found; needs an admin profile to compare |
| Policy group (App) | No flag on the record (descriptions start "Default App Group"), but the portal itself refuses: deleting any of the six answers `400 "Cannot delete, Group belongs to a Policy"`, because each belongs to one of the 8 system policies. Tested on all six (two through the page, which lists only Infra App Group and Intranet, four through the API); nothing was deleted. | Clear (tested) |
| Policy group (User, Device) | Delete all. | Owner rule |

**Decision D8 (owner asked to try, 2026-10-27):** deleting the system App groups was tried and the portal refused all six. The engine therefore treats a `400 "Cannot delete, Group belongs to a Policy"` on an App group as an expected skip, not an error: no retry, no second pass, no abort email, and (D9) no audit row. (The schema needs a way to mark an expected refusal for a step.)

**What blocks what:**
- A policy group that matches on a segment blocks deleting that segment ("Policy Groups are using X"). The `sfsdf` user group matched `Segment = IOT-Seg`.
- A service profile has a `policyCount`, so policies go before service profiles.
- Segments carry `linkedSettings` (`DHCP_CLIENT`, `RADIUS`, `PORTAL` entries per site). None of the links blocked a delete: segments linked to DHCP, RADIUS (Contractor, Corp), and a guest portal (guest) all deleted with 204 once no policy group used them. So DHCP, RADIUS, and portal entries do not have to go before segments. Whether the API alone refuses a segment a policy group still uses is not tested.

### Decision D9: what is audited and emailed, and what is not (owner, 2026-10-27)

- **System defined items are not audited and not emailed.** The owner does not want noise. This covers the protected SSID, system policies (`isDefault` true), system App groups and Service Profiles (the portal refuses them), and anything a step's logic says to keep (for example the `ALL` wired rule while Wired SSO is enabled). They are skipped, or their expected refusal is ignored: no audit row, no email line, no retry, no second pass, no counting toward an abort.
- **Every other refusal or error IS audited and emailed, with the portal's own message.** Example from this session: the segment `IOT-Seg` cannot be deleted because "Policy Groups are using IOT-Seg" (it was used in Trust Engine). The audit row and the email to the abort address record the step, the item name and id, the call (method and path), the HTTP status, and the message text as received.
- **Never in an audit row, an email, a log, or an error:** the password, `x-id-token` and the other auth headers, or any secret in the portal's reply (redact keys that look like secrets).
- **Conflict to settle in the spec:** the scope for feature 24 says "every delete (pass or fail) is an audit row kept about a month". D9 narrows that: a deleted item and an unexpected failure get a row; a system defined item that is skipped or expectedly refused gets none. `/architect` should rewrite that line of the scope so the two agree.
- **Catch:** the message "Policy Groups are using IOT-Seg" came from the portal's page, which checked before sending anything; the page sent no request. An engine that calls the API directly will not see that message, only whatever the API answers. Whether the API itself refuses to delete a segment that a policy group uses is **not tested** (the segment delete was never run). If the API accepts it, the order (policies and groups before segments) is the only protection, and the engine should check that no policy group still matches the segment before deleting it. Policy groups and policies did refuse at the API level (400 "Cannot delete, Group belongs to a Policy"), so those messages are available.

### Decision D10: nothing to delete is a success, for every step (owner, 2026-10-27)

A customer may never start a lab or do only part of it, so the reset must work on a tenant that is mostly or entirely empty. **For any step, if there is nothing to delete, the script continues.** This is a rule for every feature in the list, not only the Trust Engine.

- **Counts as "nothing to do" (success, no error, no retry, no audit row, no email, per D9):**
  - the list holds only system defined items (all skipped);
  - the list is empty because the learner never created that kind of thing;
  - a feature was only partly set up (Wired SSO never enabled, an SSID but no segment, a segment but no policy group, a set value already at its default such as the guest toggle already OFF);
  - an item is already gone when the delete is sent (a 404 or "not found" on delete): the wanted result is already true, so it counts as done.
- **The engine never hangs on an empty step.** It reads the list once, deletes what it may delete, and moves on. It never waits on, polls, or retries an empty step, and a missing item or feature never stops the run or holds up a later step.
- **Only a real error is a failure:** a 5xx, a timeout, or a refusal that is not a system defined one. That is audited and emailed (D9), the run still goes on to the next step, and the second pass retries what is left. A sign in failure is the one case that stops the whole run (D5).
- **Usual case:** on most tenants the system policies, groups, and profiles are all that remain and are all skipped, so those steps do nothing.
- **Order still holds when things do exist:** if policy groups exist, they go before Segments, because the page refused to delete a segment a group still used.
- **Not tested:** what each list or read call answers on a tenant where that feature was never set up or is switched off or not licensed (empty list, 403, or 404). Only features that were present on Workshop 4 were seen. The spec should say, per step, which answers count as "nothing to do"; the default should be that an empty list or a 404 does.

**Records of changes on Workshop 4:** deleted the admin policy `dfdsfds` and the user group `sfsdf` (owner approved). Tried to delete the six system App groups: all refused, none deleted. Deleted all five segments (`IOT-Seg` through the page after the group was gone; `guest`, `Contractor`, `PSK`, `Corp` through the API). The segment list is empty (owner approved).

## 3d. Steps 9 to 11: Authentication (admin RADIUS and Guest Portals, Nile RADIUS policies, certificates)

Located at Network Setup, Authentication. The page lists the admin defined RADIUS servers, the Guest Portals, and the system `NILE RADIUS` (Nile Hosted, Cloud RADIUS, geo scope All) in one table.

### Decision D11: order for Authentication (owner, 2026-10-27)

1. Delete all admin defined RADIUS servers and Guest Portals. `NILE RADIUS` stays.
2. For Nile RADIUS, delete all its policies first. The Default Network Policy cannot be deleted. Its default is REJECT: if it is set to ACCEPT, change it to REJECT.
3. Then look at the Nile RADIUS Authentication tab (EAP-TLS or EAP-PEAP) and delete all certificates and the PEAP configuration.

**Calls (Workshop 4):**
- Admin RADIUS: list `GET /api/v1/settings/radius?size=2000` (`data.content[]`); delete `DELETE /api/v1/settings/radius/{id}`, 204. **Tested** (MYRADIUS). The list also holds the Nile RADIUS record, which must be skipped: it is the one with a cloud RADIUS flag set (true for Nile RADIUS, false for the others). The exact property path was not pinned down.
- Guest Portals: list `GET /api/v1/portalconfig` (an array); delete `DELETE /api/v1/portalconfig/{id}`, 204. **Tested** (TEST). That portal's id is the `advAuthServerDTOs` entry that showed up in `GET /api/v1/guestpop` while Guest Service Auth and Geo Control was ON (section 3), so that entry was a real Guest Portal, not a view artefact.
- Nile RADIUS policies: list `GET /api/v1/cloudradius/policysets` (`[].policies[]`); delete `DELETE /api/v1/cloudradius/policysets/{setId}/policies/{policyId}`, 204. **Tested** (the admin policy "Policy 1"). The Default Network Policy has `isDefault` true, `authResult` REJECT, position 10000, expression `true`; it is skipped. To set it to REJECT: `PUT /api/v1/cloudradius/policysets/{setId}/policies/{policyId}` with the policy's own record and `authResult` changed to `REJECT` (200; **tested**, only `authResult` changed). It was found by trying the same route as the delete; the page's own call was not seen.
- Certificates: one call, `DELETE /api/v1/cloudradius/config/demo/keys`, answers 200 "Demo certificates deleted successfully". It removes **all** certificate material at once: the three demo client certificates (marketing, sales, hr), the server certificate and its private key, and the trusted CA. Afterwards `GET /api/v1/cloudradius/config` reads `usable: false` and `eapTLSConfig.complete: false`, `GET .../eaptlsconfig/keys` returns `serverCertMetadata: null` and `trustedCertMetadata: []`, and the demo keys list answers 404. **Tested.**
- PEAP: never configured on Workshop 4 (`eapPeapConfig.complete: false`), so its delete call was **not found**. It needs a tenant where PEAP was set up.
- **Side effect:** after the certificates go, opening Nile RADIUS on the page shows "Confirm RADIUS Authentication Change: Enabling Nile Cloud RADIUS will override your existing wired authentication with external RADIUS...". It is a page prompt and sends nothing until CONTINUE is pressed. The engine, calling the API, does not see it.
- Private keys and certificates in `GET /api/v1/cloudradius/config` are secrets: never log them, put them in an audit row, or put them in the email (D9).

**Second run (API only, owner created new test data):** deleted two new RADIUS servers (`my tadf`, `fdsfsdfasfds`), two new Guest Portals, two new Nile RADIUS policies, and cleared the certificates again (204, 204, 204, 200). The Default Network Policy had been set to ACCEPT, and the PUT above put it back to REJECT. The run first checked that exactly one RADIUS record had the cloud flag, and would have stopped otherwise.

**Records of changes on Workshop 4:** deleted the RADIUS server `MYRADIUS`, the Guest Portal `TEST`, the Nile RADIUS policy `Policy 1`, and all the Nile RADIUS certificates (owner approved). The Default Network Policy was REJECT on the first run; on the second it was ACCEPT and was set back to REJECT. After this, two new admin RADIUS servers (`my tadf`, `fdsfsdfasfds`) appeared that this session did not create.

## 3e. Step 12: DHCP

Located at Network Setup, DHCP. Like Authentication, the page lists the admin defined DHCP servers and the system `NILE DHCP` (Nile hosted, geo scope Any) in one table.

### Decision D12: DHCP order (owner, 2026-10-27)

1. Delete the admin defined DHCP servers. `NILE DHCP` stays.
2. In `NILE DHCP`, delete all the scopes (the subnets). The Nile DHCP record itself stays with no scopes.

**Calls (Workshop 4):**
- List: `GET /api/v1/settings/dhcp-clients?size=2000` (`data.content[]`). Each record has `dhcpClient` with `cloudDHCP` (true for Nile DHCP, false for an admin server), `groupName`, and `servers[]`; each server has an `address` and `subnets[]` (`prefix`, `router`, and for Nile DHCP also `pool` and `leases`). Nile DHCP is the record with `dhcpClient.cloudDHCP` true; it is skipped in the first substep.
- Admin server: `DELETE /api/v1/settings/dhcp-clients/{id}`, 204. **Tested** (EXTERNAL DHCP, 172.106.253.2, geo scope HOL).
- Nile DHCP scope: there is **no per scope route**. The page sends `PUT /api/v1/settings/dhcp-clients/{id}` (the DHCP record's id) once per scope, with the record minus that subnet, and answers 200. **Tested** on all four scopes (PSK-SSO-Scope 192.168.11.0/24, IOT-Scope 192.168.10.0/24, Employee 192.168.12.0/24, Contractor 192.168.13.0/24). The exact request body was not captured, and the record's `version` changes on every PUT, so the engine reads the record again before each PUT.
- **One at a time is a page limit, not an API limit:** the page lets only one scope be selected at once (owner, 2026-10-27), so it deletes them one by one. Through the API, **one `PUT` of the record with `dhcpClient.servers[0].subnets` set to `[]` removes every scope at once** (200, **tested** with two new scopes). If that PUT is ever refused, fall back to one PUT per scope, re-reading the record first.
- The earlier segment deletes worked while these DHCP entries still existed, so DHCP does not have to be deleted before segments.

**Second run (API only, owner created new test data):** deleted the new server `myDHCP` (204) and removed the two new Nile scopes (10.10.10.0/24, 10.10.11.0/24) in a single PUT with an empty subnets list (200). The run first checked that exactly one record had `cloudDHCP` true.

**Records of changes on Workshop 4:** deleted the DHCP servers `EXTERNAL DHCP` and `myDHCP` and the Nile DHCP scopes (six in all across two runs) (owner approved). `NILE DHCP` remains with no scopes.

## 3f. Step 1: Integrations

Located at Global Settings, Integrations. The page shows one card per integration, each with Edit, Delete (a trash icon that appears when the card is hovered), and Test.

### Decision D13: delete all Integrations (owner, 2026-10-27)

**Calls (Workshop 4):**
- List: `GET /api/v1/subscriptions/webhooks/config?size=2000` (`content[]`; `id`, `name`, `webhooksType`). Each record carries a `webHookUrl` and a `token`: both are **secrets** (a webhook URL works like a password) and never go in a log, an audit row, an email, or the seed file.
- Delete: `DELETE /api/v1/subscriptions/webhooks/config/{id}`, 204. **Tested** on `Webhook1` through the page ("Are you sure you want to delete this webhook?", then "Successfully deleted the webhook", then "No integrations found").
- The webhook's 7 alert subscriptions (`GET /api/v1/subscriptions/webhooks?size=2000`, linked by `webHooksId`) went with it: that list was empty afterwards, so there is no separate delete.
- Two other integration lists exist: email subscriptions (`GET /api/v1/subscriptions/email?size=2000`, always empty, so its delete is unverified) and SIEM (`GET /api/v1/siems?size=2000`, empty on the first run, one CrowdStrike SIEM on the second).
- **Third run (API only, 2026-10-27):** the owner created a LogicMonitor and a Sumo Logic SIEM; one loop deleted both with `DELETE /api/v1/siems/{id}` (204 each) and a final read of every integration list was empty. So the SIEM vendors share the one route (CrowdStrike, LogicMonitor, and Sumo Logic tested; Splunk, Snowflake, Generic HTTP not created, expected the same).
- **What the script can delete:** webhooks, every SIEM vendor in `/api/v1/siems` (four tested), email subscriptions, and DNS (Infoblox) servers, all tested. It may leave behind: Splunk, Snowflake, and Generic HTTP SIEMs (same route, untested) and any future type on another route. The script re-reads every list at the end and treats a leftover as a failure (audited and emailed, D9), so a gap shows up and is not silent.
- **SIEM:** `GET /api/v1/siems?size=2000` (`data.content[]`, `type` e.g. `crowdstrike`); delete `DELETE /api/v1/siems/{id}`, 204. **Tested** on a CrowdStrike SIEM through the page (it appeared on the second run). Treat the whole record as secret.
- **API calls the page makes on load (2026-10-27, unfiltered):** `GET /api/v1/siems?size=2000`, `GET /api/v1/subscriptions/webhooks/config?size=2000`, `GET /api/v1/subscriptions/webhooks?size=2000`, `GET /api/v1/subscriptions/email?size=2000`, `GET /api/v1/siem-topics`, and `GET /api/v1/dhcp/ddns/ddns-servers?page=0&size=500`. The rest it calls is shared page furniture.
- **One pattern, one route per type (owner asked, 2026-10-27):** every integration is deleted the same way (read its list, then `DELETE` on that type's own route with the id, no body, 204), but the **route differs per type**: webhooks under `/api/v1/subscriptions/webhooks/config/{id}`, SIEMs under `/api/v1/siems/{id}`. So the engine holds one list route and one delete route per type, and a new type is one more row, not a new step kind. The **email** subscription delete `DELETE /api/v1/subscriptions/email/{id}` is now **tested** (8 rows, 204 each, 2026-10-27): each row is one recipient for one alert type, so one recipient subscribed to several alerts has several rows. The address is personal data and never goes in an audit row or email.
- **Which types the portal offers** (Setup Integration dialog, read only): Alerts: Email, Webhooks. SIEM: LogicMonitor, Splunk, Snowflake, CrowdStrike, Sumo Logic, Generic HTTP, SIEM Events Pull. DNS: Infoblox. The page lists only three routes on load (webhooks, SIEMs, email), so the other SIEM vendors most likely share `/api/v1/siems` (not tested: only CrowdStrike was ever created), and **SIEM Events Pull** is confirmed in the same list (`type: "pull"`, deleted with a 204). **Infoblox** (DNS) is probably the `GET /api/v1/dhcp/ddns/ddns-servers?page=0&size=500` list that the page calls on load (an earlier note here said the page made no DNS call: that was wrong, an over broad filter had hidden it); that list is empty on Workshop 4, so its delete call is not known.
- **Infoblox (DNS) is tested (2026-10-27):** `DELETE /api/v1/dhcp/ddns/ddns-servers/{id}` answered 204 on a server the owner created, and the list was empty afterwards. It is not a card on the main page: it opens `Integrations / Infoblox / DNS servers`, a table backed by `GET /api/v1/dhcp/ddns/ddns-servers` (fields `id`, `name`, `type`, `server`, `enabled`, `geoScope`; the TSIG secret is a secret). Discovery finds it by the page's load call, not by card names. Creating one needs a site that uses Nile DHCP (the Geo Scope panel lists only those), so it cannot be created once the segments and DHCP scopes are gone; deleting needed nothing. Running DNS servers before the segments and DHCP steps is the cautious order (the delete itself worked with no segment present).
- **A type the engine does not list is left on the tenant and is not reported** (the engine cannot see it); it is not a failure. Close the gap by creating one of each remaining type on a scratch tenant and recording the page's list and delete calls.
- No system defined integration was seen, so nothing is skipped. No ordering dependency was seen.
- **Identity is never touched** (D14): Global Settings, Identity (`GET /api/v1/idps`) is a different page and is permanently out of the reset.

**Records of changes on Workshop 4:** deleted 8 email subscription rows, a SIEM Events Pull SIEM, and an Infoblox DNS server (all API, 204), and the SIEMs `logic-monitor` and `sumo-logic` (API) as well as a CrowdStrike one (page), and the webhook `Webhook1` (created by `wks4-admin@nileworkshop-4.com`, sending alerts to an automation host, subscribed to six alert types including `MY_NILE_TICKET`) and its subscriptions (owner approved). The URL is not recorded here.

### Decision D14: never touch Identity or Users (owner, 2026-10-27)

**Never go to Global Settings, Identity** (identity providers, `GET /api/v1/idps`), **and never go to Network Setup, Users.** Make it explicit. If either is deleted, the reset and the owner lock themselves out: the sign in to the portal goes through the identity provider, and the admin user the reset signs in as is one of the portal's users.

- These two are **not** "not found yet" or "to be decided": they are permanently out of the reset. No step may be added for them, now or later, and an admin may not add one from the Nile Portal Reset page.
- **Enforce it in the engine, not only in the list.** A deny list of prefixes, checked just before every portal call, independent of the saved list: `/api/v1/idps` and `/api/v1/users` (and the pages `/global-settings/identity` and `/network-setup/users`). Anything other than a plain read on those paths is refused. An attempt is a bug, not a skip: throw, write an audit row, and email the abort address. Spec 0022's save validation (AC-9) should also refuse a step whose list or delete path matches a prefix.
- This is **separate from the silent "system defined" skips** (D9): those are expected and quiet; this is a safety stop and is loud.
- The exact API paths for the Users page were not looked at (the page was never opened); the paths above are inferred and must be confirmed when the engine is built.
- Nothing on these two pages was opened or changed during this research. Some pages call `GET /api/v1/idps` on their own while loading; that is a read by the portal, not by this work.

## 3g. Step 13: Guest Portal branding

Located at Global Settings, Guest Portal. The page edits the guest portal's look: Theme Name, Primary Color, Secondary Color, Logo (png/jpg/jpeg, 5 MB), Background (Image or Color, with an upload), a preview with tabs for the four guest types (Click Through, Email Approval, Access Code, Self Registered), PREVIEW, CANCEL, SAVE, and a **Restore to default** link.

### Decision D15: restore the Guest Portal to default (owner, 2026-10-27)

- **Defaults seen on Workshop 4:** Theme Name `Default`, Primary Color `#0996EE`, Secondary Color `#F39A4E`, Background `Image`, no custom logo (the tenant name shows in its place).
- **Read call:** the page loads `GET /api/v1/cloud-profile/map/{tenantId}?profile_type=app_profile&scope_type=tenant`. On Workshop 4 it returned a profile whose `my_nile` variable had empty values, `last_update` 2023-12-09 and `updated_by` "none". Whether this record holds the branding was **not confirmed**: no branding values were in it, and no customised tenant was available to compare.
- **Restore call: `DELETE /api/v1/cloud-profile/value` (204), body not captured.** On the first try the tenant was at the defaults and nothing was sent; on the second the owner had changed the colors and the page's call went out and the profile returned to its pristine state. The link asks "Are you sure you want to restore your branding to default? Previous changes will not be saved!" with NO and YES. On Workshop 4, which already had the defaults, clicking YES sent **no request** and changed nothing (the SAVE button stayed disabled). The call can only be captured on a tenant whose branding was changed (a color, a logo, a background): change one, then restore it, and record the call.
- **Logic (owner, 2026-10-27): always restore.** The engine cannot know whether a learner used the Guest Portal, so it calls the restore every time, without reading first and without skipping when the branding looks default. A read afterwards is only a check. Whether the API call answers 204 on an already default tenant was not tested.
- No ordering dependency was seen.

**Records of changes on Workshop 4:** the restore ran twice with the owner's changed colors in place and put the branding back to default (204). A later attempt to change a color through the page did not enable SAVE, so nothing was changed.

## 3h. Discovery: no hardcoded types (owner, 2026-10-27)

### Decision D16: the engine discovers lists from the pages and does not hardcode types

The owner wants the script to understand the structure, so that a **new type added to the portal in future is found, listed, and deleted without a code change**. This applies to every reset page (Wireless, Wired, DHCP, Authentication, Segments, Integrations, and the rest). A prototype ran read only on Workshop 4; the full algorithm is in the `discovery` section of the companion JSON file. In short:

1. Load each page in a **fresh browser context** (the portal caches lists between pages), wait for the network to go idle, and record every response that parses as a list of records. Keep the first good parse of a path (the portal can fetch a list twice and the second response may be cut off).
2. Drop page furniture and lists shared across many pages; apply the **never touch deny list** (D14); confirm a candidate by finding its record names in the page's visible text.
3. Derive the delete route by convention, `DELETE <list path>/{id}`, and **verify by deleting and re-reading**: the API gives no `Allow` header (an `OPTIONS` probe answers 401 or 403), so a route cannot be pre checked. A 404 or 405 means the convention does not hold and is reported.
4. After the loop, re-read every list. A leftover is an unexpected failure (D9), so a gap is loud.

**What the prototype found (Workshop 4):**
- Wireless: `/api/v1/settings/ssids`. DHCP: `/api/v1/settings/dhcp-clients`. Authentication: `/api/v1/settings/radius` and `/api/v1/portalconfig`. Segments: `/api/v1/settings/segments`. Integrations: all six lists, including the DNS one a hand written list had missed (`/api/v1/dhcp/ddns/ddns-servers`).
- **`/api/v1/idps` showed up on the Wireless, Wired, and Authentication pages.** Discovery must apply the deny list or it would offer Identity for deletion.
- The delete by convention holds for ssids, segments, radius, dhcp-clients, portalconfig, siems, and webhooks config (all tested), and for policy groups.

**Where convention does not hold (these stay as data, not guesses):** the Wired page lists with a **POST** search (`/api/v1/client-config-paginated`), so a GET only discovery misses it, and deletes with a body of ids; the Wired SSO config has no id; DHCP scopes are removed by a PUT of the record; policies are nested under a policy set; certificates, the Guest Portal restore, and the guest toggle are single calls. **Risky to delete blindly:** `/api/v1/siem-topics` (it cascades from a SIEM) and `/api/v1/subscriptions/webhooks` (a child of `subscriptions/webhooks/config`); the Nile system records in the RADIUS and DHCP lists and the protected SSID share a list with admin records, so the skip rules in the steps must apply to discovered lists too. A list whose path extends another candidate's path is treated as a child and is not deleted directly.

**Decided (owner, 2026-10-27): delete and record.** A newly discovered type is deleted automatically, and the run **records** that it did: an audit row per deleted item and a "new route found" line in the email, holding the page, the route, the type and name of each item, the count, the status, and whether anything was left (never a URL, token, password, or the portal's raw reply), so the owner can add the route to the data file. The guards still win over this: the never touch deny list (a discovered Identity or Users route is never deleted and is a loud stop), the child list rule, the system defined skips, and the end of run re-read (a leftover is an unexpected failure, D9). A derived route that answers 404 or 405 is reported and not retried.

**Scripts:** the prototype lived in the session scratch folder and is not kept; section 7 and the algorithm above are enough to rebuild it.

## 4. What this means for the schema

The list in spec 0022 holds a feature name, a list path, a delete method (`DELETE` or `POST`), a delete path with one `{id}`, and a note. It cannot express:

| Need | Where it shows | Suggested direction |
|---|---|---|
| Skip an item by a field value | SSIDs (D1) | An optional rule on a delete each step: a field path in the item and a value to skip. |
| A call that sets a value, not a delete | Guest service (D3) | A second step kind, "set a value": a read call, a write call with a request body, and the values to send. |
| A branch on the state read | Guest service (D3) | A small, fixed rule set (for example, run the ON, wait, OFF sequence only when the read value is false) rather than free form logic. |
| A pause between calls | Guest service (10 s) | A wait in seconds on a step. It counts against the 25 minute budget. |
| A request body | Guest service | Body templates with named placeholders (the record id and tenant id from the read). |
| A response location for the list | SSIDs (`data.content`), guest (`[0]`) | A path to the items and a field for the id, per step. |
| A guard that cannot be removed | SSIDs (D1) | The protected SSID skip is part of the engine, not only a row an admin can edit; an admin must not be able to delete it from the page. |
| A branch on a state read, with different delete sets | Wired Access Management (D6) | A branch on the read result (enabled or not) that picks the delete set; "all except" (a ruleType) or "all". |
| A delete that takes a list of ids in the body | Wired entries | `DELETE` with a JSON body `{ids: [...]}`; ids can hold spaces and slashes. |
| A delete with no id | Wired SSO config | A step whose delete path has no `{id}` (a single record per tenant). |
| An expected refusal that is not an error | System App groups (D8, D9), system policies | A per step list of refusals to ignore (HTTP status plus message, for example 400 "Cannot delete, Group belongs to a Policy"), with no retry, no audit, no email. |
| An empty or missing result that is a success | Every step (D10) | The default for an empty list, a 404 on delete, or a feature that was never set up is "nothing to do"; only a real error fails. |
| One step made of several parts | Authentication (admin RADIUS and Guest Portals) | A step may hold more than one list and delete pair, run in order. |
| A parent id in the delete path | Policies (policy set id), Nile RADIUS policies (policy set id) | Two placeholders in a path, for example `{policySetId}` and `{id}`, filled from the list read. |
| A delete of a whole configuration in one call | Nile RADIUS certificates, Wired SSO config | A step kind that makes one call and then checks a read for the end state, not one delete per item. |
| A read that carries secrets | `GET /api/v1/cloudradius/config` (private key, certificates) | A rule that the engine never logs, audits, or emails a response body from such a read (D9). |
| A write that restores a value | Default Network Policy to REJECT (D11) | The set a value step kind, with the whole record as the body. |
| A delete done as an update of the parent record | Nile DHCP scopes (D12) | A step kind that edits a list inside a record (read the record, remove one item, PUT the record) and re-reads it before each PUT because of the `version` field. |
| A secret inside a listed record | Webhook integrations (URL and token) | Redaction of such fields in any audit row, email, or log (D9); the engine never copies a listed record's body. |
| A path the reset must never call | Identity (`/api/v1/idps`), Users (`/api/v1/users`) (D14) | A deny list in the engine, checked on every call, plus a refusal when a step is saved; an attempt throws, audits, and emails. |
| A step that is discovered, not written down | Every page (D16) | A discovery pass that proposes list routes and a convention for the delete route, with the exceptions, child lists, skips, and deny list held as data. |
| A list read done by POST | Wired entries (`client-config-paginated`) | A list call may be a POST search; discovery must not look at GET calls only. |
| An expected end state | Both | A post check the engine runs (one SSID left, the value is `false`), which also drives the second pass. |

Keep the AGENTS.md rule that a saved path stays under `/api/`, never a full URL, and keep the `{id}` placeholder idea. Whether the engine reads the `Content-Type` and headers from one place (the sign in) or per step is for `/architect`.

## 5. Still open

- **Guest Portal branding:** the restore call is `DELETE /api/v1/cloud-profile/value` (204), but its request body and query were not captured. Restore a customised tenant again with full request logging. The branding is stored in `GET /api/v1/cloud-profile/map/{tenantId}?profile_type=app_profile&scope_type=tenant` (`my_nile`).
- **Integrations:** only Splunk, Snowflake, and Generic HTTP SIEMs are untested (assumed to share `/api/v1/siems`).
- **Routes not found yet:** the rest of the owner's list ("more"). Use the same method: watch the page's own calls, then test on Workshop 4.
- **Service Profiles:** the delete call and the system marker are not found. All three profiles on Workshop 4 are system defaults, so an admin profile has to be created to capture the call and compare records (D7 section).
- **DHCP:** the PUT body is the record as read with the subnets emptied; whether the portal ever refuses that is not known (the per scope fallback is in the note).
- **PEAP:** the delete call for the PEAP configuration is not found; PEAP was never configured on Workshop 4.
- **Device groups:** the delete was not tested (none existed). App group delete is known to be refused for the six system groups.
- **Whether the API alone refuses a segment that a policy group uses:** not tested (the page checked first and sent nothing).
- **What list and read calls answer where a feature was never set up, switched off, or unlicensed** (empty list, 403, 404): only features that were present on Workshop 4 were seen (D10).
- **What the default page size is without `?size=2000`.**
- **Workshops 2, 3, and 5:** nothing was tested there (the password is decided to be shared, D5).
- **Whether a failed sign in is retried before it is reported**, the wording of that email, and the audit action name (D5).
- **The scope for feature 24** says every delete, pass or fail, is an audit row; D9 narrows that and the scope line needs rewriting.
- The existing open questions in `docs/scope/scope.md` feature 24 (dry run, overrun handling, where the engine runs, how it gets a token without a browser).

## 6. Record of what was changed on the portal while learning this

All on Workshop 4 only (`Nile Workshop 4`), 2026-10-27, each with the owner's approval. None of it can be undone from this side. Everything else was read only.

- **SSIDs:** deleted `Guest`, `IOT`, `PSK`, `Cortp`. `BITS-LAB Secure Guest` (protected) untouched.
- **Guest Service Auth and Geo Control:** cycled several times, always ending OFF (the default).
- **Wired:** deleted the entries `windows os`, `00:11:33`, `00:e0:4c:68:56:39`, then (after the owner's new rules) `00:11:22`, `voip device`, `windows os`, and `ALL`, across runs; deleted the Wired SSO config (pre auth `guest`, post auth `PSK`).
- **Trust Engine:** deleted the admin policy `dfdsfds` and the user group `sfsdf`. Tried to delete the six system App groups: all refused (400), none deleted.
- **Segments:** deleted `IOT-Seg`, `guest`, `Contractor`, `PSK`, `Corp`.
- **Authentication:** deleted the RADIUS servers `MYRADIUS`, `my tadf`, `fdsfsdfasfds`; the Guest Portals `TEST`, `fdsafsdafsdaf`, `sfsdfsdfsd`; the Nile RADIUS policies `Policy 1`, `fsdafsdfsaf`, `fsdfsdfsafds`; and cleared the Nile RADIUS certificates twice. Set the Default Network Policy from ACCEPT back to REJECT once.
- **DHCP:** deleted the servers `EXTERNAL DHCP` and `myDHCP` and six Nile DHCP scopes (192.168.10.0/24 to 192.168.13.0/24, then 10.10.10.0/24 and 10.10.11.0/24).
- **Integrations:** deleted the webhooks `Webhook1` and `sdfsdfasd` (with their alert subscriptions) and a CrowdStrike SIEM.
- **Left as is:** the six system App groups, the eight system policies, the three system Service Profiles, `NILE RADIUS`, `NILE DHCP` (no scopes), and the Default Network Policy (now REJECT). Nile Cloud RADIUS is not usable (its certificates are gone).

## 7. How this was found

The prototypes that drove the portal (sign in, list, delete, discover) are kept in [portal-scripts/](portal-scripts/), with a README that says what each one is, which step it covers, and how to run it safely. They read the shared password from `~/secrets/nileportal.pw`, take the three headers off the page's own request, and never print either. They are references for the engine, not production code. The sign in steps are also in section 1, and the calls are in the companion JSON file.
