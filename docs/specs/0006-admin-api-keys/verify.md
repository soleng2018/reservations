# Verify: Admin API Keys · spec 0006 · updated 2026-10-10
_Steps derived from spec 0006 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual
- [ ] Sign in as an admin, open `/admin/api-keys` → header "API Keys", the mock's subtitle, "Add API key"; columns Name, Type, Base URL, Key value, Actions → AC-1
- [ ] Add "Okta Prod" (IDP, `https://acme.okta.example/oauth2`, any key) → toast "Created Okta Prod.", row shows a blue IDP badge, mono base URL, `••••••••••••`, "Changed <today>" → AC-1, AC-2
- [ ] Add an AI key → violet AI badge → AC-1
- [ ] Look for reveal, show, or copy controls on the page and in both dialogs → none → AC-1
- [ ] Search "okta.example", then "AI", then nonsense → filters on name, type, base URL; nonsense shows "No API keys match your search." → AC-1
- [ ] Add with a blank name, `http://x`, and a blank key → three field errors, the dialog keeps every value → AC-3
- [ ] Add with base URL `https://u:p@x.example` → "Remove credentials from the URL."; `https://x.example/?key=1` → "Remove the query string from the URL." → AC-3
- [ ] Add "OKTA PROD" (another case of a live name) → "An API key with this name already exists." on Name → AC-3
- [ ] Paste a 4097 character key → "Use at most 4096 characters.", the key stays in the field uncut → AC-3
- [ ] Edit "Okta Prod": name, type, base URL filled in; Key value empty, placeholder "Leave blank to keep the current key", helper "Last changed <date>" → AC-4
- [ ] Change only the base URL, Save → "Updated Okta Prod.", the Changed date stays the same → AC-4
- [ ] Edit again, type a new key, Save → "Changed" moves to today (if it was older) → AC-4
- [ ] Save an edit without changing anything → "Updated Okta Prod.", no new audit row → AC-4
- [ ] In two tabs, delete a key in one, then save an edit in the other → "This API key no longer exists." → AC-4
- [ ] Delete an unused key → confirm dialog, "Deleted.", row gone; add a new key with the same name → allowed → AC-6
- [ ] With a testbed's `idp_api_key_id` set to a key (SQL until feature 9 adds the picker): delete it → the blocked dialog "API key in use" lists the testbed; change its type to AI → field error "Used as the IDP by: <name>. Remove it from them first." → AC-5, AC-6
- [ ] Sign in as a learner and open `/admin/api-keys` → the not authorized page → AC-10
- [ ] Start the dev server without `APP_ENCRYPTION_KEYS_FILE` → `/admin/api-keys` shows "Encryption isn't configured. Ask the owner to set up the keyring." and no Add button; Testbed Types still loads; the server log names the problem and no key → AC-9
- [ ] Open the page with the admin's timezone set to `Asia/Tokyo`, for a key changed late in the UTC day → "Changed" shows the Tokyo date, not the UTC date (value source: `formatDay(secretUpdatedAt, user.timezone)`) → AC-1
- [ ] In DevTools, filter the Network panel for the key you typed, and for `v1:` → no document, RSC payload, or Server Action response contains either → AC-8

## Commands
- [ ] `npx playwright test e2e/api-keys.spec.ts` → 2 passed (add, search, edit keep, edit replace, delete, canary scan; field errors) → AC-1, AC-2, AC-3, AC-4, AC-6, AC-8
- [ ] `npx vitest run server/crypto lib/catalog-input.test.ts server/env.test.ts` → round trip, tamper, binding, unknown key id, short tag and IV, rotation, keyring errors → AC-3, AC-7, AC-9
- [ ] `npx vitest run server/catalog/api-keys.test.ts app/admin/actions.test.ts tests/secret-column-scan.test.ts` → create, update, delete, blockers, the race, the compiled query, the cleaned up write error, auth, the source scan → AC-2 to AC-6, AC-8, AC-10
- [ ] `npx vitest run server/db/db-enums.test.ts server/db/schema.test.ts` → `api_keys.type` parity, RLS on `api_keys` → AC-11
- [ ] In psql: `\d hol_app.api_keys` and `\d hol_app.testbeds` → the constraints `api_keys_name_lower_uq`, `api_keys_type_check`, `api_keys_secret_ciphertext_check`, the FK `ON DELETE RESTRICT`, and `testbeds_idp_api_key_id_idx` → AC-11
- [ ] `select secret_ciphertext from hol_app.api_keys limit 1` → starts `v1:<keyId>:`, no plain text → AC-7
- [ ] `select action, metadata from hol_app.audit_events where target_type = 'api_key' order by created_at desc limit 10` → created, updated (changed fields only), secret_replaced (empty metadata), deleted; no secret or `v1:` anywhere → AC-2, AC-4, AC-6, AC-8
- [ ] `npm run secrets:keygen` → prints `{ "k<YYYYMMDD><4 hex>": "<base64>" }` and writes no file → AC-9
- [ ] Unset both encryption vars, `npm run build` → succeeds → AC-9

## Acceptance-criteria coverage
- AC-1: UI steps 1 to 5 and the timezone step, Playwright · AC-2: add step, audit query · AC-3: validation steps, input tests · AC-4: edit steps, domain tests · AC-5: blocked type change step, domain test · AC-6: delete steps, domain race test · AC-7: crypto tests, ciphertext query · AC-8: Network step, Playwright canary scan, query and source scans · AC-9: not configured step, env tests, keygen, build · AC-10: learner step, action auth tests · AC-11: psql and parity checks
