# Nile HOL Reservations

The booking site for Nile hands-on labs (HOL). Learners book a testbed slot, get a confirmation email with a calendar invite, and open their lab VM through Cloudflare Access while the booking is live. Admins run the catalog, the users, and the API keys from a console.

Built with Next.js 16 (App Router), React 19, Kysely on InsForge's Postgres, Better Auth against Authentik, and a separate background worker. The full stack decisions are in [spec 0001](docs/specs/0001-stack-architecture/index.md), and the working rules for contributors are in [AGENTS.md](AGENTS.md).

## Getting the webapp running

Read this before you start: **dev and production share one database.** Migrations, data you create in dev, and a worker you start on your machine all affect production. Work through the steps in order.

### 1. What you need

| Need | Why |
| --- | --- |
| Node 24 or newer, and npm | `package.json` requires Node 24 or newer |
| Shell access to the InsForge host (`~/insforge`, container `insforge-postgres`) | The app's tables live in InsForge's Postgres |
| An Authentik admin account and its master token | One time setup of the sign in app; the app never uses the master token itself |
| A Cloudflare account with Zero Trust (team domain `<team>.cloudflareaccess.com`) | Turnstile on public forms, and lab VM access |
| Optional: a Google account for the HOL mailbox and calendar | Booking emails and the shared "HOL bookings" calendar |

Keep secrets in `~/secrets/`, one value per file, with mode `600`. The app reads each secret from the file that a `*_FILE` variable points to:

```bash
mkdir -p ~/secrets && chmod 700 ~/secrets
umask 077   # new files in this shell are created readable by you only
```

### 2. Install

```bash
git clone git@github.com:soleng2018/reservations.git
cd reservations
npm install
cp .env.example .env.local
```

`.env.local` is read by `npm run dev`, `db:migrate`, `db:codegen`, `worker`, and Vitest. Never commit it.

### 3. Database (one time per InsForge install)

Skip this step if the `hol_app` role already exists (it does on the shared InsForge host). Ask the owner for the password file.

```bash
# A password with no single quote in it
openssl rand -hex 24 > ~/secrets/hol_app_password

# Create the hol_app role and the hol_app / hol_auth schemas, as postgres
{ printf "\\set pw '%s'\n" "$(cat ~/secrets/hol_app_password)"; cat db/bootstrap.sql; } |
  docker exec -i insforge-postgres psql -U postgres -d insforge -v ON_ERROR_STOP=1

# The bootstrap hides our schemas from InsForge's REST layer; that applies after a restart
docker restart insforge-postgrest
```

In `.env.local`, set `DATABASE_PASSWORD_FILE=/home/<you>/secrets/hol_app_password`. The `DATABASE_*` defaults in `.env.example` match the InsForge host.

Then apply the migrations:

```bash
npm run db:migrate
```

Running it again is safe, because migrations already applied are skipped. The shared database is probably up to date already.

### 4. App secrets

**Session secret** (at least 32 characters, shared by dev and prod):

```bash
openssl rand -base64 48 > ~/secrets/auth_secret
```

If production already has one, copy that file instead, because a new secret signs everyone out.

**Encryption keyring** (encrypts the API key secrets stored in the database):

```bash
npm run --silent secrets:keygen > ~/secrets/hol_encryption_keys.json
```

The JSON goes to the file, and the `APP_ENCRYPTION_ACTIVE_KEY_ID=...` line is printed to your terminal; copy it into `.env.local`. Back the file up.

> If a keyring already exists (dev and prod share one), **copy it, don't generate a new one.** Secrets saved under a key id that's missing from the file can't be decrypted. To rotate a key, merge the new entry into the existing JSON and never remove an old id.

Without the keyring the app still runs, but the API Keys page shows "not configured" and the worker can't decrypt the Cloudflare key.

### 5. Authentik

`npm run authentik:setup` creates the `hol` sign in app, the `hol-labs` app for lab VMs, the `hol-admins` group, and the `hol-webapp-provisioning` account. It never changes Authentik objects that already exist. Run it without `--apply` first for a dry run that writes nothing:

```bash
AUTHENTIK_URL=https://<your authentik> \
AUTHENTIK_MASTER_TOKEN_FILE=~/secrets/authentik_master_token \
APP_URLS=https://<prod host>,http://10.1.255.18:3000 \
CLOUDFLARE_TEAM_DOMAIN=<team>.cloudflareaccess.com \
npm run authentik:setup
```

When the plan looks right, run it again with `-- --apply --secret-out ~/secrets/authentik_client_secret --labs-secret-out ~/secrets/hol_labs_client_secret`. The script then:

- prints `AUTHENTIK_CLIENT_ID=...`, which you copy into `.env.local`;
- writes the client secret to the file you named, which `AUTHENTIK_CLIENT_SECRET_FILE` points to;
- prints the HOL Labs client id, which goes into Cloudflare's "Reservations HOL Labs" login method;
- prints the steps for the provisioning token. Create that token in Authentik (Directory → Tokens and App passwords, user `hol-webapp-provisioning`, intent API, one year expiry), save it to `~/secrets/authentik_provisioning_token`, and point `AUTHENTIK_PROVISIONING_TOKEN_FILE` at it.

Add every admin to the `hol-admins` group and turn on MFA for them. Anyone signed in who isn't in that group is a learner.

### 6. Fill in `.env.local`

| Variable | Value |
| --- | --- |
| `APP_URL` | The exact URL your browser uses. For dev, that's `http://10.1.255.18:3000`, not localhost (see Troubleshooting) |
| `ADMIN_ENTRY_PATH` | The admin sign in path, a single segment such as `/l0gin`. It's never linked from public pages |
| `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET_FILE`, `AUTHENTIK_PROVISIONING_TOKEN_FILE` | From step 5 |
| `AUTH_SECRET_FILE` | `/home/<you>/secrets/auth_secret` |
| `APP_ENCRYPTION_KEYS_FILE`, `APP_ENCRYPTION_ACTIVE_KEY_ID` | From step 4 |
| `DATABASE_PASSWORD_FILE` | From step 3 |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Keep the Cloudflare test keys from `.env.example` for dev; use the real widget keys in production |
| `TRUST_PROXY_HEADERS` | `false` in dev. `true` only behind the Cloudflare Tunnel |
| `WORKER_ENABLED` | `false`, unless this machine runs the one worker (step 9) |

Use absolute paths in every `*_FILE` variable. `~` isn't expanded inside `.env.local`.

### 7. Start it

```bash
npm run dev
```

Open `http://10.1.255.18:3000` for the public site, and `http://10.1.255.18:3000/l0gin` (your `ADMIN_ENTRY_PATH`) to sign in as an admin. `npm run dev` never runs migrations or the worker.

If your machine has a different LAN IP, use it in `APP_URL` and add it to `allowedDevOrigins` in [next.config.ts](next.config.ts). Otherwise the page loads but buttons do nothing, because Next blocks its dev scripts for hosts that aren't on that list.

### 8. Add the API keys in the admin console

Go to **Admin → API Keys → Add API key**.

**Cloudflare** (lets the worker cut a learner's lab VM access when their booking ends; you can add only one):

- Type: `CLOUDFLARE`
- Base URL: `https://api.cloudflare.com/client/v4/accounts/<account id>`. Use the 32 character account ID shown in the address bar of the Cloudflare dashboard (`dash.cloudflare.com/<account id>/...`). It must be lowercase, with no trailing slash and nothing after the ID.
- Key value: a Cloudflare API token with **Account → Access: Organizations, Identity Providers, and Groups → Edit** on that account.

Cloudflare checks the token when you save it. "Cloudflare didn't accept this token for this account." means a wrong token, missing permission, or wrong account ID.

**Google** (optional; booking emails and the shared calendar):

- Type: `GOOGLE`, then pick a sign in method:
  - **Service account (Workspace)**: upload the service account key `.json`, enter the sender mailbox, and allow domain wide delegation for the key's client ID.
  - **Google sign in (personal Gmail, for testing)**: upload a *Desktop app* OAuth client `.json`, click Sign in with Google, approve, and paste back the address Google sends you to.
- Also enter the Calendar ID of the "HOL bookings" calendar, a dev inbox, and an Ops BCC address.

Details and the exact error messages are in [spec 0013](docs/specs/0013-email-delivery-booking-confirmations/index.md). To copy bookings made before the key existed onto the calendar, run `npm run calendar:backfill` (a dry run), then `npm run calendar:backfill -- --apply`.

### 9. The background worker

The worker sends email, syncs the calendar, sweeps expired holds, and revokes lab access. It exits unless `WORKER_ENABLED=true`.

```bash
WORKER_ENABLED=true npm run worker
```

**Because the database is shared, a worker started on your machine is the production worker.** Only one may run at a time, so start it only after checking that no other worker is running. See [server/worker/AGENTS.md](server/worker/AGENTS.md).

### 10. Check your setup

```bash
npm run lint && npm run typecheck
npm test            # DB tests run inside a rolled back transaction, so nothing is written
npm run test:e2e    # Playwright against the dev server; needs ~/secrets/hol-test-*.pw
```

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| The page loads but clicks do nothing | Your host isn't in `allowedDevOrigins` in `next.config.ts` (step 7) |
| Sign in fails with `state_mismatch` | `APP_URL` doesn't match the URL in your browser. Make them identical |
| A 403 from the Authentik proxy during sign in | The browser is on `localhost`. The proxy refuses requests that mention localhost, so use the LAN IP |
| `Enter https://api.cloudflare.com/client/v4/accounts/<account id>.` | The Cloudflare base URL isn't in exactly that shape (step 8) |
| API Keys page says not configured | `APP_ENCRYPTION_KEYS_FILE` is unreadable, or `APP_ENCRYPTION_ACTIVE_KEY_ID` isn't in the keyring |
| `npm run dev` fails at start on a `DATABASE_*` or auth variable | A required value is missing or a `*_FILE` path is wrong; the error names the variable |
