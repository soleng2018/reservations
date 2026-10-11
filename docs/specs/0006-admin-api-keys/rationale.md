# 0006. Admin API Keys: rationale

Decision record for [index.md](index.md). Read by people and by `/architect` on update or supersede, not during a build.

## Context

> ⚠️ Premise note: nothing in the app uses these credentials, and the owner expects they may never be needed (scope, Deferred). Storing a real Okta or AI token that no code reads gives you all of the risk of holding a secret and none of the benefit. The product owner decided to build the screen as in the mock, so this spec builds it, but the safest framing is "a place to record credentials once a consumer exists": until then, admins should keep real production secrets out of it. Encryption makes this tolerable, not free.

The admin console needs the mock's API Keys section: IDP and AI credentials with a name, a type, a base URL, and a secret. The owner fixed the hard rule up front: a secret is entered once, encrypted at rest, and can never be viewed, revealed, or copied again from the app, not even by admins. Changing it means typing a replacement. Spec 0001 already chose how secrets are protected at rest (app level AES-256-GCM, a versioned ciphertext format, and a keyring for rotation), and spec 0002 fixed the table shape, but no code exists for either yet.

Forces that shaped the choice:
- **One host, one data set.** Dev and production share the same Postgres and the same keyring (spec 0001). Whatever protects a secret must work identically in both, and a database dump or a careless query in dev reaches production rows.
- **The browser is the leak path.** In a Next.js App Router app, anything a server component passes as props is serialized into the RSC payload, and anything a Server Action returns goes back to the client. A write only secret has to be kept out of every query that feeds a page, not just hidden in the UI.
- **Testbeds will point at IDP keys** (feature 9). The key side has to guard against deletion and a type change while a testbed uses it, or a testbed ends up with a missing or wrong kind of IDP.
- **Tracer Bullet delivery and the Full tier.** The slice must prove one real thread (add a key, see it masked) through every layer first, and the tier asks for proof, not just code, that the secret never leaves the server.

## Options considered

### Option 1: Row bound AES-GCM through the app keyring

Encrypt in the app with the spec 0001 keyring and bind each ciphertext to `api_keys.secret_ciphertext:<row id>` as additional authenticated data (extra input the cipher checks but does not hide).

**Pros**:
- A ciphertext copied into another row or column fails to decrypt, closing a quiet swap attack.
- The key never reaches Postgres or its logs; the database only ever sees ciphertext.

**Cons**:
- The row id has to be generated in the app before the insert.
- More code than plain encryption, and the binding string becomes a contract (renaming the column means encrypting again).

### Option 2: Plain AES-GCM through the app keyring, no binding

The same keyring and format, without additional authenticated data.

**Pros**:
- The simplest code; the DB can generate ids.

**Cons**:
- Anyone with write access to the table can move a valid ciphertext to another row and it still decrypts under that row's name.

### Option 3: Encrypt in Postgres with pgcrypto

Call `pgp_sym_encrypt` in SQL, passing the key with each query.

**Pros**:
- No crypto code in the app; one SQL function does the work.

**Cons**:
- The key travels in every query, so it can appear in `pg_stat_statements`, slow query logs, and error output on a shared InsForge instance.
- It contradicts spec 0001 and has no keyring rotation story.

### Option 4: Do not store secrets until a consumer exists

Build the list without a secret field, or postpone the feature until a lab integration needs a key.

**Pros**:
- No stored secret means no secret to leak.

**Cons**:
- Goes against the owner's decision to build the screen as in the mock now.
- The encryption module would still be needed soon for the Gmail token.

## Rationale

Option 1 follows spec 0001, which settles the cipher and the keyring, and adds the one cheap control that matters on a shared, single data set: binding each ciphertext to its row so a copied value is useless. Option 3 fails the shared host force outright, because the key would leak into database logs that both dev and production write to. Option 2 is a fair, simpler choice, but the only cost of binding is generating the uuid in the app, which Kysely handles in one line. Option 4 is the safest posture and is reflected in the premise note and a Follow-up, but it overrides an owner decision.

The rest of the design follows from the browser leak force: explicit column lists, a mask constant that never derives from the secret, a client that keeps the typed secret after a failed save so the server never echoes it, and a Playwright canary scan, because only an end to end check catches a leak through props or action state. The keyring is validated lazily, like every other getter in `server/env.ts`, rather than at startup. The engineer first picked fail fast at start. The cross check then showed the app has no startup hook today, a new `instrumentation.ts` would add an unverified `next build` risk, and a missing keyring would take down learner booking for a feature nothing uses. So the API Keys page checks it on load and shows admins a clear not configured state, and saves fail closed (refuse to write rather than store anything unprotected). Rotation is deferred because nothing decrypts these values yet. The keyring already lets old values decrypt after a new key becomes active, so adding a key is safe today.
