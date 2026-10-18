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

**Google** (optional; booking emails and the shared calendar; you can add only one). Without it, bookings still work, and their emails wait in the queue until a key exists.

The `GOOGLE` key has two sign in methods. Use **Google sign in** to test with a personal Gmail account, and **Service account** for production on Google Workspace. Both need the same three fields in the dialog:

- **Calendar ID** (required): the ID of the "HOL bookings" calendar, where the app adds, moves, and removes an event for every booking. Use a calendar made just for this, not your main one. To create it and get its ID:
  1. Open [Google Calendar](https://calendar.google.com) as the account that sends the emails (the Gmail account for Google sign in, the HOL mailbox for Service account).
  2. In the left sidebar, next to **Other calendars**, click **+** → **Create new calendar**. Name it "HOL bookings", pick your time zone, and click **Create calendar**.
  3. Open its settings: hover over "HOL bookings" under *My calendars*, click the three dots → **Settings and sharing** (or go straight there after creating it).
  4. Optional: under **Share with specific people or groups**, add the admins with *See all event details*, so they can see the bookings.
  5. Scroll down to **Integrate calendar** and copy the **Calendar ID**. It looks like `abc123…@group.calendar.google.com`. Paste that into the Calendar ID field.

  If you change the Calendar ID later with Google sign in, you need to sign in with Google again.
- **Dev inbox** (optional): a mailbox you own. Emails for test and `dev-` learners go here instead of to the learner. Leave it blank and those emails are not sent.
- **Ops BCC** (optional): gets a copy of every email sent to a real learner.

#### Google sign in (personal Gmail, for testing)

Do this once in [Google Cloud](https://console.cloud.google.com), signed in as the Gmail account that will send the emails:

1. Create a project (or pick one), then under *APIs & Services* enable the **Gmail API** and the **Google Calendar API**.
2. Open **Google Auth Platform** ([console.cloud.google.com/auth](https://console.cloud.google.com/auth/overview), or in the menu: *APIs & Services* → *OAuth consent screen*). Its sidebar has Branding, Audience, Data access, and Clients. Do them in this order, because Clients refuses to create one until Branding and Audience are set:
   - **Branding**: enter an app name and a support email.
   - **Audience**: choose External, then click **Publish app** so it shows *In production*. If you leave it in Testing, the sign in stops working after 7 days.
   - **Data access**: add the scopes `gmail.send`, `calendar.events`, `openid`, and `email`.
3. **Clients** ([console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)) → *Create client* → Application type **Desktop app** → create, then **download the JSON**. The file starts with `{"installed":`. A *Web application* client will not work.
4. In that Gmail account's Google Calendar, create a calendar named "HOL bookings", share it (read only) with the admins, and copy its Calendar ID.

Then add the key in the app. From clicking **Sign in with Google** (step 4) to **Save**, you have 10 minutes:

1. **Add API key** → Type `GOOGLE` → Sign in method **Google sign in (personal Gmail, for testing)**.
2. **OAuth client file**: click *Choose File* and pick the Desktop app JSON you downloaded in the Google Cloud setup. The field must show the file name before you go on. If you switch the method or the Type, the field clears and you choose the file again.
3. Fill in Calendar ID, and Dev inbox and Ops BCC if you want them.
4. Click **Sign in with Google**. An **Open Google sign in** link and a **Google sign in address** field appear.
   1. Click **Open Google sign in**, then sign in as the Gmail account.
   2. Google warns that the app isn't verified: click *Advanced*, then *Go to … (unsafe)*. It's your own app, so this is expected.
   3. Leave **both** permissions ticked (send email, and Calendar events), then continue.
   4. Google opens a page at `http://127.0.0.1:47613/?state=…&code=…` that won't load. That's expected. Copy the whole address from the address bar and paste it into **Google sign in address**.
   5. Click **Save**. Leave the client file chosen, because Save reads it again.

The list then shows the key with "Google sign in" and the Gmail address as the sender. If Save says to sign in again, click **Sign in with Google** again and repeat from step 4. Each Google address works only once.

#### Service account (Google Workspace, for production)

1. In a Google Cloud project, enable the **Gmail API** and the **Google Calendar API**. Create a service account, then on its **Keys** tab click *Add key* → *Create new key* → **JSON**. The browser downloads the key once, and Google keeps no copy. Note the service account's client ID. If key creation is blocked, an org admin must allow it for this project (`iam.disableServiceAccountKeyCreation`).
2. In the Google Admin console (a super admin does this): *Security* → *API controls* → **Domain wide delegation** → add that client ID with exactly these scopes: `https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.events`.
3. In the HOL mailbox's Google Calendar (it must be a real Workspace user), create the "HOL bookings" calendar, share it read only with the admins, and copy its Calendar ID.
4. **Add API key** → Type `GOOGLE` → **Service account (Workspace)**. Upload the key file, enter the HOL mailbox as **Sender mailbox**, and fill in Calendar ID, Dev inbox, and Ops BCC. Save, then delete the downloaded key file.
5. Make sure the mailbox's domain has SPF and DKIM set up (turn on Workspace's default DKIM).

To move from Google sign in to production later, edit the key, choose **Service account**, and upload the key file with the Workspace sender. Then remove the app's access in the Gmail account (*Google Account* → *Security* → *Third party apps and services*).

#### After either method

- The worker (step 9) does the sending, so emails go out only while it runs. Book as a `dev-` learner and the email should reach your dev inbox within about a minute.
- To copy bookings made before the key existed onto the calendar, run `npm run calendar:backfill` (a dry run that prints a count), then `npm run calendar:backfill -- --apply`.
- If Google stops accepting the key (for example, someone removed the app's access), API Keys shows a **Needs attention** badge on it. Edit the key and sign in again, or upload a new key file.

The exact error messages are in [spec 0013](docs/specs/0013-email-delivery-booking-confirmations/index.md).

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
| `Choose the OAuth client file.` after Sign in with Google | No client file was chosen. Pick the Desktop app JSON first; the field must show its name (step 8, Google sign in) |
| `This is a Web application client…` or `This isn't a Google OAuth client file` | Create a **Desktop app** client in Google Cloud and download its JSON (step 8) |
| `This sign in expired or belongs to another attempt.` | More than 10 minutes passed, or the client file changed since you clicked Sign in with Google. Click it again |
| `Allow both sending email and Calendar events…` | A permission was unticked on Google's screen. Sign in with Google again and leave both ticked |
| `Sign in with Google first, then paste the address.` | Save was pressed before the Google address was pasted. Click Sign in with Google, finish on Google, and paste the address |
| `Google didn't accept this sign in (it may have been used already).` | That address was already used by an earlier Save. Click Sign in with Google again for a new one |
| `Couldn't reach Google to check the key. Try again.` | Google was briefly unreachable. Press Save again; your sign in is kept |
| Booking emails never arrive | The worker isn't running (step 9), no `GOOGLE` key exists, or a test learner has no Dev inbox set. The learner's page in the console lists each email's status |
| API Keys page says not configured | `APP_ENCRYPTION_KEYS_FILE` is unreadable, or `APP_ENCRYPTION_ACTIVE_KEY_ID` isn't in the keyring |
| `npm run dev` fails at start on a `DATABASE_*` or auth variable | A required value is missing or a `*_FILE` path is wrong; the error names the variable |
