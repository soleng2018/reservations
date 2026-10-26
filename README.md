# Nile HOL Reservations

The booking site for Nile hands-on labs (HOL). Learners book a testbed slot, get a confirmation email with a calendar invite, and open their lab VM through Cloudflare Access while the booking is live. Admins run the catalog, the users, and the API keys from a console.

Built with Next.js 16 (App Router), React 19, Kysely on its own Postgres container, Better Auth against Authentik, and a separate background worker. The full stack decisions are in [spec 0001](docs/specs/0001-stack-architecture/index.md), and the working rules for contributors are in [AGENTS.md](AGENTS.md).

## Getting the webapp running

Read this before you start: **everything here is dev, and Authentik is shared.** A worker you start on your machine changes real Authentik group membership, and test users you create there are real.

Do the steps in order, in one terminal, from the repo root. Every command is in a code block, and every numbered item is something you do. A fresh install is steps 1 to 6, then you start the app (step 7 for the dev server, or the [Docker](#running-with-docker) section for the containers), then steps 8 to 10.

Placeholders in `<angle brackets>` are values only you know. Write them as plain text, without the brackets.

### 1. What you need

| Need | Why |
| --- | --- |
| Node 24 or newer, and npm | `package.json` requires Node 24 or newer |
| Docker with Compose v2 | The app's Postgres runs as the `db` container from `docker/compose.yaml` |
| An Authentik admin account and its master token | One time setup of the sign in apps; the app never uses the master token itself |
| A Cloudflare account with Zero Trust (team domain `<team>.cloudflareaccess.com`) | Turnstile on public forms, and lab VM access |
| Optional: a Google account for the HOL mailbox and calendar | Booking emails and the shared "HOL bookings" calendar |
| Docker, Traefik, and a Cloudflare Tunnel on the host (only to run the containers) | See [Running with Docker](#running-with-docker) |

1. Make the secrets folder. Keep every secret in `~/secrets/`, one value per file, with mode `600`. The app reads each secret from the file that a `*_FILE` variable points to. Run this in the terminal you will use for all the steps, because `umask` applies only to that shell:

   ```bash
   mkdir -p ~/secrets && chmod 700 ~/secrets
   umask 077
   ```

2. Save your Authentik master token (the admin account's API token, from **Directory → Tokens and App passwords**). Skip this if `~/secrets/authentik_master_token` already exists and holds a working token. The command asks for the token at a hidden prompt, so it needs a real terminal:

   ```bash
   read -rs TOKEN && printf '%s' "$TOKEN" > ~/secrets/authentik_master_token && unset TOKEN
   ```

### 2. Install

1. Clone and install (skip the clone if you already have the repo):

   ```bash
   git clone git@github.com:soleng2018/reservations.git
   cd reservations
   npm install
   ```

2. Make your env file (skip it if `.env.local` already exists):

   ```bash
   cp .env.example .env.local
   ```

`.env.local` is read by `npm run dev`, `db:migrate`, `db:codegen`, `worker`, and Vitest. Never commit it. You fill it in at step 6.

### 3. Database

The database is a pinned Postgres container (`db` in `docker/compose.yaml`), so a fresh clone needs no manual setup.

1. Start it:

   ```bash
   npm run db:up
   ```

   This makes the password files `postgres_password` (the container's superuser, used only by the container and the bootstrap) and `hol_app_password` (the app) if they are missing. Each is 32 random bytes as hex, mode `600`. It starts `db`, waits until it is healthy, and runs `db/bootstrap.sql`. The files go in `SECRETS_DIR` (read from `docker/.env` if it exists, else `.secrets/` in the repo, which is gitignored). The output should say `created .../postgres_password` and `created .../hol_app_password`.

2. In `.env.local`, set `DATABASE_PASSWORD_FILE` to the full path of the `hol_app_password` file, and `DATABASE_NAME=reservations`. The other `DATABASE_*` defaults in `.env.example` match the container. The port is published on `127.0.0.1` only.

3. Apply the migrations:

   ```bash
   npm run db:migrate
   ```

   Running it again is safe, because migrations already applied are skipped. The Docker deploy runs it for you too.

Other database commands:

| Command | What it does |
| --- | --- |
| `npm run db:up` | Start the database and bootstrap it. Safe to rerun |
| `npm run db:bootstrap` | Only the bootstrap. A rerun also puts the password from the file back on the `hol_app` role (restart `web`, `worker`, and `npm run dev` after) |
| `npm run db:reset -- --yes` | Delete the database and its volume, then `db:up` again. The password files are kept. Refuses without `--yes` |

A second clone on the same host sets `COMPOSE_PROJECT_NAME` and its own `DB_HOST_PORT` (the host side of the port; `DATABASE_PORT` in `.env.local` must match it).

### 4. App secrets

1. Make the session secret (at least 32 characters):

   ```bash
   openssl rand -base64 48 > ~/secrets/auth_secret
   ```

   If one already exists, keep it, because a new secret signs everyone out.

2. Make the encryption keyring (it encrypts the API key secrets stored in the database):

   ```bash
   npm run --silent secrets:keygen > ~/secrets/hol_encryption_keys.json
   ```

   The JSON goes to the file. The line `APP_ENCRYPTION_ACTIVE_KEY_ID=...` is printed to your terminal.

3. Copy that `APP_ENCRYPTION_ACTIVE_KEY_ID=...` line into `.env.local`, and later into `docker/.env` (step 9).
4. Back up `~/secrets/hol_encryption_keys.json`.

> If a keyring already exists (the web, worker, and dev server read one file), **keep it, don't generate a new one.** Secrets saved under a key id that's missing from the file can't be decrypted. To rotate a key, merge the new entry into the existing JSON and never remove an old id.

Without the keyring the app still runs, but the API Keys page shows "not configured" and the worker can't decrypt the Cloudflare key.

A new keyring cannot open secrets saved under the old one. After you delete the database or the keyring, re-add every API key in step 8. Keep the source files (the Cloudflare token, the Google OAuth client file, the Cloudflare account ID) in `~/secrets`, because the console never shows a saved key again.

### 5. Authentik

`npm run authentik:setup` creates the `hol` sign in app, the `hol-labs` app for lab VMs, the `hol-admins` group, and the `hol-webapp-provisioning` account. It never touches your testbed groups. It creates objects, and the only existing object it changes is the default brand's recovery flow (see item 3).

1. Set the values the script needs (replace each placeholder: your Authentik address, every URL learners and admins open the app at, comma separated, and your Cloudflare team domain):

   ```bash
   export AUTHENTIK_URL=https://<your authentik>
   export AUTHENTIK_MASTER_TOKEN_FILE=$HOME/secrets/authentik_master_token
   export APP_URLS=https://<prod host>,http://10.1.255.18:3000
   export CLOUDFLARE_TEAM_DOMAIN=<team>.cloudflareaccess.com
   ```

2. Do a dry run. It writes nothing and prints the changes it would make:

   ```bash
   npm run authentik:setup
   ```

3. Read the plan. On a fresh Authentik (nothing from a previous install) every line says `would create`, and the dry run stops at `Learner isolation` with `missing in Authentik: provider Provider for HOL`. That is expected, because the dry run cannot plan the isolation policy until the provider exists. The plan also says `would set brand authentik-default recovery flow to hol-recovery`: that is the one existing Authentik object the script changes (the default brand's "forgot password" flow), and it is what makes the set password links work. On a rerun you should see only `ok` lines, including `ok      a sign in reaches the login flow` under "Sign in check". That check asks Authentik to start a sign in for the HOL app and changes nothing. If it prints `FAILED`, the script exits with an error, and sign in at the app will not work until it is fixed. Then apply, writing both client secrets to files:

   ```bash
   npm run authentik:setup -- --apply \
     --secret-out ~/secrets/authentik_client_secret \
     --labs-secret-out ~/secrets/hol_labs_client_secret
   ```

   The run can print `warn provider ... isolation does not cover it` for other apps' providers (for example the Nile Portal ones). That is only a notice; nothing is changed for them. The script prints `AUTHENTIK_CLIENT_ID=...` and the HOL Labs client id, and writes the two secret files. The HOL Labs secret is written only when this run made the HOL Labs provider; on a rerun the old file stays as it is. Without `--secret-out`, the secret is printed on the screen instead.

4. Copy the printed `AUTHENTIK_CLIENT_ID=...` into `.env.local`, and later into `docker/.env` (step 9).
5. Note the printed `HOL Labs client id`. You paste it into Cloudflare in the next item.
6. In Cloudflare Zero Trust, open **Settings → Authentication → Login methods**. Edit the OIDC method that signs lab VM learners in through Authentik (here it is named "AWS Authentik IDP"), and set its **App ID** (Cloudflare's name for the client id) to the HOL Labs client id from item 5. Set its **Client secret** to the contents of the file:

   ```bash
   cat ~/secrets/hol_labs_client_secret
   ```

   Until you do, lab VM sign in fails. A login method that uses another Authentik app (here, "Nile Single Sign-On", which is `cloudflare-integration`) is not part of this app. Leave it alone.

7. Make the provisioning token. The script never creates it, so this is always by hand:
   1. In Authentik, open **Directory → Tokens and App passwords → Create**.
   2. Set **Identifier** (required) to `hol-webapp-provisioning-<yyyymmdd>` with today's date, **User** to `hol-webapp-provisioning` (not yourself), **Intent** to **API**, and **Expiry** about a year out.
   3. Save, then copy the key with the copy icon on its row. The row's Intent column must read "API Access".
   4. Save it to a file:

      ```bash
      umask 077 && read -rs TOKEN && printf '%s' "$TOKEN" > ~/secrets/authentik_provisioning_token && unset TOKEN
      chmod 600 ~/secrets/authentik_provisioning_token
      ```

   5. Check it. It must print `"username":"hol-webapp-provisioning"`:

      ```bash
      curl -s -H "Authorization: Bearer $(cat ~/secrets/authentik_provisioning_token)" \
        $AUTHENTIK_URL/api/v3/core/users/me/ | grep -o '"username":"[^"]*"'
      ```

   Don't use the `service-account-hol-webapp-provisioning-password` token that Authentik makes along with the account. Its intent is **App password**, and the API rejects it with `403 Token invalid/expired`.

8. In Authentik, open **Directory → Groups → hol-admins → Users → Add existing user**, and add every admin. Turn on MFA for them. Anyone signed in who isn't in that group is a learner. The first admin sign in at step 7 or 9 fails until this is done.

#### Replacing the provisioning account or token

The web app and the worker reach Authentik only through the `hol-webapp-provisioning` service account's API token. If the account or its token is deleted, or the token is edited (saving the edit form can move the token to your own user), every Authentik call fails with `403 Token invalid/expired`. Guest bookings, adding learners, set password links, sign out, and lab access then stop working. Admin sign in keeps working.

What the app needs in Authentik:

| Object | Settings |
| --- | --- |
| Service account `hol-webapp-provisioning` | Type service account, not a superuser, in no group, account doesn't expire |
| Role `hol-webapp-provisioning`, given to that account | Exactly these global permissions: `authentik_core.view_user`, `add_user`, `change_user`, `reset_user_password`, `view_group`, `add_group`, `delete_group`, `add_user_to_group`, `remove_user_from_group`, `view_authenticatedsession`, `delete_authenticatedsession` (the list is `PROVISIONING_PERMISSIONS` in [scripts/authentik-setup-plan.ts](scripts/authentik-setup-plan.ts)) |
| An API token owned by that account | Intent API, expiry about one year out |

The role has no `delete_user` on purpose. Authentik's permissions can't limit a role to learners, so a token with `delete_user` could delete any user, admins included. Remove test learners by hand in the Authentik UI.

To put it back:

1. In Authentik, open **Directory → Tokens and App passwords** and delete any token named `hol-webapp-provisioning-*` that no longer belongs to `hol-webapp-provisioning`. A token moved to an admin user carries that admin's rights.
2. Recreate the account and the role with the setup script. It creates only what's missing and never changes what exists. Run the dry run first and check that the plan lists just the account, the role, and its permissions:

   ```bash
   AUTHENTIK_URL=https://<your authentik> \
   AUTHENTIK_MASTER_TOKEN_FILE=~/secrets/authentik_master_token \
   APP_URLS=https://<prod host>,http://10.1.255.18:3000 \
   CLOUDFLARE_TEAM_DOMAIN=<team>.cloudflareaccess.com \
   npm run authentik:setup
   ```

   Then run the same command again with `-- --apply` added. Without `--secret-out` the script prints the client secret instead of writing a file, so if it prints one, leave your existing secret files alone. It created nothing new there.

   To do it by hand instead, create the service account under **Directory → Users → New Service Account** (turn off "Create group" and "Expiring"), create the role under **Directory → Roles** with the permissions above, and give the role to the account.
3. Create the token under **Directory → Tokens and App passwords → Create**. Set User to `hol-webapp-provisioning` (not yourself), Intent to **API**, and an expiry about a year out. Save, then copy the key with the copy icon on its row, and check that the row's Intent column reads "API Access".

   > Don't use the `service-account-hol-webapp-provisioning-password` token that Authentik makes along with the account. Its intent is **App password**, a sign in password, and the API rejects it with `403 Token invalid/expired` even though it belongs to the right account. You never need the service account's password; the app uses only the API token.
4. Save it, replacing the old file:

   ```bash
   umask 077 && read -rs TOKEN && printf '%s' "$TOKEN" > ~/secrets/authentik_provisioning_token && unset TOKEN
   ```

5. Check it, then restart the containers, which read secrets only at start (dev picks it up on the next `npm run dev`):

   ```bash
   curl -s -H "Authorization: Bearer $(cat ~/secrets/authentik_provisioning_token)" \
     https://<your authentik>/api/v3/core/users/me/ | grep -o '"username":"[^"]*"'
   docker compose -f docker/compose.yaml restart web worker
   ```

   The check must print `"username":"hol-webapp-provisioning"`. Any other name means the token belongs to the wrong user.

#### If the provisioning token is compromised

The token does not expire, so rotate it yourself if it leaks (a pasted log, a shared screen, a lost laptop) or when someone who knew it leaves. The old token keeps working until you delete it, so do the steps in this order:

1. In Authentik, open **Directory → Tokens and App passwords → Create**. Set **Identifier** to `hol-webapp-provisioning-<yyyymmdd>` with today's date, **User** to `hol-webapp-provisioning` (not yourself), **Intent** to **API**, and leave **Expiring** off. Save, then copy the key with the copy icon on its row.
2. Save it over the old file, then check it. The check must print `"username":"hol-webapp-provisioning"`:

   ```bash
   umask 077 && read -rs TOKEN && printf '%s' "$TOKEN" > ~/secrets/authentik_provisioning_token && unset TOKEN
   chmod 600 ~/secrets/authentik_provisioning_token
   curl -s -H "Authorization: Bearer $(cat ~/secrets/authentik_provisioning_token)" \
     https://<your authentik>/api/v3/core/users/me/ | grep -o '"username":"[^"]*"'
   ```

3. Restart everything that reads the file, because containers read secrets only at start. Stop any `npm run dev` or `npm run worker` on your machine and start it again:

   ```bash
   docker compose -f docker/compose.yaml restart web worker
   ```

4. Delete the old token in Authentik (the row for the old identifier under **Directory → Tokens and App passwords**). This is the step that cuts off the attacker. Until it is done, the leaked token still works.
5. Look for what the leaked token did. In Authentik, open **Events → Logs** and filter by the user `hol-webapp-provisioning`, from the date the token may have leaked:
   - Users created or changed that you don't recognise: check **Directory → Users** for accounts in the path `hol/learners` that no booking explains, and delete them.
   - Sessions deleted, or password reset links created, for people you know.
   - Membership of the testbed groups and of `hol-admins`. The app refuses to add anyone to `hol-admins`, but the token itself is not limited that way, so check that only your admins are in it.
6. Check the app's own record of group changes. It records the admin actions and group changes the app made, so a change in Authentik with no matching row here may not have come from the app:

   ```bash
   docker compose -f docker/compose.yaml exec -T db psql -U hol_app -d reservations \
     -c "select created_at, action, summary from hol_app.audit_events order by created_at desc limit 50"
   ```

7. If the token was exposed together with other secrets (a copied `~/secrets` folder, a backup), rotate those too: the Authentik client secrets by running step 5 again after deleting the apps (see "Starting over from scratch"), the session secret (`auth_secret`, which signs everyone out), and the Cloudflare token.

### 6. Fill in `.env.local`

1. Open `.env.local` in an editor and set each variable in this table. Use absolute paths in every `*_FILE` variable, because `~` isn't expanded inside `.env.local`.

| Variable | Value |
| --- | --- |
| `APP_URL` | The exact URL your browser uses. For dev, that's `http://10.1.255.18:3000`, not localhost (see Troubleshooting) |
| `ADMIN_ENTRY_PATH` | The admin sign in path, a single segment such as `/l0gin`. It's never linked from public pages |
| `AUTHENTIK_URL` | Your Authentik address, the same as `AUTHENTIK_URL` in step 5 |
| `AUTHENTIK_CLIENT_ID` | From step 5, item 4 |
| `AUTHENTIK_CLIENT_SECRET_FILE` | `/home/<you>/secrets/authentik_client_secret` |
| `AUTHENTIK_PROVISIONING_TOKEN_FILE` | `/home/<you>/secrets/authentik_provisioning_token` |
| `AUTH_SECRET_FILE` | `/home/<you>/secrets/auth_secret` |
| `APP_ENCRYPTION_KEYS_FILE` | `/home/<you>/secrets/hol_encryption_keys.json` |
| `APP_ENCRYPTION_ACTIVE_KEY_ID` | From step 4, item 3 |
| `DATABASE_PASSWORD_FILE` | `/home/<you>/secrets/hol_app_password` (step 3) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Keep the Cloudflare test keys from `.env.example` for dev; use the real widget keys on a public deployment |
| `TRUST_PROXY_HEADERS` | `false` in dev, which is also the default when the line is missing. `true` only behind the Cloudflare Tunnel (Compose sets it for `web`) |
| `WORKER_ENABLED` | `false`, unless this machine runs the one worker (step 9). Missing means `false` too |

2. Check that every file the variables name exists and has mode `600`:

   ```bash
   ls -l ~/secrets
   ```

   Every secret file should show `-rw-------`. If one doesn't (files you copied in, such as `google.json`), run `chmod 600` on it. You should see `auth_secret`, `authentik_client_secret`, `authentik_provisioning_token`, `hol_app_password`, `hol_encryption_keys.json`, `hol_labs_client_secret`, and `postgres_password`.

### 7. Start it (dev server)

This step is optional. A production host that only runs the Docker containers skips it and goes to [Running with Docker](#running-with-docker), then does steps 8 to 10. Run it on a dev machine, or on a new host before the first deploy, to check that the app starts and that sign in and the database work.

1. Start the dev server:

   ```bash
   npm run dev
   ```

2. Open `http://10.1.255.18:3000` for the public site, and `http://10.1.255.18:3000/l0gin` (your `ADMIN_ENTRY_PATH`) to sign in as an admin. `npm run dev` never runs migrations or the worker.

If your machine has a different LAN IP, use it in `APP_URL` and in `APP_URLS` (step 5), and add it to `allowedDevOrigins` in [next.config.ts](next.config.ts). Otherwise the page loads but buttons do nothing, because Next blocks its dev scripts for hosts that aren't on that list.

### 8. Add the API keys in the admin console

The app must be running (step 7, or the Docker deploy) for this step.

1. Sign in as an admin at `<APP_URL><ADMIN_ENTRY_PATH>`, for example `http://10.1.255.18:3000/l0gin`. You must be in the `hol-admins` group (step 5, item 8).
2. Go to **Admin → API Keys → Add API key**.
3. Add the Cloudflare key, then the Google key, with the values below.

**Cloudflare** (lets the worker cut a learner's lab VM access when their booking ends; you can add only one):

- Type: `CLOUDFLARE`
- Base URL: `https://api.cloudflare.com/client/v4/accounts/<account id>`. Use the 32 character account ID shown in the address bar of the Cloudflare dashboard (`dash.cloudflare.com/<account id>/...`). It must be lowercase, with no trailing slash and nothing after the ID.
- Key value: a Cloudflare API token with **Account → Access: Organizations, Identity Providers, and Groups → Edit** on that account. The token and the account ID are in `~/secrets/cloudflare_access_revoke_token` and `~/secrets/cloudflare_account_id` if you saved them there:

  ```bash
  cat ~/secrets/cloudflare_account_id; echo; cat ~/secrets/cloudflare_access_revoke_token
  ```

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
3. Make the client file (the `gmail_desktop` file in `~/secrets`). It holds the client id and the client secret of a Desktop app client:
   1. Open **Clients** ([console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)), with the right project selected in the top bar, and click **Create client**.
   2. Set **Application type** to **Desktop app**, give it a name such as `HOL desktop`, and click **Create**. A *Web application* client will not work.
   3. In the dialog that appears, click **Download JSON**. Google may show the client secret only now, so download it before you close the dialog. If you closed it, open the client from the list and use **Download JSON** there, or create a new client.
   4. The file is named `client_secret_<numbers>.apps.googleusercontent.com.json` and starts with `{"installed":`. If it starts with `{"web":`, you made the wrong type.
   5. Move it into the secrets folder and lock it down (replace the path with where your browser saved it):

      ```bash
      mv ~/Downloads/client_secret_*.json ~/secrets/gmail_desktop
      chmod 600 ~/secrets/gmail_desktop
      head -c 14 ~/secrets/gmail_desktop; echo
      ```

      The last command must print `{"installed":`.

   The app asks you to choose this file in the console when you save the key. It reads it again on every save, and it does not keep the file, so keep your copy.
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

The page at `http://127.0.0.1:47613/` fails to load on purpose. Google lets a Desktop app client redirect only to a loopback address, never to a real host name such as your app's domain, and nothing in the app listens on that port. The address in the bar still carries the one time code, which is why you paste it back. A public host name does not change this.

The list then shows the key with "Google sign in" and the Gmail address as the sender. If Save says to sign in again, click **Sign in with Google** again and repeat from step 4. Each Google address works only once.

#### Using a different Gmail account for Google sign in

The account you sign in with at **Sign in with Google** is the sender of every email and the owner of the "HOL bookings" calendar. The OAuth client file (the Desktop app JSON) belongs to a Google Cloud project, and it does not have to belong to the same account. So you can send from any Gmail account in one of two ways.

**A. Reuse the existing client file (the quick way).** This works when the project's **Audience** shows *In production* (see "Google sign in" above), because then any Google account can sign in with the same file.

1. Sign in to [Google Calendar](https://calendar.google.com) as the new account. Create the calendar "HOL bookings", share it (read only) with the admins, and copy its **Calendar ID** (calendar settings → *Integrate calendar*). A calendar of the old account can't be used, because the app writes to the calendar of the account that signs in.
2. In the app, open **Admin → API Keys → Add API key** (or **Edit** on the existing Google key), Type `GOOGLE`, Sign in method **Google sign in (personal Gmail, for testing)**.
3. Choose the same Desktop app JSON, paste the new Calendar ID, and click **Sign in with Google**.
4. Open the sign in link and sign in as the **new** account. Check the account name Google shows before you continue, because Google may offer the old account first. Then follow the same prompts as above (*Advanced* → *Go to … (unsafe)*, both permissions ticked, copy the address of the page that won't load, paste it, **Save**).
5. If Google says the app is blocked or the account isn't allowed, the project's Audience is still *Testing*. Either click **Publish app** in *Google Auth Platform → Audience*, or add the new account under **Test users** (a Testing app stops working after 7 days).

**B. Use a client file from the new account's own project.** Do the whole "Google sign in" setup above signed in as the new account (project, Gmail and Calendar APIs, Branding, Audience *In production*, Data access, a Desktop app client). Then follow A from step 1, choosing the new JSON.

After you switch an account that already had bookings:

- The old calendar keeps its events and gets no more updates. Copy existing bookings to the new calendar with `npm run calendar:backfill` (a dry run that prints a count), then `npm run calendar:backfill -- --apply`.
- Emails already sent keep the old sender as their organizer. A learner whose phone saved an old invite keeps it on the old calendar.
- Remove the app's access in the old account: *Google Account* → *Security* → *Third party apps and services*.

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

The worker sends email, syncs the calendar, sweeps expired holds, and revokes lab access. It exits unless `WORKER_ENABLED=true`. If you run the Docker containers, the `worker` container is the one worker and you skip the command below.

1. Check that no other worker is running:

   ```bash
   docker ps --filter name=reservations-worker
   ```

2. Only if that printed no container, start one on this machine:

   ```bash
   WORKER_ENABLED=true npm run worker
   ```

**Because Authentik is shared, a worker started on your machine changes real group membership.** Only one may run at a time. See [server/worker/AGENTS.md](server/worker/AGENTS.md).

While the `reservations-worker-1` container runs, it holds the worker lock, and `npm run worker` on your machine prints "another worker holds the lock" and exits.

### 10. Check your setup

Run the checks:

```bash
npm run lint && npm run typecheck
npm test            # DB tests run inside a rolled back transaction, so nothing is written
npm run test:e2e    # Playwright against the dev server; needs ~/secrets/hol-test-*.pw
```

The database tests run against the live database inside a transaction that is always rolled back, so your real testbeds and bookings are never changed (a sample value that collides with a real row is tolerated). `npm run test:e2e` is optional: it signs in through the real Authentik, so it needs the dev server running and the test accounts to exist, with their passwords in `~/secrets/hol-test-*.pw` and `hol-test-admin` in `hol-admins`. A fresh install has none of these, so skip it until you make them.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| The page loads but clicks do nothing | Your host isn't in `allowedDevOrigins` in `next.config.ts` (step 7) |
| Sign in fails with `state_mismatch` | `APP_URL` doesn't match the URL in your browser. Make them identical |
| Sign in lands on "Sign in unavailable" with `error=invalid_request` and `The request is otherwise malformed` in the address | Authentik refuses the authorize request because the "Provider for HOL" has no grant types (`grant_types` is empty). Run `npm run authentik:setup` (dry run). It shows `FAILED  Authentik refused the request: invalid_request` under "Sign in check" and a `change  Provider for HOL.grant_types` line. Run it again with `-- --apply` (step 5), then check that the dry run says `ok` for both. |
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

### Starting over from scratch

Use this to wipe the app and install it again with the steps above. The Authentik admin account, the master token, the testbed groups, and any Authentik app the setup script did not make are never part of it.

1. Back up the database and the secrets:

   ```bash
   mkdir -p ~/backups && umask 077
   docker compose -f docker/compose.yaml exec -T db \
     pg_dump -U hol_app -d reservations -n hol_app -n hol_auth -Fc > ~/backups/before-wipe.dump
   cp -a ~/secrets ~/backups/secrets-before-wipe
   ```

2. Remove what the app made in Authentik. The app never deletes these, so use the Authentik admin UI. Delete in this order, so nothing points at a missing object:
   1. The binding of the `hol-learner-isolation` policy on the default authorization flows, and the `hol-labs-access` binding on `hol-labs`; then both policies.
   2. The applications `hol` and `hol-labs`, then the providers "Provider for HOL" and "HOL Labs".
   3. The flows `hol-authorization`, `hol-lab-authorization`, and `hol-recovery` (and `hol-invalidation` if it exists), then the stages `hol-recovery-password`, `hol-recovery-write`, `hol-recovery-login` (and `hol-invalidation-logout`).
   4. The group `hol-admins`, then the service account `hol-webapp-provisioning` with its tokens and role.
   5. The learner users the app made: path `hol/learners`, attribute `hol_learner` set to true. Never delete anyone else.

   Leave the testbed groups (the ones marked `hol_testbed_group`) alone.
3. Remove the containers, the database volume, the network, and the images. Nothing else on the host is touched:

   ```bash
   docker compose -f docker/compose.yaml down -v --remove-orphans
   docker images reservations --format '{{.Repository}}:{{.Tag}}' | xargs -r docker rmi
   ```

4. Remove the generated secrets. Keep `authentik_master_token` and the files for your Cloudflare and Google keys:

   ```bash
   cd ~/secrets
   rm -f postgres_password hol_app_password auth_secret hol_encryption_keys.json \
     authentik_client_secret hol_labs_client_secret authentik_provisioning_token
   cd -
   ```

5. Install again, in this order: steps 2 to 6 of "Getting the webapp running" (this replaces the old `AUTHENTIK_CLIENT_ID` and `APP_ENCRYPTION_ACTIVE_KEY_ID` in `.env.local` and `docker/.env`), then [Running with Docker](#running-with-docker), then step 8 to re-add the API keys. Add your admins to the new `hol-admins` group before you sign in.

## Testbed groups

Each testbed is tied to an Authentik group that already exists. The app never creates, renames, or deletes a group. It only adds a learner to the group when their booking starts, and removes them when it ends. The same group name is what Cloudflare Access checks for the lab VMs.

### Making a group

You make the group, with your own script or in Authentik. For the app to use it, the group must be:

- **Marked.** It has the attribute `hol_testbed_group` set to the boolean `true`. The string `"true"` does not count. The app and the HOL Labs gate both read this marker.
- **Flat.** It has no parent group and no role, because either could hand its members admin rights.
- **Not a superuser group**, and not `hol-admins`.

### Adding a testbed

Go to **Admin → Testbeds → Add testbed**.

- **Name:** exactly the name of the group, with the same capital letters. A hint under the field says so. The name cannot change later. To use another group, delete the testbed and add a new one. Deleting is blocked while the testbed has Upcoming or Current reservations.
- **Domain:** the email domain of the Nile tenant, for example `nile.global`. Capital letters are turned into small ones.
- The name and the domain must each be unused among live testbeds. A deleted testbed frees both.
- The domain cannot change while the testbed has Upcoming or Current reservations.

The app checks the group when you save. Under the Name field you will see one of these: "No Authentik group with this name exists.", "That group isn't set up for testbeds. It needs the hol_testbed_group marker.", or "Another testbed already uses that group." If Authentik cannot be reached, the form says so, and nothing is saved.

When a testbed is deleted, the group is left alone. The worker only records that the app is done with it (an audit entry named "Authentik group released").

## Running with Docker

The app runs on this host as one Docker Compose project named `reservations`, with four services (the Postgres `db`, and three built from one image):

| Service | Runs | Notes |
| --- | --- | --- |
| `db` | `postgres:18.6-bookworm`, pinned by digest | The app's database, in the volume `hol_pgdata`. Published on `127.0.0.1` only. `migrate` starts after it is healthy |
| `migrate` | `node dist/migrate.mjs` | Applies new migrations, then exits. `web` and `worker` start only after it succeeds |
| `web` | `node server.js` (Next.js standalone) | Port 3000 inside the container, published only through Traefik. Healthcheck on `/api/health` |
| `worker` | `node dist/worker.mjs` | The one worker (`WORKER_ENABLED=true`). On stop it finishes its current step, with up to 60 seconds |

A request travels: browser → Cloudflare → Cloudflare Tunnel (`cloudflared`) → Traefik → `web:3000`. The containers reach Postgres as `db:5432` on the `hol-internal` network, which Compose creates. The files are [Dockerfile](Dockerfile), [docker/compose.yaml](docker/compose.yaml), [docker/.env.example](docker/.env.example), and [scripts/deploy.sh](scripts/deploy.sh).

### 1. What the host needs

| Need | How to check | Why |
| --- | --- | --- |
| Docker Engine with Compose v2 (tested on Docker 28.4, Compose 2.39) | `docker compose version` | Builds the image and runs the project |
| A user with uid `1000` that can run `docker` | `id -u` | The containers run as `node` (uid 1000) and must read the secret files, which are mode `600` |
| A Traefik v3 container on an external Docker network named `traefik`, with an HTTPS entrypoint `websecure` and a cert resolver `letsencrypt` | `docker network inspect traefik`, and Traefik's `--entrypoints` and `--certificatesresolvers` flags | The `web` labels in `docker/compose.yaml` use these names; change the labels if your Traefik uses others |
| A Cloudflare Tunnel that sends the app's host name to Traefik (here, a `*.nile.global` → `https://traefik` rule) | The tunnel's *Public Hostnames* in Cloudflare Zero Trust | The only way in from the internet; no port is opened |
| No other DNS record for the app's host name | Cloudflare → DNS → search for the host | A specific record (for example a CNAME to a Pages project) wins over the wildcard and sends visitors to another site |
| The database up (`npm run db:up`), plus secrets and Authentik set up as in steps 3 to 5 above | `ls` the secrets folder | The containers read the same secrets as `npm run dev` |
| The public URL in the Authentik provider's redirect URIs | Step 5, with `APP_URLS=https://<prod host>,http://10.1.255.18:3000` | Otherwise sign in fails with a redirect URI error |
| Real Turnstile keys for the host name | Cloudflare → Turnstile | The `.env.example` test keys always pass, so the public booking form has no bot protection |

### 2. Secret files

Compose mounts these files from `SECRETS_DIR` (default `.secrets/` in the repo) into `/run/secrets/` in each container. The names must match exactly:

| File in `SECRETS_DIR` | Made in |
| --- | --- |
| `postgres_password` | Step 3 (`db` only) |
| `hol_app_password` | Step 3 |
| `auth_secret` | Step 4 |
| `hol_encryption_keys.json` | Step 4 |
| `authentik_client_secret` | Step 5 |
| `authentik_provisioning_token` | Step 5 |

`db` gets only `postgres_password`, and `migrate` only `hol_app_password`. The Authentik master token is never mounted.

Before you deploy, all six files must exist, or Compose refuses to start. Check:

```bash
ls ~/secrets/postgres_password ~/secrets/hol_app_password ~/secrets/auth_secret \
  ~/secrets/hol_encryption_keys.json ~/secrets/authentik_client_secret \
  ~/secrets/authentik_provisioning_token
```

### 3. Fill in `docker/.env`

1. Make the file (skip this if `docker/.env` already exists):

   ```bash
   cp docker/.env.example docker/.env
   chmod 600 docker/.env
   ```

2. Open it in an editor and set the variables below.

`docker/.env` is gitignored and optional for the database alone (`db:up` works without it). Compose reads it for the `${...}` values in `docker/compose.yaml` and also passes it to every container:

| Variable | Value |
| --- | --- |
| `SECRETS_DIR` | Absolute path to the folder with the secret files above |
| `APP_HOST` | The public host name, for example `reservations.nile.global`. Traefik routes it to `web` |
| `APP_URL` | `https://` plus `APP_HOST`, exactly as visitors see it |
| `ADMIN_ENTRY_PATH` | The same value as in `.env.local` |
| `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID` | The same values as in `.env.local` (one Authentik and one client) |
| `TURNSTILE_SITE_KEY` | The real widget's site key |
| `TURNSTILE_SECRET_KEY` | The real widget's secret. You can put it in a file instead: mount it and set `TURNSTILE_SECRET_KEY_FILE` |
| `APP_ENCRYPTION_ACTIVE_KEY_ID` | The same value as in `.env.local` |

Compose itself sets the database host, every `*_FILE` path, `TZ=UTC`, `TRUST_PROXY_HEADERS=true` on `web`, and `WORKER_ENABLED=true` on `worker`. Don't add them to `docker/.env`.

### 4. Deploy

1. Check that no other worker is running (for example `npm run worker` on a dev machine). The first worker to start holds the lock; a second one exits.
2. Deploy, with one of these:

   ```bash
   scripts/deploy.sh          # migrate, web, and worker
   scripts/deploy.sh web      # migrate and web only, with no worker
   ```

The script:

1. builds the image from the current checkout and tags it `reservations:sha-<commit>` (with `-dirty` added if you have uncommitted changes), plus `reservations:latest`;
2. makes sure `db` is up and bootstrapped (so a rotated password is applied), then dumps the `hol_app` and `hol_auth` schemas to `~/backups/hol_before_deploy_<time>.dump` (set `BACKUP_DIR` to change the folder);
3. runs `docker compose up -d`, which runs `migrate` and then (re)starts `web` and `worker`.

The first build takes a few minutes. The build reads no env or secrets, so it can run anywhere.

3. Check the result:

```bash
docker compose -f docker/compose.yaml ps            # web shows (healthy)
curl -s https://<APP_HOST>/api/health               # {"status":"ok","db":"ok"}
docker logs reservations-migrate-1                  # applied: ... or nothing to apply
docker logs reservations-worker-1                   # worker: started
```

4. Sign in at `https://<APP_HOST><ADMIN_ENTRY_PATH>` as an admin, then do step 8 (API keys) of "Getting the webapp running".

### 5. Day to day

All commands run from the repo root.

| Task | Command |
| --- | --- |
| Deploy a new version | `git pull && scripts/deploy.sh` |
| Follow the logs | `docker logs -f reservations-web-1` (or `reservations-worker-1`) |
| Apply a change to `docker/.env` | `docker compose -f docker/compose.yaml up -d` (Compose sees the change and recreates the containers) |
| Apply a changed secret file | `docker compose -f docker/compose.yaml restart web worker` (secrets are read once at start) |
| Stop the worker only | `docker compose -f docker/compose.yaml stop worker` |
| Stop everything | `docker compose -f docker/compose.yaml down` (the database is not touched) |
| Roll back to an earlier image | `IMAGE_TAG=sha-<commit> docker compose -f docker/compose.yaml up -d web worker` (list the tags with `docker images reservations`) |

A rollback changes only the code. Migrations are never undone, which is why each migration must also work with the previous release. To restore the data itself, stop `web` and `worker`, then load the dump from before the deploy. This overwrites the current data, so be sure first:

```bash
docker compose -f docker/compose.yaml exec -T db \
  pg_restore -U hol_app -d reservations --clean --if-exists < ~/backups/<dump file>
```

### 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| The public URL shows a different site, while `curl -k --resolve <APP_HOST>:443:127.0.0.1 https://<APP_HOST>/` shows ours | Another DNS record for the host name overrides the tunnel. Remove it in Cloudflare DNS (and the custom domain on whatever it points to) |
| Traefik answers `404 page not found` | `web` is not running, not on the `traefik` network, or `APP_HOST` doesn't match the host name |
| `migrate` fails with a password or role error | The database was never bootstrapped, or the password file changed. Run `npm run db:bootstrap`, then deploy again |
| `web` or `migrate` fails at start with `EACCES` on `/run/secrets/...` | The secret files aren't readable by uid 1000. Run the deploy as the uid 1000 user, or `chown 1000` the files |
| `migrate` exits with an error, and `web` and `worker` don't start | Read `docker logs reservations-migrate-1`. Nothing after the failed migration ran, and the dump from before the deploy is in `~/backups` |
| The image build fails while "Generating static pages" with a `ZodError` on an env variable | A page reads env before it calls `headers()`, `cookies()`, or `connection()`, so Next tries to prerender it at build time. Call one of those first (see `currentSession` in `server/auth/require.ts`) |
| `worker: another worker holds the lock, exiting` | A worker is already running somewhere (often `npm run worker` in dev). Stop that one; Compose restarts this one |
| `reconciler: testbed … is stale and no usable group has the testbed's name` every tick | The testbed's Authentik group was deleted, renamed, or unmarked. Make or rename a marked group with exactly the testbed's name and the next tick finds it again. If the testbed is no longer used, delete it in the console (see "Testbed groups") |
| Sign in fails with a redirect URI error | Add the public URL to the provider with `npm run authentik:setup` (step 5) |
| Guest bookings and adding learners fail, and Authentik answers `403 Token invalid/expired` | The provisioning account or its token is gone or was edited, or the saved token has intent App password instead of API. See "Replacing the provisioning account or token" under step 5 of Getting the webapp running |
