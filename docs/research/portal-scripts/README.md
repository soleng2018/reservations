# Nile Portal reset prototypes

Working prototypes from the research in [nile-portal-reset-findings.md](../nile-portal-reset-findings.md). They drive a real Nile Portal (sign in through Authentik, then the portal's own API) and show the calls and the logic that were **tested on Workshop 4**. The exact calls, bodies, and rules are in [db/seed/portal-reset-starting-list.json](../../../db/seed/portal-reset-starting-list.json).

They are references for `/architect` and `/develop`, not production code. The engine is rebuilt in TypeScript under `server/` to the rules in `AGENTS.md` (Zod at every boundary, `Result`, no `process.env` outside `server/env.ts`, no secrets in logs).

## Safety

- **Most of these delete things on a live tenant, and the deletes cannot be undone.** Run them only against a scratch workshop tenant, never a tenant with a lab in progress.
- Several carry a guard for Workshop 4 (tenant id `0be085a9-aa56-4af8-81bd-18677e67db63`). They stop on any other tenant. Change the guard on purpose when you point one elsewhere.
- They never touch Identity (`/api/v1/idps`) or Network Setup, Users (`/api/v1/users`): see the never touch rule (D14).
- The password comes from `~/secrets/nileportal.pw`. The scripts print only whether the `x-id-token` header was captured, never its value. Do not add logging of the password, the token, webhook URLs, SIEM credentials, TSIG secrets, or certificates.

## Running

From the repo root, with `npm install` done and a workshop number as the argument (default 4):

```bash
node docs/research/portal-scripts/00-discover-pages.mjs 4     # read only
```

Screenshots and other output land in the current directory, so run from a scratch folder. They import `playwright` from the repo's `node_modules`. A scratch Chromium is launched headless.

## The scripts

| File | Step | What it does | Style |
|---|---|---|---|
| `00-login-and-read.mjs` | 0 | Sign in, capture the three headers, list SSIDs and the guest portal config. Read only. | API after sign in |
| `00-discover-pages.mjs` | discovery (D16) | Fresh context per page; lists every response that is a list of records, flags the never touch routes. Read only. | Prototype of the discovery pass |
| `01-integrations.mjs` | 1 | Webhooks, SIEMs (all vendors), email, DNS: list, `DELETE <list>/{id}`, re-read, report leftovers. | API |
| `02-ssids.mjs` | 2 | Delete every SSID except the protected one (`popTunnelUsed`), with checks. | API |
| `03-guest-geo-control.mjs` | 3 | Read the state; OFF: PUT true, wait 10 s, PUT false; ON: PUT false. | API |
| `04-wired.mjs` | 4 | Wired SSO enabled or not: entries, SSO config, then `ALL`. | API |
| `05-policies-ui-capture.mjs` | 5 | Deletes the admin policy through the page to capture the call. | UI capture |
| `07-policy-group-ui-capture.mjs` | 7 | Deletes the admin user group through the page to capture the call. | UI capture |
| `07-app-groups-refusal-test.mjs` | 7 | Tries to delete the system App groups; the portal refuses (400). | API |
| `08-segments.mjs` | 8 | Deletes every segment by id, no body. | API |
| `09-11-authentication.mjs` | 9 to 11 | Admin RADIUS and Guest Portals, Nile RADIUS policies, then all certificates. Stops unless exactly one record has the cloud flag. | API |
| `10-nile-radius-default-reject.mjs` | 10 | Sets the Default Network Policy to REJECT with a PUT of the record. | API |
| `12-dhcp.mjs` | 12 | Admin DHCP servers, then one PUT that empties the Nile DHCP scopes. | API |
| `13-guest-portal-restore-ui-capture.mjs` | 13 | Clicks Restore to default through the page. The call is `DELETE /api/v1/cloud-profile/value`; its body was not captured. | UI capture |

Missing on purpose: scripts for the Trust Engine policies, groups, service profiles and the Nile RADIUS policy deletes through the API were not written (the calls were captured through the page); the delete calls for Service Profiles and PEAP were never seen.

## Lessons baked in

- The portal caches lists between pages in one session. Use a **fresh browser context per page** when discovering.
- The page can fetch the same list twice and the second response may be cut off: keep the **first successful parse**.
- The API sends no `Allow` header (`OPTIONS` answers 401 or 403), so a route can only be confirmed by a real delete and a re-read.
- Selecting several rows is not always possible in the page (DHCP scopes allow one at a time); the API has no such limit.
