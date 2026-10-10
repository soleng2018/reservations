# 0006. Admin API Keys

**Date**: 2026-10-10
**Status**: In Progress

## Summary

Admins get the API Keys screen from the mock: list, search, add, edit, and delete IDP and AI credentials (name, type, base URL, secret). A secret is typed once, encrypted before it reaches the database, and never sent back to the browser again; the list shows a fixed mask and the date the secret last changed, and there is no reveal or copy anywhere. This slice also builds the app's encryption module (AES-256-GCM, the standard authenticated cipher, with a keyring of rotatable keys from spec 0001), because nothing has needed it until now. Nothing in the app uses these keys yet; they are stored and edited only.

## Requirements

**User stories**:
- As an admin, I want to record the IDP and AI credentials our testbeds may use, so that they live in one place instead of in chat messages and notes.
- As an admin, I want a stored secret to be impossible to read back, even by me, so that a stolen admin session or a screenshot cannot leak it.
- As an admin, I want to replace a secret without retyping the rest of the key, and to see when it last changed, so that rotating a credential is quick and I can spot stale ones.
- As the owner, I want a key that a testbed uses to be protected from deletion and from a type change, so that a testbed never points at a missing key or at an AI key as its IDP.

**Acceptance criteria**:
- **AC-1**: `/admin/api-keys` shows the shell header from spec 0005 (title "API Keys", the mock's subtitle, and an "Add API key" action) and a searchable table of live keys in `lower(name)` order with columns Name, Type (the existing `Badge` variant `info` for `IDP` and `accent` for `AI`, matching the mock's blue and violet), Base URL (mono), Key value, and Actions (edit, delete). The Key value cell shows the fixed mask `••••••••••••` and under it "Changed <date>", where the page computes `formatDay(secretUpdatedAt, user.timezone)` on the server (`user` from `requireAdmin()`) and passes the finished string, never a `Date`, to client components. There is no reveal, copy, or show control anywhere on the page or in the dialogs. Search filters on name, type, and base URL (the `DataTable` client filter). Empty states read `No API keys yet — add one to get started.` and, with a search, `No API keys match your search.` (mock copy).
- **AC-2**: "Add API key" opens the form dialog (title "Add API Key") with Name, Type (select, `IDP` by default), Base URL, and Key value (a password input, `autocomplete="new-password"`, placeholder "Secret key or token"). A valid save inserts the row with the secret encrypted (AC-7), `secret_updated_at = now()` (DB clock), shows "Created <name>.", closes the dialog, and writes the audit row `api_key.created` (metadata: `type`, `baseUrl`) in the same transaction.
- **AC-3**: Input rules, parsed on the server with Zod and returned as field errors by dotted path through `fieldErrors`: name trimmed, 1 to 200 characters (`CatalogName`); a key that is not deleted with the same name ignoring case shows "An API key with this name already exists." on `name` (through `api_keys_name_lower_uq`); type is `ApiKeyType` (`IDP` | `AI`, else "Choose a type."); base URL is the exported `HttpsUrl` (trimmed, `https:` only, "Enter an https:// URL.") capped at 2048 characters ("Use at most 2048 characters."), and refused when it carries a username or password ("Remove credentials from the URL.") or a query string ("Remove the query string from the URL."), so no secret can hide in a field that is displayed and audited; key value trimmed, then 1 to 4096 characters ("Enter the key." when empty on add, "Use at most 4096 characters." when too long). Schemas: a shared base object plus `ApiKeyCreateInput` (key required) and `ApiKeyUpdateInput` (key may be blank) in `lib/catalog-input.ts`. After a failed save the dialog keeps every typed value, including the key, on the client; the server response never contains it.
- **AC-4**: Edit (title "Edit API Key") opens with name, type, and base URL filled in (read once on open with `useState`, the Testbed Types pattern) and an empty Key value field with placeholder "Leave blank to keep the current key" and helper text "Last changed <date>". Saving with the key blank leaves `secret_ciphertext` and `secret_updated_at` unchanged. Saving with a key typed stores a fresh ciphertext (new IV) and sets `secret_updated_at = now()`. Audit, in the same transaction: `api_key.updated` with `{ field: { from, to } }` for each of name, type, base URL that changed (written only when one changed), and `api_key.secret_replaced` (no metadata) when a key was typed. The update returns early only when no field changed **and** no key was typed; otherwise one `UPDATE` sets the changed columns plus, when a key was typed, the new ciphertext and `secret_updated_at = now()`. A save that changes nothing writes no row and no audit and still shows "Updated <name>.". Two concurrent saves are serialized by a row lock and the last one wins. Saving an edit to a key that was deleted meanwhile writes nothing and shows "This API key no longer exists."
- **AC-5**: Changing a key's type from `IDP` to `AI` while any testbed that is not deleted has it as `idp_api_key_id` is refused with a field error on `type`: "Used as the IDP by: <names>. Remove it from them first." (names in `lower(name)` order). The check runs inside the update transaction after the key row is locked `FOR UPDATE`, using the same query as the delete blockers.
- **AC-6**: Delete follows the spec 0005 flow. The check lists testbeds that are not deleted whose `idp_api_key_id` is this key; if any, the blocked dialog shows `BLOCKED_COPY.api_key` ("<name>" is assigned to the testbeds below. Remove it from them first.) with that list. Otherwise the confirm dialog's remove runs, in one transaction, `lockForDelete("api_keys", id)`, `apiKeyBlockers`, then sets `deleted_at = now()` and writes `api_key.deleted`. A blocker that appears between check and remove returns the blocked result. A soft deleted key's name can be reused.
- **AC-7**: Every stored secret is `v1:<keyId>:<iv>:<tag>:<ciphertext>` (AES-256-GCM, a random 12 byte IV, a 16 byte tag, each part base64url), encrypted under `APP_ENCRYPTION_ACTIVE_KEY_ID`, with additional authenticated data `api_keys.secret_ciphertext:<row id>`. The row id is generated in the app (`crypto.randomUUID()`) before the insert so it is known at encrypt time. `decryptSecret` round trips any value `encryptSecret` produced; it throws for a changed byte, a different row id or column, an unknown key id, or a malformed value. It requires the decoded IV to be exactly 12 bytes and the tag exactly 16 bytes and passes `authTagLength: 16` (Node otherwise accepts a shortened GCM tag), and every keyring key is exactly 32 bytes. The DB `CHECK (secret_ciphertext like 'v1:%')` rejects plain text.
- **AC-8**: Neither the plaintext secret nor its ciphertext ever leaves the server or reaches a log: no page query selects `secret_ciphertext`, and no props, RSC payload (the serialized data React sends for server components), Server Action result, console line, error message, or audit metadata contains either.
- **AC-9**: `encryptionEnv()` in `server/env.ts` validates the keyring lazily on first use, like every other env getter (no startup hook; `next build` never touches it). It reads the file through the existing `secret("APP_ENCRYPTION_KEYS")` helper (so a plain `APP_ENCRYPTION_KEYS` env var also works, as for the other secrets) plus `APP_ENCRYPTION_ACTIVE_KEY_ID`, and throws naming the problem (missing, not a JSON object, a key id not matching `^[A-Za-z0-9_]{1,32}$`, a key that does not decode to exactly 32 bytes, or an active id missing from the keyring) without printing any key. `/admin/api-keys` calls `assertEncryptionEnv()` on load; when it fails, the page shows the header and an error state "Encryption isn't configured. Ask the owner to set up the keyring." instead of the table, and the create and update actions return "Encryption isn't configured." without writing. The rest of the app runs normally. `npm run secrets:keygen` prints a new key id (`k<YYYYMMDD><4 random hex>`) and a random 32 byte key in the keyring's JSON shape and writes nothing.
- **AC-10**: The page and every API key Server Action call `requireAdmin()` first; a learner gets the existing "not authorized" refusal and nothing is written. Row actions take the id bound by the page (`action.bind(null, id)`) and check it with `z.uuid()`. None of these actions is on the public allow list.
- **AC-11**: Migration `0005_api_keys.sql` creates `api_keys` exactly as spec 0002 defines it (with RLS on, the `set_updated_at` trigger, and `api_keys_name_lower_uq`) and adds `testbeds.idp_api_key_id` (nullable, FK `ON DELETE RESTRICT`, indexed). `server/db/types.ts` is regenerated, and `ApiKeyType` is registered in `checkLists` so the parity test covers `api_keys_type_check`.

## Decision

**Chosen option**: Option 1: Row bound AES-GCM through the app keyring

API key secrets are encrypted in the app with the spec 0001 keyring, each ciphertext bound to its table, column, and row id, and the API Keys screen is built on the Testbed Types patterns with no path that returns a secret to the browser.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch** (the spec 0002 target, confirmed unchanged):

| Table | Column | Type | Null | Rule |
|---|---|---|---|---|
| api_keys | id | uuid | no | PK, `default gen_random_uuid()` (the app always supplies it, AC-7) |
| | name | text | no | `api_keys_name_lower_uq` on `lower(name)` where `deleted_at is null` |
| | type | text | no | `api_keys_type_check`: `IDP` \| `AI` |
| | base_url | text | no | https checked in Zod |
| | secret_ciphertext | text | no | `api_keys_secret_ciphertext_check`: `like 'v1:%'` |
| | secret_updated_at | timestamptz | no | `default now()`; changed only on replace |
| | deleted_at | timestamptz | yes | soft delete |
| | created_at, updated_at | timestamptz | no | `set_updated_at()` trigger |
| testbeds | idp_api_key_id | uuid | yes | FK `api_keys(id) ON DELETE RESTRICT`; index `testbeds_idp_api_key_id_idx` |

Relationship: `api_keys` 1 to N `testbeds`, optional. RLS enabled on `api_keys` like every table (spec 0002).

**State transitions**: an API key is live, then soft deleted (terminal). The secret has no states; replacing it overwrites the ciphertext and bumps `secret_updated_at`.

**API surface** (Server Actions in `app/admin/actions.ts`, domain logic in `server/catalog/api-keys.ts`):

| Action | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/api-keys` | page | none | rows: `id, name, type, baseUrl, secretUpdatedAt` | admin | not authorized |
| `createApiKeyAction` | Server Action | `FormData`: name, type, baseUrl, secret (req) | `{ kind: "saved", message }` | admin | field errors, `duplicate_name`, not configured |
| `updateApiKeyAction` | Server Action, `bind(null, id)` | id (uuid), name, type, baseUrl, secret (blank keeps) | `{ kind: "saved", message }` | admin | field errors, `duplicate_name`, `type_in_use` (names, mapped to `fields.type`), `not_found`, not configured |
| `checkApiKeyDelete` | Server Action, `bind(null, id)` | id | `Result<readonly Blocker[], "unavailable">` | admin | `unavailable`; a bad id returns `[]` |
| `deleteApiKeyAction` | Server Action, `bind(null, id)` | id | `Result<void, DeleteRemoveError>` | admin | `blocked` (list), `failed` ("This API key no longer exists.") |

Domain functions in `server/catalog/api-keys.ts`, each returning a typed `Result`, with the keyring passed in (the action passes `encryptionEnv().keyring`; tests build one in memory, so DB tests need no keyring file and CI is unaffected):
- `listApiKeys(conn)`: explicit columns `id, name, type, base_url, secret_updated_at`; `type` parsed with `ApiKeyType.parse`.
- `createApiKey(conn, keyring, input: ApiKeyCreateInput, actorId)`: `Result<{ id }, "duplicate_name">`.
- `updateApiKey(conn, keyring, id, input: ApiKeyUpdateInput, actorId)`: `Result<void, ApiKeyUpdateError>` where `ApiKeyUpdateError = "duplicate_name" | "not_found" | { readonly kind: "type_in_use"; readonly names: readonly string[] }`; the action's exhaustive `switch` maps `type_in_use` to the AC-5 field error.
- `deleteApiKey(conn, id, actorId)`: the Testbed Types delete shape (`blocked` with blockers, or `not_found`).

Audit rows use `targetType: "api_key"` and the summaries "API key created", "API key updated", "API key secret replaced", "API key deleted". Crypto: `encryptSecret(keyring, plaintext, aad)` and `decryptSecret(keyring, value, aad)` in `server/crypto/secrets.ts`, pure apart from the random IV, taking the keyring as an argument; `secretAad("api_keys", "secret_ciphertext", id)` builds the binding string. `decryptSecret` has no production caller yet; it exists for the round trip tests and the future Gmail token (spec 0001).

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| List | name, type, base URL | `api_keys` columns, `deleted_at is null` |
| List | Key value mask | Constant `SECRET_MASK = "••••••••••••"` in `lib/` (never derived from the secret) |
| List, edit hint | "Changed <date>" / "Last changed <date>" | `formatDay(api_keys.secret_updated_at, user.timezone)` computed by the page on the server, `user` from `requireAdmin()` (spec 0002 value sourcing); passed to client components as a string |
| Page load | configured or not | `assertEncryptionEnv()` |
| Create | row id | `crypto.randomUUID()` in `createApiKey`, before encrypt |
| Create, replace | `secret_ciphertext` | `encryptSecret(keyring, input.secret, secretAad("api_keys", "secret_ciphertext", id))`, `keyring` passed in by the action from `encryptionEnv()` |
| Create, replace | key id inside the ciphertext | `APP_ENCRYPTION_ACTIVE_KEY_ID` |
| Create, replace | `secret_updated_at` | SQL `now()` |
| Edit | keep or replace | `input.secret` after trim: empty means keep |
| Edit | `api_key.updated` metadata | `changedFields(["name", "type", "baseUrl"], before, after)`, generalized from the Testbed Types helper into `lib/` (Testbed Types switches to it, its tests kept); `before` from the `FOR UPDATE` read |
| Edit (type change), delete | blocking testbed names | `apiKeyBlockers(trx, id)`: testbeds with `deleted_at is null` and `idp_api_key_id = id`, `lower(name)` order |
| Any action | actor | `requireAdmin()` session user id |
| Toasts | "Created <name>." / "Updated <name>." | the parsed input name |

**Key invariants**:
- No page or action query selects `secret_ciphertext` except the encrypt write itself; `listApiKeys` and the edit read select an explicit column list.
- `secret_updated_at` changes if and only if a new secret is stored.
- Secrets never appear in audit metadata, logs, thrown error messages, or action results. Zod issues for the `secret` field are mapped to fixed messages and never logged with their input; crypto errors carry no plaintext. `createApiKey` and `updateApiKey` catch any database error that `mapConstraintError` does not map and rethrow a fixed message `Error` ("api key write failed"), because a Postgres error `detail` can contain the failing row, ciphertext included.
- The identifier `secret_ciphertext` appears in app code only in `server/catalog/api-keys.ts` (the writes); a source scan test enforces it.
- Target invariant, fully enforced only once feature 9 lands: a testbed's `idp_api_key_id`, when set, names a live `IDP` key. This feature enforces the key side (AC-5, AC-6); feature 9's assign path must lock the key `FOR SHARE` and recheck `type = 'IDP' and deleted_at is null` (Follow-up).
- Dev and production share one database, so they must share one keyring (spec 0001); a key removed from the keyring makes every value encrypted under it unreadable.

**Security model**: admins only (`requireAdmin()` on the page and every action, AC-10); learners and anonymous callers see nothing. The secret is write only for everyone, admins included: it is accepted once over the Server Action POST, encrypted in memory, and stored as ciphertext. The keyring file lives outside the repo (`~/secrets/`, mode 600) and is read only by the web process; the worker does not load it yet. Every mutation is audited in the same transaction (`api_key.created`, `api_key.updated`, `api_key.secret_replaced`, `api_key.deleted`). No compliance scope applies; these are internal service credentials.

**Configuration required**:
- `APP_ENCRYPTION_KEYS_FILE`: path to the JSON keyring, `{ "<keyId>": "<base64 32 bytes>" }` (spec 0001 named it; read by `encryptionEnv()` through `secret()`)
- `APP_ENCRYPTION_ACTIVE_KEY_ID`: the keyring entry that encrypts new values
- Owner setup: run `npm run secrets:keygen`, save the output to `~/secrets/hol_encryption_keys.json` with mode 600, set both vars in `.env.local` and the production env, and back the file up somewhere safe. Losing it means every stored secret must be entered again. Until this is done the app runs, and only the API Keys page shows "Encryption isn't configured" (AC-9).

**Critical test scenarios**:
- Happy path: add a key, see it masked with today's changed date, edit its base URL with the key blank (ciphertext and date unchanged), replace the key (date changes), delete it. Verifies **AC-1**, **AC-2**, **AC-4**, **AC-6**
- Leak proof: Playwright saves a unique canary secret, then scans the list page HTML, the RSC payload, and every Server Action response for the canary and for `v1:`, and finds neither; a unit test compiles `listApiKeys`'s query (`.compile().sql`) and asserts it has no `secret_ciphertext`; a source scan finds that identifier only in `server/catalog/api-keys.ts`; a forced unmapped DB error surfaces only the fixed message. Verifies **AC-8**
- Crypto: round trip; one flipped byte in the decoded IV, tag, or ciphertext throws (flip decoded bytes, since a changed last base64url character can decode to the same bytes); a truncated tag or an 11 byte IV throws; another row id as the binding throws; an unknown key id throws; a value encrypted under an older key still decrypts after the active id moves to a new key. Verifies **AC-7**
- Base URL: `https://user:tok@host` and `https://host/?key=x` are refused with their messages. Verifies **AC-3**
- Failure case: delete and IDP to AI type change are both refused while a live testbed references the key (DB test inside `inRollback`, testbed linked directly), and a blocker added between check and remove is still caught. Verifies **AC-5**, **AC-6**
- Validation: duplicate name ignoring case, an `http://` URL, an empty key on add, a 4097 character key; the typed values stay in the dialog. Verifies **AC-3**
- Config: missing file, bad JSON, a 31 byte key, and an unknown active id each fail with their message and no key printed; with the keyring missing, the API Keys page shows the not configured state, saves write nothing, and other pages still load; `npm run build` succeeds without the vars; keygen output parses as a valid keyring. Verifies **AC-9**
- Auth/permission: a learner calling each action gets "not authorized" and nothing is written; the allow list test still passes. Verifies **AC-10**

## Build plan

1. Encryption core: `server/crypto/secrets.ts` (`encryptSecret`, `decryptSecret`, `secretAad`, with the IV, tag, and key length checks), the keyring schema, `encryptionEnv()` and `assertEncryptionEnv()` in `server/env.ts` (lazy, reading the file through `secret()`), `scripts/secrets-keygen.ts` behind `npm run secrets:keygen`, both vars in `.env.example`, and unit tests, satisfies **AC-7**, **AC-9**
2. Tracer thread, add and list: migration `0005_api_keys.sql`, `db:codegen`, `ApiKeyType` in `lib/db-enums.ts` plus `checkLists`, `HttpsUrl` exported with the 2048 cap and the credential and query checks, `ApiKeyCreateInput` and `ApiKeyUpdateInput`, the four audit actions in `lib/audit-actions.ts`, `listApiKeys` and `createApiKey` (keyring passed in, unmapped DB errors sanitized), `createApiKeyAction`, `components/admin/api-key-fields.tsx`, and the page replacing the `ComingSoon` placeholder with the table, the Add dialog, and the not configured state, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-7**, **AC-9**, **AC-10**, **AC-11**
3. Edit: generalize `changedFields` into `lib/` (Testbed Types moves to it), `updateApiKey` (lock, the early return rule, keep or replace, the two audit rows, the type change check through `apiKeyBlockers`, `ApiKeyUpdateError`), `updateApiKeyAction` with its widened exhaustive switch, and the edit dialog with the last changed hint, satisfies **AC-3**, **AC-4**, **AC-5**
4. Delete: `apiKeyBlockers` in `server/db/delete-blockers.ts`, `lockForDelete`'s table union widened to `"testbeds" | "testbed_types" | "api_keys"`, `deleteApiKey`, `checkApiKeyDelete` and `deleteApiKeyAction`, wired to the existing delete flow with `BLOCKED_COPY.api_key`, satisfies **AC-6**
5. Proof: the compiled query test, the source scan, the Vitest action and auth tests, and the Playwright spec `e2e/api-keys.spec.ts` (add, search, edit keep, edit replace, delete, and the canary scan), satisfies **AC-1**, **AC-4**, **AC-6**, **AC-8**, **AC-10**

## Consequences

**Positive**:
- The encryption module and keyring exist and are tested, ready for the Gmail refresh token (spec 0001) with no new design.
- A stolen database dump or a copied row yields nothing usable without the keyring file, and a ciphertext moved to another row fails to decrypt.
- The page reuses the Testbed Types patterns, so there is no new UI or action shape to learn.

**Negative / tradeoffs**:
- The app stores credentials that nothing uses yet; each one is a liability with no current benefit (see the premise note in rationale.md).
- The keyring file becomes a critical backup: lose it and every secret must be entered again. Dev and prod share it, so a dev mistake with the file affects prod.
- Rotation is half built: a new key encrypts new values and old values still decrypt, but nothing encrypts old rows again under the new key yet.
- The table loads every live key at once with no pagination, which is fine for a handful of keys and would need paging past a few hundred.
- The blocked delete and type change paths cannot be clicked through in the UI until feature 9 adds the IDP picker; DB tests cover them meanwhile.
- A missing or broken keyring is noticed only when someone opens the API Keys page, not at deploy time.

**Neutral**:
- `testbeds.idp_api_key_id` lands now but stays null until feature 9.
- `changedFields` moves to `lib/` and becomes shared by Testbed Types and API Keys.

## Follow-up

- [ ] Owner: generate the keyring with `npm run secrets:keygen`, store it at `~/secrets/hol_encryption_keys.json` (mode 600), set both env vars for dev and prod, and back the file up. Never remove a key id from the shared file while any row still uses it.
- [ ] Feature 9 (Admin: Testbeds): the IDP select lists live `IDP` keys only; the save locks the chosen key `FOR SHARE` and rechecks `type = 'IDP' and deleted_at is null` so it cannot race AC-5 or AC-6.
- [ ] A `secrets:rotate` script that encrypts every stored secret again under the active key in one transaction, once something decrypts these values.
- [ ] Ask the owner not to enter real production credentials until a feature actually uses them (see the premise note).
