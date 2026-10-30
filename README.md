# Nile HOL Reservations

The booking site for Nile hands-on labs (HOL). Learners book a testbed slot, get a confirmation email with a calendar invite, and open their lab VM through Cloudflare Access while the booking is live. Admins run the catalog, the users, and the API keys from a console.

Built with Next.js 16 (App Router), React 19, Kysely on its own Postgres container, Better Auth against Authentik, and a separate background worker. The full stack decisions are in [spec 0001](docs/specs/0001-stack-architecture/index.md), and the working rules for contributors are in [AGENTS.md](AGENTS.md).

## Getting the webapp running

Read this before you start: **everything here is dev, and Authentik is shared.** A worker you start on your machine changes real Authentik group membership, and test users you create there are real.

Do the steps in order, in one terminal, from the repo root. Every command is in a code block, and every numbered item is something you do. A fresh install is steps 1 to 6, then you start the app (step 7 for the dev server, or the [Docker](#running-with-docker) section for the containers), then steps 8 to 10. Also do [Nile Portal Reset setup](#nile-portal-reset-setup) before you turn the reset on.

Placeholders in `<angle brackets>` are values only you know. Write them as plain text, without the brackets.

### 1. What you need

| Need | Why |
| --- | --- |
| Node 24 or newer, and npm | `package.json` requires Node 24 or newer |
| Docker with Compose v2 | The app's Postgres runs as the `db` container from `docker/compose.yaml` |
| An Authentik admin account and its master token | Used once, by `npm run authentik:setup`, to create the sign in apps, the `hol-admins` group, and the provisioning account. The app never uses it at runtime (it runs on the restricted provisioning token), so you can delete the token file after setup |
| A Cloudflare account with Zero Trust (team domain `<team>.cloudflareaccess.com`) | Turnstile on public forms, and lab VM access |
| Optional: a Google account for the HOL mailbox and calendar | Booking emails and the shared "HOL bookings" calendar |
| Docker, Traefik, and a Cloudflare Tunnel on the host (only to run the containers) | See [Running with Docker](#running-with-docker) |

**What must already exist in Authentik.** Setup creates the apps, `hol-admins`, and the provisioning account, but not the people or the workshop groups. Have these ready before you start:

- **One group per workshop (testbed), made by you.** The app never creates, renames, or deletes a group. Each one needs the attribute `hol_testbed_group` set to the boolean `true`, and the attribute `hol_testbed_domain` set to the workshop's Nile tenant domain (for example `nileworkshop-1.com`). It must be flat (no parent group, no role) and not a superuser group. The group name is what an admin types when adding the testbed, and what Cloudflare Access checks for the lab VMs. Without a marked group with a domain, you cannot add a testbed. Details in [Testbed groups](#testbed-groups).
- **Your admins as Authentik users.** After setup, add each one to `hol-admins` (step 5, item 8) and turn on MFA. Anyone not in that group is a learner.
- **Per-workshop automation users are not yours to make.** For Nile Portal Reset, the worker creates `automation@<testbed domain>` itself and adds it to that workshop's group, so you only need the group above. This is optional and described in [Nile Portal Reset setup](#nile-portal-reset-setup).
- **The Cloudflare side of the lab VMs**, if you use it: the lab VM Access apps use the HOL Labs identity provider and allow the workshop group by name.

**Secret files checklist.** Every secret file lives in `~/secrets/` (the Docker setup reads `SECRETS_DIR` from `docker/.env`, `.secrets/` in the repo by default; use that folder instead if you set it). Tick each one off as you make it. The check command below prints `ok` or `MISSING` for each, so you never have to guess.

| Done | File | What it is | Made in | Needed |
| --- | --- | --- | --- | --- |
| [ ] | `~/secrets/postgres_password` | Postgres superuser password | Step 3 (`npm run db:up`) | Always |
| [ ] | `~/secrets/hol_app_password` | Database password for the app | Step 3 (`npm run db:up`) | Always |
| [ ] | `~/secrets/auth_secret` | Signs session cookies | Step 4 | Always |
| [ ] | `~/secrets/hol_encryption_keys.json` | Keyring that encrypts stored API keys (back it up: see [Backups](#backups-and-disaster-recovery)) | Step 4 | Always |
| [ ] | `~/secrets/authentik_master_token` | Your Authentik admin API token, for `authentik:setup` only | Step 1, item 2 | Setup only; delete afterwards, never mounted |
| [ ] | `~/secrets/authentik_client_secret` | Client secret of the `hol` sign in app | Step 5 | Always |
| [ ] | `~/secrets/hol_labs_client_secret` | Client secret of the HOL Labs app; you paste it into Cloudflare, the app never reads it | Step 5 | Only if you use lab VMs |
| [ ] | `~/secrets/authentik_provisioning_token` | API token of the `hol-webapp-provisioning` account | Step 5, item 7 | Always |
| [ ] | `~/secrets/gmail_desktop` | Google OAuth Desktop client (id and secret) | [Google sign in](#google-sign-in-personal-gmail-for-testing) | Only if booking emails use Google sign in (you upload it in the console) |
| [ ] | `~/secrets/cloudflare_access_revoke_token` and `~/secrets/cloudflare_account_id` | Cloudflare API token and account ID; you paste them into the console's API Keys page (step 8), the app does not read the files | Cloudflare dashboard | Only to revoke lab VM access |

[Backups and disaster recovery](#backups-and-disaster-recovery) saves these files (encrypted) with the database.

Not secret files: `TURNSTILE_SECRET_KEY` is an env value (or `TURNSTILE_SECRET_KEY_FILE`), see step 6. The `hol-test-*.pw` files are for `npm run test:e2e` only. A Workspace service account key is uploaded in the console and then deleted, so it does not need to stay in `~/secrets`.

Check which files exist (run it at any time; it prints names only, never contents):

```bash
for f in postgres_password hol_app_password auth_secret hol_encryption_keys.json \
  authentik_client_secret authentik_provisioning_token hol_labs_client_secret \
  authentik_master_token gmail_desktop cloudflare_access_revoke_token cloudflare_account_id; do
  [ -s ~/secrets/$f ] && echo "ok       $f" || echo "MISSING  $f"
done
```

The first six lines (through `authentik_provisioning_token`) are required for the app to start. The others depend on the Needed column. Right after you finish step 5, every required file should say `ok`.

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
6. In Cloudflare Zero Trust, open **Settings → Authentication → Login methods**. Edit the OpenID Connect method that signs lab VM learners in through Authentik (here it is named "AWS Authentik IDP"), or add one if there is none, and set every field below. The setup script prints the same list, with your values filled in, after the `HOL Labs client id` line. `<authentik>` is your `AUTHENTIK_URL`:

   | Cloudflare field | Value |
   | --- | --- |
   | Name | Any name you like (it shows on the login page), for example `HOL Labs` |
   | Callback URL | Read only. It must read `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`, which is the redirect URI step 5 set on the HOL Labs provider from `CLOUDFLARE_TEAM_DOMAIN`. Nothing to enter |
   | App ID | The `HOL Labs client id` from item 5 |
   | Client secret | The contents of `~/secrets/hol_labs_client_secret` (`cat` it) |
   | Auth URL | `<authentik>/application/o/authorize/` |
   | Token URL | `<authentik>/application/o/token/` |
   | Certificate URL | `<authentik>/application/o/hol-labs/jwks/` (the `hol-labs` in the path is the application slug) |
   | Proof Key for Code Exchange (PKCE) | On. Authentik supports it for confidential clients |
   | Enable SCIM | Off |
   | Email claim | Leave empty |
   | OIDC Claims | Add `groups`. The lab VM Allow policy reads this claim, and without it every learner is denied. Authentik sends it with the `profile` scope |
   | OIDC Scopes | `openid`, `email`, `profile`, which Cloudflare fills in and won't let you delete. Add no others |

   Press **Test**, then **Save**. Until you do, lab VM sign in fails. Each lab VM's Access application must allow only this login method (turn "Accept all available identity providers" off), with an Allow policy on the OIDC claim `groups` equal to the testbed's group name.

   Authentik's `/application/o/authorize/` and `/application/o/token/` are the same for every application. Only the Certificate URL names the application, so a method copied from another Authentik app keeps that app's `…/<slug>/jwks/` until you change it.

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

   Every secret file should show `-rw-------`. If one doesn't (files you copied in, such as `gmail_desktop`), run `chmod 600` on it. You should see `auth_secret`, `authentik_client_secret`, `authentik_provisioning_token`, `hol_app_password`, `hol_encryption_keys.json`, `hol_labs_client_secret`, and `postgres_password`.

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

Your Workspace admin can do steps 1 to 3 from [Appendix A](#appendix-a-creating-the-google-service-account-hand-off-for-a-workspace-admin).

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

## Nile Portal Reset setup

The **Nile Portal Reset** page ([spec 0022](docs/specs/0022-nile-portal-reset-page.md)) keeps the list of portal calls, and the reset engine ([spec 0023](docs/specs/0023-nile-portal-reset-engine)) runs it. After every lab, at its booked end or when it is cancelled or moved early, the worker resets that workshop's Nile Portal so the next learner starts on an empty tenant. The run starts 5 minutes after the lab ends and should finish within 25. The mode starts **Off**, so nothing runs until you change it. Nothing here is needed to run the rest of the app.

How it signs in: the app owns one Authentik user per workshop, `automation@<testbed domain>` (for workshop N, `automation@nileworkshop-N.com`). Before each sign in the worker makes sure the user exists, is in the testbed's access group (the group the portal maps to Administrator), and has a new random password. The password is used for that one sign in and is never saved, so there is **no password file and no shared password** to set up. Nobody ever sees or sets it. The worker signs in with a headless Chromium, then makes plain API calls.

Set up, in this order:

1. **Testbed domain, group, and portal address.** Every testbed that gets a reset needs its **domain** set, its **Authentik group** (the marked group that carries the same domain, see [Testbed groups](#testbed-groups)), and its **Portal URL** on an allowed portal host (today only `nile-global.cloud`, kept in `lib/portal-reset/portal-hosts.json`). The domain must match the portal tenant, or the run stops with `tenant_mismatch` before it changes anything.

2. **The Authentik permissions.** The provisioning account needs `add_user`, `change_user`, `reset_user_password`, and `add_user_to_group`. `npm run authentik:setup` (a dry run) lists any that are missing. It has no delete permission, and the app never deletes an Authentik user.

3. **Check one workshop by hand (optional, recommended once).** This makes the user, signs in to the real portal, and reads one list. It prints only pass or fail, never the password or a reply. Run it with the dry run first:

   ```bash
   npm run portal:automation-check -- --domain nileworkshop-4.com
   npm run portal:automation-check -- --domain nileworkshop-4.com --apply
   ```

   If the workshop is not a testbed in the app yet, add `--group <access group name> --portal-url <portal address>`.

4. **The Nile Portal Reset page.** Sign in to the admin console and open **Nile Portal Reset**, then:
   - Check the list of portal calls. The first `npm run db:migrate` (the `migrate` container in Docker) loads the starting list from [db/seed/portal-reset-starting-list.json](db/seed/portal-reset-starting-list.json) and prints `seeded: N Nile Portal Reset steps`, so a fresh install already has the full list and you only review it. The order matters: a thing must come after everything that uses it. One rule is enforced: the step that deletes policy groups must come before the step that deletes segments, because the portal's API deletes a segment even while a group still uses it. A Save that breaks this is refused with a message on the segment step, and a saved list in that order is stopped at the start of a run (`invalid_list`).
   - Click **Edit**, confirm the pop up, type the **abort email** (where a stopped, held, or unfinished reset is reported), and press **Save**. Until this is saved, the page warns "Aborted resets will not be emailed."
   - Set the **mode**. **Off** means resets do not run. **Dry run** reads the portal and records what it would delete, but sends no write. **Live** deletes on real Nile Portals after every lab, and asks for a second confirm. **Start with a dry run**, look at it under **Recent resets**, then go live with the owner present.
   - To change a step, use its row: drag the handle (mouse, touch, or the keyboard) to move it, switch it off with **Enabled**, or edit its JSON. A step you removed can be brought back under **Add from starting list**.
   - Later deploys never overwrite your list or email, because the file is loaded once. Every change is in the Audit Log as a `portal_reset.*` entry.

**Recent resets.** The button on the Nile Portal Reset page opens the last 50 resets (when the lab ended, the testbed, the mode, the outcome and reason, and the counts). Open one to see each item it deleted, changed, or failed on, with the portal's own message. Records are kept 30 days. Items that are empty, system defined, already gone, or expected are not recorded.

**When a reset cannot finish.** The abort email says what happened and never holds a password or a token. A reset that cannot sign in because the account could not be prepared, or the password was refused, goes on **hold** and emails at once. It tries again after 30 minutes if no lab is on that testbed, and ends if a lab starts first. A lab that starts always stops a reset in progress.

Rules that cannot be changed from the page, because they live in the repo: a deny list (Global Settings Identity and Network Setup Users are never called) and the guards (the protected SSID, system policies, Nile RADIUS, Nile DHCP, and the Default Network Policy are never deleted). After the saved steps, a **discovery pass** opens the portal pages the steps name, finds short lists the steps do not cover, deletes what is in them, and reports each new route in the email so the list can catch up.

**Docker:** the worker runs from its own image target, `reservations-worker`, which is the app image plus Chromium (a few hundred MB more, only in the worker). `scripts/deploy.sh` builds both images. The worker launches Chromium once at start and **exits with code 1 if it cannot**, so a bad image is found at deploy: read `docker compose logs worker`. The container gets 1 GB of shared memory for the browser. One optional setting, `PORTAL_RESET_LANES` (1 to 5, default 2), sets how many resets run at once; it goes in `docker/.env`.

## Running with Docker

The app runs on this host as one Docker Compose project named `reservations`, with four services (the Postgres `db`, and three built from one Dockerfile: `web` and `migrate` share one image, `worker` has its own):

| Service | Runs | Notes |
| --- | --- | --- |
| `db` | `postgres:18.6-bookworm`, pinned by digest | The app's database, in the volume `hol_pgdata`. Published on `127.0.0.1` only. `migrate` starts after it is healthy |
| `migrate` | `node dist/migrate.mjs` | Applies new migrations, then exits. `web` and `worker` start only after it succeeds |
| `web` | `node server.js` (Next.js standalone) | Port 3000 inside the container, published only through Traefik. Healthcheck on `/api/health` |
| `worker` | `node dist/worker.mjs` | The one worker (`WORKER_ENABLED=true`). Its own image, `reservations-worker`, with Chromium for the Nile Portal reset. On stop it finishes its current step, with up to 60 seconds |

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

A rollback changes only the code. Migrations are never undone, which is why each migration must also work with the previous release. To restore the data itself, stop `web` and `worker`, then load the dump from before the deploy. This overwrites the current data, so be sure first. It runs as `postgres`, not `hol_app`, because the restore drops and recreates the two schemas and `hol_app` may not create them (as `hol_app` it fails halfway and leaves the schemas missing). The same command loads a dump from [Backups and disaster recovery](#backups-and-disaster-recovery) too:

```bash
docker compose -f docker/compose.yaml exec -T db \
  pg_restore -U postgres -d reservations --clean --if-exists --single-transaction --exit-on-error \
  < ~/backups/<dump file>
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

## Backups and disaster recovery

This section is the whole story of backing up the app and bringing it back. Read "How it works" once, then follow part A to set the backups up and part B when you need to rebuild. Spec: [0024](docs/specs/0024-backup-and-restore.md).

- [How it works](#how-it-works)
- [What is in a backup, and what is not](#what-is-in-a-backup-and-what-is-not)
- [Part A: Set up the backups](#part-a-set-up-the-backups)
- [Part B: Bring the app up on a new server from a backup](#part-b-bring-the-app-up-on-a-new-server-from-a-backup)
- [Part C: Get one deleted row back](#part-c-get-one-deleted-row-back-without-restoring-everything)
- [Reference: commands, files, messages](#reference-commands-files-and-messages)
- [Security notes and key rotation](#security-notes-and-key-rotation)

### How it works

There are two machines, and each has a different job.

| Machine | Called in this guide | What runs there | What it does |
| --- | --- | --- | --- |
| The server that runs the app (here `nova`, `10.1.255.18`) | **the app host** | [scripts/backup-remote.sh](scripts/backup-remote.sh) (part of this repo) | Passive. It runs only when the backup host connects, answers one of three questions, and exits. It only reads: it changes nothing on the app host. |
| A different machine that keeps the copies (here `nile`, `10.1.250.110`) | **the backup host** | [scripts/backup.sh](scripts/backup.sh) and [scripts/restore.sh](scripts/restore.sh) | Active. It decides when to back up, connects to the app host over SSH, pulls the data, encrypts it, stores it, and deletes old copies. |

The backup host **pulls**. The app host holds no key to the backups, so someone who breaks into the app host cannot delete or read them.

Nothing runs by itself until you add a cron job (part A, step 12). `backup.sh` does nothing except when someone, or cron, starts it.

**What one run of `backup.sh` does, for each server in the config:**

1. Takes a lock for that server, so two runs cannot overlap. If another run holds it, this one logs `another backup is running, skipping` and moves on.
2. Connects with the backup SSH key and runs `backup-remote.sh fingerprint` on the app host. The app host answers with two hashes: one of the secret files and `docker/.env`, and one of the database's write counters (insert, update, and delete counts per real table).
3. Compares them with the saved ones from the last backup (the file `.state` in the backup folder).
   - Both the same, and the last backup is younger than `force_after_days`: logs `unchanged` and stops. This takes about a second and moves no data. Most runs end here.
   - The secret files changed: it goes to step 4 (a secret changing is always a reason to back up).
   - Only the write counters changed: it goes to step 4 to find out if it matters.
   - No saved state, `--force`, or the last backup is `force_after_days` (7) days old or older: it backs up without asking more questions. (It still takes the content hash of step 4 on the way, only to save it for next time.)
4. Runs `backup-remote.sh contenthash`: a stable hash of the actual database contents, leaving out four tables that change all the time without anyone doing anything (`rate_limits`, `jobs`, `session`, `verification`). If it equals the saved one and the secret files did not change, it logs `unchanged (only noise changed)` and stops. So a worker tick or a sign in does not create a backup, but a new booking or an admin edit does.
5. Runs `backup-remote.sh archive`. The app host streams back one tar file: the database dump, the secret files, `docker/.env`, and a `MANIFEST` listing a checksum for each.
6. On the backup host, unpacks that tar into a temporary folder and checks it: the dump, the manifest, and the `secrets` folder are there, and every checksum matches. If not, it logs `the archive failed its check, nothing saved` and keeps nothing.
7. Encrypts the tar with age (using the public key from the config) to a temporary file, checks that file is not empty, then renames it to `hol-<server>-<UTC time>.tar.age`. The rename is last, so a half written file never looks like a backup.
8. Saves the new hashes in `.state`.
9. Deletes all but the newest `keep` (5) files for that server. Only files named exactly `hol-<server>-<time>.tar.age` are ever deleted.

Old backups are never overwritten: every backup is a new file with its own time in the name, and the oldest is deleted only after the new one is safely saved. The one exception is two backups in the same second (the name has one second resolution): the second would replace the first. Cron runs 15 minutes apart, so this can only happen if you run `--force` twice within a second. The small `.state` file is the only thing rewritten on every backup; it holds hashes, not data.

**Why two steps (2 to 4) before the dump?** The app is busy: the worker writes to the database every few seconds. A cheap question first (step 2) keeps the 15 minute checks light, and the content hash (step 4) is the final word on whether a real change happened.

### What is in a backup, and what is not

One backup is one file, for example `hol-prod-20261030T033026Z.tar.age` (the time is UTC). It is encrypted. Inside:

| In the backup | Detail |
| --- | --- |
| `db.dump` | A `pg_dump` (custom format) of the two schemas `hol_app` and `hol_auth`: bookings, users, testbeds and their types, API keys (the secret parts are already encrypted by the app), the audit log, jobs, email records, sign in sessions, Nile Portal reset settings and runs. |
| `secrets/` | **Every file** in the app host's secrets folder (`SECRETS_DIR`) except the skip list below. The six files the app cannot start without must exist, or the run fails with `required secret file missing`: `postgres_password`, `hol_app_password`, `auth_secret`, `hol_encryption_keys.json`, `authentik_client_secret`, `authentik_provisioning_token`. A new file you add to the folder is saved automatically and counts as a change. |
| `docker.env` | The app host's `docker/.env` (host name, `APP_URL`, `ADMIN_ENTRY_PATH`, Turnstile keys, Authentik client id, and so on). |
| `MANIFEST` | When it was made, the git commit the app was running, the web, worker, and database image names, the last migration applied, the secrets folder path, and a SHA-256 checksum of every file above. |

**Skip list** (in `scripts/backup-remote.sh`, the `skip` array): `authentik_master_token` (delete it after setup anyway), `hol-test-*` (end to end test logins), `*.stale`, `*.old-*`, and any file starting with a dot. **Everything else in the folder is saved**, so do not keep unrelated passwords (for other machines, for example) in the secrets folder.

**Not in a backup, because they live outside this app:**

| Not backed up | What to do on a new server |
| --- | --- |
| **Authentik itself**: the `hol` app and providers, the `hol_testbed_group` groups, the learners' accounts and passwords, the provisioning account | Point the new server at the same Authentik. If Authentik is also gone, rebuild it first (step 5 of "Getting the webapp running"), recreate your groups, and expect new client secret files. |
| **Cloudflare**: the Tunnel, DNS, Access apps, the HOL Labs login method | Point the Tunnel's host name at the new Traefik (see "Running with Docker", step 1). |
| **Traefik** and the Docker network named `traefik` | Install Traefik, or at least create the network. |
| **The Turnstile widget** | Its keys are in `docker/.env` (so they are in the backup). The widget must allow the new host name. |
| **The Docker images** | Rebuilt by `scripts/deploy.sh` from the git commit. |

### Part A: Set up the backups

You do this once. It takes about 20 minutes. The example values are this project's; replace them with yours.

| Name used below | Example | Meaning |
| --- | --- | --- |
| app host | `nova` at `10.1.255.18`, user `nova` | The server running the app. |
| backup host | `nile` at `10.1.250.110`, user `nile` | The machine that keeps the backups. It must be able to reach the app host on port 22. |
| `<app-user>` | `nova` | The Linux user that owns the repo on the app host and can run `docker compose`. |
| `<backup-user>` | `nile` | The Linux user on the backup host that runs the backups. |

**Step 1. Check what each machine needs.**

On the **backup host**, run:

```bash
for c in bash ssh tar flock sha256sum age age-keygen; do command -v $c >/dev/null && echo "ok       $c" || echo "MISSING  $c"; done
bash --version | head -1
```

You need bash 4 or later (any current Linux has it). If `age` is missing, install it from your package manager (`sudo apt install age` on Ubuntu or Debian). If you want to run the restore check (step 14) on this machine, it also needs Docker (`docker --version`).

On the **app host**, `<app-user>` must be able to run Docker without sudo, which `scripts/deploy.sh` already needs:

```bash
docker compose -f ~/reservations/docker/compose.yaml ps     # lists the containers, with no permission error
```

**Step 2. Put the scripts on the backup host.** The backup host needs only the repo's `scripts/backup.sh`, `scripts/restore.sh`, and `backup/backup.conf.example`. The easiest way is to clone the repo there:

```bash
git clone <repo url> ~/hol
cd ~/hol
```

(If you do not want a full clone, copy just those three files, keeping the folders `scripts/` and `backup/`, and run `chmod +x scripts/*.sh`.) All the commands from here on, "on the backup host", run from this folder.

**Step 3. Make the age key pair (on the backup host).** age is the encryption. The *public* key encrypts and can sit on any machine. The *private* key decrypts and is the only thing that can open a backup.

```bash
age-keygen -o ~/hol-backup-age.key
chmod 600 ~/hol-backup-age.key
```

It prints one line, like `Public key: age1rqurpwtq9hyc82n5hpwtfs0u3ha63t0ldjam2j9mcz4cd8w5pfgqzgd2dd`. **Copy that `age1...` value**: it goes into the config in step 9. The file `~/hol-backup-age.key` holds the private key (a line starting `AGE-SECRET-KEY-`).

> **Do this now, before you rely on any backup:** copy `~/hol-backup-age.key` somewhere safe and offline in at least two places (a password manager entry plus an offline copy, for example). If you lose it, **every backup is unreadable and nothing can recover them**. If it leaks, every backup can be opened. For real use, then delete it from the backup host; the host only needs the public key. You will bring the private key back only for a restore.

**Step 4. Make the SSH key used only for backups (on the backup host).**

```bash
ssh-keygen -t ed25519 -N '' -C hol-backup -f ~/.ssh/hol_backup_ed25519
cat ~/.ssh/hol_backup_ed25519.pub
```

`-N ''` means no passphrase, because cron cannot type one. That is why step 5 locks the key down hard. The command creates two files: the private key `~/.ssh/hol_backup_ed25519` (never copy it anywhere) and the public key `~/.ssh/hol_backup_ed25519.pub`, which is the single line `ssh-ed25519 AAAA... hol-backup` that `cat` printed. Copy that line.

**Step 5. Allow that key on the app host, with a lock on it.** On the **app host**, as `<app-user>`, add one line to the end of `~/.ssh/authorized_keys` (create the file with mode `600` if it is not there). The line is the word list below, then the public key from step 4:

```text
restrict,command="/home/nova/reservations/scripts/backup-remote.sh" ssh-ed25519 AAAA... hol-backup
```

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
# then paste the line above (with your real path and key) as the last line of the file
```

What the two words in front do:

- `command="..."`: whatever the key's owner asks to run, the server runs *this script instead*. The script accepts only `fingerprint`, `contenthash`, or `archive` (it reads the last word of what was asked) and prints a usage line for anything else.
- `restrict`: turns off a shell, terminals, port forwarding, and agent forwarding for this key.

The path in `command=` must be the real absolute path of `backup-remote.sh` on the app host, and it must be the same repo folder you put in `repo_dir` in step 9.

**Step 6. Trust the app host's identity (on the backup host).** The backup host must know the app host's host key, so a stranger answering on that address cannot receive your data. Fetch it, and *check the fingerprint* against the app host itself before saving:

```bash
ssh-keyscan -t ed25519 10.1.255.18 > /tmp/apphost.key
ssh-keygen -lf /tmp/apphost.key           # the fingerprint the backup host sees
```

On the **app host**, run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. The two lines must show the same `SHA256:...` value. If they match:

```bash
cat /tmp/apphost.key >> ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts
rm /tmp/apphost.key
```

(The backup script uses `StrictHostKeyChecking=yes`: if the host is not in `known_hosts`, or its key changed, it refuses to connect.)

**Step 7. Test the key (on the backup host).** Run these three tests. Replace `nova@10.1.255.18` and the path with yours.

```bash
K="-i $HOME/.ssh/hol_backup_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

# 1. The allowed question. Expect two lines, secrets=<64 hex digits> and stats=<64 hex digits>:
ssh $K nova@10.1.255.18 /home/nova/reservations/scripts/backup-remote.sh fingerprint

# 2. Any other command. Expect only: usage: backup-remote.sh fingerprint | contenthash | archive
ssh $K nova@10.1.255.18 "ls /"

# 3. A shell. Expect the same usage line, and no prompt:
ssh $K nova@10.1.255.18
```

If test 1 fails, see "Messages and what they mean" at the end. Do not go on until it prints the two hashes.

**Step 8. Make the folder that will hold the backups (on the backup host).** Pick an absolute path with room for roughly 5 files per server (about 250 KB each today; they grow with the data):

```bash
mkdir -p ~/hol-backups && chmod 700 ~/hol-backups
```

**Step 9. Write the config (on the backup host).**

```bash
cp backup/backup.conf.example backup/backup.conf
chmod 600 backup/backup.conf
```

Edit `backup/backup.conf` so it has one block for the server. The file is gitignored (it names your servers). Lines starting with `#` are comments. Keys before the first `[section]` are defaults for every server; a key inside a block wins over a default.

```text
keep = 5
force_after_days = 7

[prod]
ssh_host = nova@10.1.255.18
ssh_key = ~/.ssh/hol_backup_ed25519
repo_dir = /home/nova/reservations
dest_dir = /home/nile/hol-backups/prod
age_recipient = age1rqurpwtq9hyc82n5hpwtfs0u3ha63t0ldjam2j9mcz4cd8w5pfgqzgd2dd
```

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `[name]` | yes | | The server's name: letters, digits, `-` and `_` only. It is part of every file name (`hol-<name>-<time>.tar.age`), so do not rename it later or the old files stop counting toward `keep`. |
| `ssh_host` | yes | | `user@address` of the app host. |
| `ssh_key` | yes | | The private key from step 4. `~` means the backup user's home. |
| `ssh_port` | no | `22` | The app host's SSH port. |
| `repo_dir` | yes | | The repo folder **on the app host**. The script runs `<repo_dir>/scripts/backup-remote.sh` there. |
| `dest_dir` | yes | | Where this server's backups go, **on the backup host**. Must be an absolute path (starting with `/` or `~`). Made with mode `700` if it does not exist. Give each server its own folder. |
| `age_recipient` | yes | | The *public* key from step 3 (starts `age1`). Anything else is refused. |
| `keep` | no | `5` | How many backups to keep per server. A whole number from 1. |
| `force_after_days` | no | `7` | Back up at least this often even if nothing seems to have changed. `0` means every run. |
| `on_failure_cmd` | no | none | A shell command to run when this server's backup fails (to send an email or a message). The variable `BACKUP_SERVER` holds the server's name. |

To back up a **second server**, add another block below the first, with its own name, address, `repo_dir`, and `dest_dir`. Repeat steps 4 to 7 for it (you can reuse the same SSH key and age key, or make new ones).

**Step 10. Dry run (on the backup host).** This asks the app host what changed and saves nothing:

```bash
scripts/backup.sh --dry-run
```

```text
2026-10-30T03:22:45Z prod: would back up (first run)
```

If it prints an error instead, go to "Messages and what they mean".

**Step 11. First real backup, and a repeat.**

```bash
scripts/backup.sh
scripts/backup.sh
scripts/backup.sh --list
```

```text
2026-10-30T03:22:47Z prod: backing up (first run)
2026-10-30T03:22:48Z prod: saved hol-prod-20261030T032247Z.tar.age (246008 bytes)
2026-10-30T03:22:49Z prod: unchanged
prod (/home/nile/hol-backups/prod):
  hol-prod-20261030T032247Z.tar.age  246008 bytes
```

The first run saves a file. The second one must say `unchanged` and add nothing. Now prove it notices changes: add or edit a file in the app host's secrets folder, or change something in the admin console, and run `scripts/backup.sh` again. It logs `backing up (secret files changed)` or `backing up (database changed)` and saves a new file. A forced backup ignores all checks:

```bash
scripts/backup.sh --force
```

**Step 12. Schedule it (on the backup host).** Open the crontab with `crontab -e` and add:

```cron
*/15 * * * * cd /home/nile/hol && scripts/backup.sh >> /home/nile/hol-backup.log 2>&1
```

This runs a check every 15 minutes. Almost all of them end in `unchanged` after a second. Use your real path. Cron has a short `PATH`: if `age` is not in `/usr/bin` (you put it in `~/bin`, say), add a line `PATH=/home/nile/bin:/usr/local/bin:/usr/bin:/bin` above the job. Confirm the job is saved with `crontab -l`, and after 15 minutes look at the end of the log:

```bash
tail -n 20 /home/nile/hol-backup.log
```

**Does it survive a reboot?** Yes. The crontab is saved on disk and the `cron` service starts at boot. Check that the service is set to start on this machine with `systemctl is-enabled cron` (it should print `enabled`) and `systemctl is-active cron` (`active`). Two limits to know: cron does **not** catch up on runs missed while the machine was off or `cron` was stopped (the next scheduled run simply does a normal check, and if the last backup is `force_after_days` old or older it forces one), and a machine that is down cannot pull anything. To remove the schedule later, run `crontab -e` and delete the line (`crontab -r` removes the whole crontab).

Every log line starts with a UTC time. To stop the log growing forever, add a rotation file, for example `/etc/logrotate.d/hol-backup` with `weekly`, `rotate 8`, `compress`, `missingok`, and `notifempty` for `/home/nile/hol-backup.log`.

**Step 13. Know it is working.** A failed server logs a line with the reason and the whole run exits with status 1 (cron mails the owner if mail is set up on the box). Set `on_failure_cmd` for something louder. Every few days, glance at the list:

```bash
scripts/backup.sh --list
```

Healthy means the newest file is at most `force_after_days` old, since a backup is forced that often. Newest file older than that means backups have stopped: look at the log.

**Step 14. Prove a restore works (monthly, on any machine with Docker).** A backup you have never restored is a guess. Put the age private key and one backup file on a machine with Docker and run:

```bash
scripts/restore.sh hol-prod-<time>.tar.age --identity /path/to/hol-backup-age.key --verify
```

It decrypts the file, checks the checksums, starts a temporary Postgres (the exact image named in the manifest, so the first run downloads it), loads the dump, prints each table's row count, and removes the container. It changes nothing else on the machine. The last line must say `verify ok`. Compare a table's count (say `hol_app.bookings`) with the real app. Then delete the private key from that machine again.

### Part B: Bring the app up on a new server from a backup

Use this when the app host is gone, or you are moving to a new one. You need three things in hand: **the backup file** (on the backup host, in `dest_dir`), **the age private key** (from your offline copy), and **access to the same Authentik**. Allow about an hour.

> **Never run `restore.sh` on a server that is serving traffic right now, and never with `--yes` unless you mean it.** A real restore stops `web` and `worker` and *replaces* the whole database on the machine where it runs. The only safe command on a live server is `--verify`.

**Step 1. Decide about the old server.** If the old app host is still running, stop its worker **before** you start the new one:

```bash
docker compose -f docker/compose.yaml stop worker      # on the OLD server
```

Why: the worker's lock is per database. Two workers on two databases both run, so you get duplicate booking emails and calendar events, two Nile Portal resets, and two programs changing the same Authentik groups. Better still, stop the old `web` too, so nobody books into the old copy.

**Step 2. Prepare the new server.** It needs:

| Need | How to check |
| --- | --- |
| Docker Engine with Compose v2, and your user able to run `docker` without sudo | `docker compose version` and `docker ps` |
| A user with uid `1000` (the containers run as uid 1000 and must read the secret files) | `id -u` |
| Node 24 and npm (the restore starts the database with `npm run db:up`) | `node --version` |
| git | `git --version` |
| `age` (the restore decrypts with it) | `age --version` |
| A Traefik container on an external Docker network named `traefik` | `docker network inspect traefik`; if it is missing, `docker network create traefik` (the app will not be reachable until Traefik is really running) |

**Step 3. Get the code.**

```bash
git clone <repo url> reservations
cd reservations
npm install
```

Use a checkout that is the backup's git commit **or newer**. Migrations only go forward: newer code upgrades older data when it starts, but older code refuses newer data. The restore tells you the backup's commit and whether this checkout includes it.

**Step 4. Bring the backup file and the key to the new server.** From a machine that can reach both (the age key from your offline copy):

```bash
scp backuphost:/home/nile/hol-backups/prod/hol-prod-<newest>.tar.age ~/
# on the backup host, "ls -t /home/nile/hol-backups/prod" lists newest first
```

Put the age private key at `~/hol-backup-age.key` and run `chmod 600 ~/hol-backup-age.key`. You will delete both at the end (step 13).

**Step 5. Look inside first (changes nothing).**

```bash
scripts/restore.sh ~/hol-prod-<time>.tar.age --identity ~/hol-backup-age.key --verify
```

You should see the header with the backup's details, then a table of row counts, then `verify ok`. This needs Docker (it runs a throwaway Postgres):

```text
decrypting hol-prod-20261030T033026Z.tar.age
checking every file against the manifest

backup made    2026-10-30T03:30:26Z
git commit     18b9fba7fcabd381ae411162f963a49b5d4bcdaf
web image      reservations:sha-c3bb72a
database       postgres:18.6-bookworm@sha256:bbf83594...
last migration 0019_portal_reset_runs
secrets were   /home/nova/secrets
...
verify ok: the archive decrypts, matches its manifest, and the dump restores.
```

If it says `could not decrypt (wrong key, or a damaged file)`, the key is the wrong one or the file is damaged: try the other backups on the backup host. If it says `a file does not match the manifest`, the file was damaged in transit: copy it again, or use the previous one.

**Step 6. Restore for real.**

```bash
scripts/restore.sh ~/hol-prod-<time>.tar.age --identity ~/hol-backup-age.key --secrets-dir ~/secrets
```

Use `--secrets-dir` to say where the secret files should go on this server. Leave it out to use the folder the old server had (`SECRETS_DIR` in the backed-up `docker/.env`). What happens, in order:

1. Decrypts and checks the checksums, and prints the backup's details (as in step 5).
2. Writes `docker/.env` from the backup. If you gave `--secrets-dir`, it sets the `SECRETS_DIR=` line to that path. It prints `wrote docker/.env`.
3. Creates the secrets folder (mode `700`) and writes every secret file into it with mode `600`. It prints `wrote N secret files to <folder>`.
4. If a file already exists with different contents, it stops with `<file> already exists and differs. Check it, then rerun with --overwrite`. Look at the file first. Add `--overwrite` only if replacing it is right. Rerunning with the same options when files already match is fine.
5. Prints `ok: this checkout includes the backup's commit`, or a `WARNING` that it does not (then run `git pull` before deploying).
6. Prints a note if `docker/compose.yaml` pins a different Postgres image than the backup came from.
7. Prints `This replaces everything in the hol_app and hol_auth schemas...` and waits. **Type `restore` and press Enter** to go on (anything else cancels; the files written above stay). `--yes` skips this question.
8. Stops `web` and `worker` if they are running, starts the database (`npm run db:up`: it also creates the `hol_app` role from the `hol_app_password` file), then loads the dump with `pg_restore` as the `postgres` user inside the container, in one transaction.
9. Prints `database restored.` and the next steps. **It never starts web or the worker.**

If `pg_restore` fails, nothing was changed (it runs in a single transaction and rolls back), so you can fix the cause and rerun.

**Step 7. Fix the settings that depend on this server.** Open `docker/.env` and check:

| Variable | Set it to |
| --- | --- |
| `SECRETS_DIR` | The folder from step 6 (absolute path). |
| `APP_HOST` | The public host name of the new server, if it changed. |
| `APP_URL` | `https://` plus `APP_HOST`, exactly as visitors type it. If this is wrong, sign in fails with `state_mismatch`. |
| `DB_HOST_PORT` | Only if port 5432 is already taken on this machine. |

**Step 8. Check the secret files are there (names only, never contents).**

```bash
for f in postgres_password hol_app_password auth_secret hol_encryption_keys.json \
  authentik_client_secret authentik_provisioning_token; do
  [ -s ~/secrets/$f ] && echo "ok       $f" || echo "MISSING  $f"
done
```

Use your real secrets folder in place of `~/secrets`. All six must say `ok`.

**Step 9. Make sure the code is new enough, then build and start the web app.**

```bash
git pull
npm install
scripts/deploy.sh web
```

`deploy.sh web` builds the two images (a few minutes: the worker image includes Chromium), applies any new migrations, and starts `migrate` and `web` but **not the worker**. It also writes a fresh pre deploy dump into `~/backups`.

**Step 10. Start the worker, only when step 1 is true.**

```bash
docker compose -f docker/compose.yaml up -d worker
```

**Step 11. Point traffic at the new server.** In Cloudflare Zero Trust, change the Tunnel's public host name to the new Traefik, or update DNS. If `APP_URL` changed, add the new URL to the Authentik provider's redirect URIs by running step 5 of "Getting the webapp running" again with `APP_URLS=<new url>`; without it, sign in fails with a redirect URI error. Check the Turnstile widget allows the new host name.

**Step 12. Check that it works.**

```bash
docker compose -f docker/compose.yaml ps          # web shows (healthy); worker is Up
curl -s https://<APP_HOST>/api/health             # {"status":"ok","db":"ok"}
docker logs reservations-migrate-1 | tail         # "nothing to apply", or the migrations it applied
docker logs reservations-worker-1 | tail          # "worker: started"
```

Then in a browser: sign in as an admin at `https://<APP_HOST><ADMIN_ENTRY_PATH>`; open the bookings list and confirm the newest booking is there; open the API Keys page and confirm every key still shows as saved (if the keyring file is wrong, saving or testing a key says it cannot be decrypted); and make one test booking to see that the email arrives.

**Step 13. Clean up.** Delete the temporary copies from the new server, so the key is not left lying around:

```bash
rm -f ~/hol-prod-<time>.tar.age ~/hol-backup-age.key
```

Then set up backups for this new server (part A) so it is protected too.

**If something goes wrong halfway.** The old server and the backup file are untouched, so you can start again. To wipe a half finished restore on the new machine and begin at step 6: `docker compose -f docker/compose.yaml down` (keeps the volume) and rerun `restore.sh` (it replaces the whole database each time). To throw the new machine's database away completely, `docker compose -f docker/compose.yaml down -v`, which also deletes the volume `hol_pgdata`: only do that on a machine that has nothing of value.

**Restoring into the same server** (for example a bad migration, or an admin deleted a lot): use the same steps 5 and 6, skipping 1 to 4, but remember a real restore replaces *all* data back to the time of the backup: bookings made since are lost. For a single deleted row, use part C instead.

### Part C: Get one deleted row back (without restoring everything)

Example: an admin deleted a testbed type and wants it back. The newest backup before the deletion still has it. This is manual and read only for the live app: you load the backup into a throwaway database, find the row, and copy it back by hand.

1. Copy the backup file from *before* the deletion and the age private key to a scratch folder on a machine with Docker, then decrypt and unpack:

   ```bash
   mkdir -p ~/scratch && cd ~/scratch
   age -d -i ~/hol-backup-age.key -o plain.tar ~/hol-prod-<time>.tar.age
   tar -xf plain.tar ./db.dump ./MANIFEST
   grep -E '^db_image=' MANIFEST
   ```

2. Start a throwaway Postgres from the image in that last line (replace `<db_image>` with the part after `db_image=`), and load the dump:

   ```bash
   docker run -d --rm --name hol-scratch -e POSTGRES_PASSWORD=x -e POSTGRES_DB=reservations \
     --tmpfs /var/lib/postgresql <db_image>
   sleep 8
   docker exec -i hol-scratch psql -h 127.0.0.1 -U postgres -d reservations \
     -c "create role hol_app login; create extension if not exists btree_gist;"
   docker exec -i hol-scratch pg_restore -h 127.0.0.1 -U postgres -d reservations < db.dump
   ```

3. Look at the row (here the soft deleted testbed types; `deleted_at` is set when an admin deletes one):

   ```bash
   docker exec -it hol-scratch psql -h 127.0.0.1 -U postgres -d reservations \
     -c "select * from hol_app.testbed_types order by name;"
   ```

4. Re create the row in the live app using the admin console with the values you see (this is safest, since the app also writes the audit log), or, if you must, copy the row with SQL into the live database. If a soft deleted row simply still exists in the live database with `deleted_at` set, an admin may be able to restore it without any of this.

5. Remove the scratch pieces:

   ```bash
   docker stop hol-scratch
   rm -rf ~/scratch
   ```

### Reference: commands, files, and messages

**`scripts/backup.sh`** (backup host)

| Option | Meaning |
| --- | --- |
| *(none)* | Back up every server in the config that needs it. |
| `--config FILE` | Use this config instead of `backup/backup.conf`. |
| `--server NAME` | Only that server. An unknown name is an error. |
| `--force` | Back up even if nothing changed. |
| `--dry-run` | Ask the app host what changed, say what it would do, save nothing. |
| `--list` | List the saved backups per server and their sizes. |

Exit status: `0` all fine (including `unchanged`), `1` at least one server failed (or a config or option problem), `2` bad option.

**`scripts/restore.sh BACKUP.tar.age --identity KEY`** (the machine being rebuilt)

| Option | Meaning |
| --- | --- |
| `--verify` | Restore into a throwaway Postgres and print row counts. Changes nothing else. |
| `--secrets-dir DIR` | Where to put the secret files (also written into `docker/.env`). |
| `--overwrite` | Replace secret files or `docker/.env` that already exist and differ. |
| `--yes` | Do not ask you to type `restore`. |

**`scripts/backup-remote.sh`** (app host, called over SSH by the backup key): `fingerprint`, `contenthash`, `archive`. It reads only.

**Where things live**

| Path | Machine | What |
| --- | --- | --- |
| `scripts/backup.sh`, `scripts/restore.sh`, `backup/backup.conf` | backup host | The active scripts and the config |
| `<dest_dir>/hol-<server>-<UTC time>.tar.age` | backup host | The encrypted backups (newest `keep` kept) |
| `<dest_dir>/.state` | backup host | The hashes of the last backup (delete it to force the next run) |
| `<dest_dir>/.lock` | backup host | The lock file; harmless |
| `~/.ssh/hol_backup_ed25519` | backup host | The backup SSH private key |
| age private key (offline) | **not on a server** | The only thing that opens a backup |
| `scripts/backup-remote.sh` | app host (in the repo) | The three read only questions |
| the `restrict,command=` line in `~/.ssh/authorized_keys` | app host | The locked down backup key |

**Everything on the backup host, at a glance** (example for user `nile`, with the scripts cloned or copied to `~/hol`):

```text
/home/nile
├── hol/                              the scripts and config
│   ├── scripts/backup.sh             does the backups (cron runs it)
│   ├── scripts/restore.sh            restore and verify (you run it)
│   ├── backup/backup.conf            your config (mode 600, gitignored, no secrets in it)
│   └── backup/backup.conf.example    the template it was copied from
├── hol-backups/                      mode 700
│   └── prod/                         one folder per server (its dest_dir)
│       ├── hol-prod-<UTC time>.tar.age   the encrypted backups, newest 5 kept
│       ├── .state                    4 lines of hashes and the last backup time
│       └── .lock                     empty file that stops two runs at once
├── hol-backup.log                    what cron's runs printed (rotate it)
├── hol-backup-age.key                the age PRIVATE key: keep it offline, not here, for real use
└── .ssh/
    ├── hol_backup_ed25519            the backup SSH private key (mode 600)
    ├── hol_backup_ed25519.pub        its public half (also in the app host's authorized_keys)
    └── known_hosts                   includes the app host's host key
```

Not on the backup host: the app, the database, the Docker containers, the live secrets, and any unencrypted copy of the data (a working copy exists only during a run and is deleted). Anyone who gets the `.tar.age` files alone has nothing useful; anyone who also has the age private key can read everything.

**Messages and what they mean**

| Message | Meaning and fix |
| --- | --- |
| `prod: unchanged` | Nothing changed since the last backup. Normal. |
| `prod: unchanged (only noise changed)` | Only the busy tables moved. Normal. |
| `prod: backing up (first run)` or `(forced)` or `(weekly safety net)` or `(secret files changed)` or `(database changed)` | The reason a backup was taken. |
| `prod: saved hol-...tar.age (N bytes)` | Success. |
| `prod: removed old backup ...` | Pruning to `keep`. |
| `Permission denied (publickey)` | The public key line is not in `authorized_keys` on the app host (for that user), or `ssh_key` points to the wrong file, or `authorized_keys` has the wrong permissions (`600`; the `.ssh` folder `700`). |
| `Host key verification failed` | The app host is not in `known_hosts` on the backup host (redo step 6), or its key changed. If the server was rebuilt, confirm that, then remove the old line with `ssh-keygen -R <address>` and redo step 6. |
| `Connection timed out` | A firewall: the backup host cannot reach the app host on the SSH port. |
| `prod: fingerprint failed` | The SSH call failed: run the step 7 test by hand to see the real error. |
| `usage: backup-remote.sh ...` printed when you expected hashes | The command sent was not exactly `fingerprint`, `contenthash`, or `archive`; check `repo_dir`. |
| `backup-remote: required secret file missing: X` | One of the six required files is gone from the app host's secrets folder. The backup is skipped until it is back. |
| `backup-remote: pg_dump wrote nothing` | The database container is down or unhealthy on the app host. Check `docker compose ps`. |
| `prod: the archive failed its check, nothing saved` | The data pulled was incomplete or damaged. Nothing was kept; the next run tries again. |
| `prod: encryption failed` | `age` is missing, not in cron's `PATH`, or the `age_recipient` is not a real public key. |
| `prod: age_recipient must be an age public key (age1...)` | The config value is wrong. Use the `Public key:` line from step 3. |
| `prod: dest_dir must be an absolute path` | Write the full path starting with `/`. |
| `prod: another backup is running, skipping` | A previous run still holds the lock. Normal if one is slow; if it never ends, check for a stuck `backup.sh` process. |
| `backup: cannot read config ...` | The config path is wrong or the file is not readable. |
| `backup: bad config line: ...` | A line in the config is not `key = value`, `[section]`, or a comment. |
| `backup: no server named 'X'` | `--server` does not match any `[section]`. |
| `restore: could not decrypt (wrong key, or a damaged file)` | Wrong age private key, or the file is damaged. Try another backup. |
| `restore: a file does not match the manifest: the backup is damaged` | The file changed after it was made. Copy it again or use an older one. |
| `restore: <file> already exists and differs...` | See part B, step 6, item 4. |
| `restore: pg_restore failed: the dump is not restorable` | (`--verify`) The dump is broken; use another backup and tell the owner. |
| `WARNING: this checkout does not include the backup's commit` | `git pull` before you deploy, or `migrate` will refuse the newer database. |
| `state_mismatch` at sign in | `APP_URL` does not match the address in the browser, or the new URL is not in the Authentik redirect URIs. |
| A saved API key cannot be decrypted | `hol_encryption_keys.json` is not the one from the backup, or `APP_ENCRYPTION_ACTIVE_KEY_ID` in `docker/.env` is wrong. |
| `bind: address already in use` for port 5432 | Another Postgres is on the machine. Set `DB_HOST_PORT` in `docker/.env`. |
| `network traefik declared as external, but could not be found` | `docker network create traefik`, or start your Traefik first. |

### Security notes and key rotation

- **Plaintext only in transit and briefly in temporary folders.** The backup is encrypted before it is stored. While it is being pulled it is inside the SSH connection, and for a moment it sits unencrypted in a mode `700` temporary folder on the app host and one on the backup host; both are removed when the run ends.
- **The backup SSH key can only run three read only questions** on the app host, because of the `restrict,command=` line. If it is stolen, the thief can read the data the backup would contain (they can ask for `archive`), so treat the backup host like the app host: keep it patched, limit who can log in, and protect `~/.ssh/hol_backup_ed25519` (mode `600`).
- **The age private key is the crown jewel.** Nothing in the repo or on any server needs it except during a restore.
- **No secret value is written to either script's log.** Secret file *names* appear in errors, never contents.
- **`backup/backup.conf` is gitignored** and holds server addresses and the *public* age key. A test checks that only the `.example` is tracked.
- **Rotate the age key** (suspected leak, or a person leaves): make a new key pair (step 3), put the new public key in `age_recipient`, run `scripts/backup.sh --force`. New backups use the new key. **Old backups still need the old private key**, so keep it until those files are gone (5 backups later), then destroy it.
- **Rotate the SSH key**: make a new one (step 4), add its line to `authorized_keys` on the app host (step 5), change `ssh_key` in the config, run `scripts/backup.sh --dry-run`, then delete the old line from `authorized_keys`.
- **If you move the backup host**, copy `backup/backup.conf`, the SSH key, and the backup folder, and redo step 6 on the new host.
- **If a secret in the folder is rotated** (for example a new `authentik_provisioning_token`), the next run sees the file changed and takes a new backup within 15 minutes, with no action from you.

## Appendix A: Creating the Google service account (hand-off for a Workspace admin)

Give this appendix to the person who administers your Google Workspace. It makes the service account that [step 8](#service-account-google-workspace-for-production) uses. The app sends booking emails from one mailbox and writes events to one shared calendar, with nobody signing in, using domain wide delegation. You need a Workspace **Super Admin** and a Google Cloud project in the company organization.

Values below use placeholders. Replace `example.com` and the names with your own.

| Item | Example |
| --- | --- |
| Cloud project | `hol-reservations` |
| Service account | `hol-reservations-mailer` |
| Sender mailbox (the user the app acts as) | `hol-sender@example.com` |
| Shared calendar | `HOL bookings` |

### A.1 Create the project and enable the APIs

1. In <https://console.cloud.google.com>, create a new project in the company organization and select it.
2. *APIs & Services* → *Library*: enable the **Gmail API**, then the **Google Calendar API**.

### A.2 Create the service account and its key

1. *IAM & Admin* → *Service Accounts* → **Create service account**. Name it `hol-reservations-mailer`.
2. **Grant no IAM role** and skip "Grant users access". The account needs no Google Cloud permissions, because delegation is granted in the Admin console.
3. Open the account and copy its **Unique ID** (the client ID, about 21 digits).
4. *Keys* → *Add key* → *Create new key* → **JSON**. The file downloads once. Treat it like a password.
5. If key creation is blocked, the organization policy `iam.disableServiceAccountKeyCreation` is on. A Cloud Organization Policy Administrator must switch it off for this project.

### A.3 Authorize domain wide delegation (Super Admin)

1. In <https://admin.google.com>: *Security* → *Access and data control* → *API controls* → **Manage Domain Wide Delegation** → **Add new**.
2. Client ID: the Unique ID from A.2.
3. OAuth scopes, exactly these two and nothing else:

   ```
   https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.events
   ```

4. **Authorize**. It can take a few minutes, occasionally up to 24 hours, to take effect.

### A.4 Prepare the sender mailbox and calendar

1. Use a **dedicated, non-admin** Workspace user with a Gmail license, for example `hol-sender@example.com`. No admin roles, not a person's own mailbox, no delegates, no forwarding, a strong unique password, and 2-Step Verification.
2. As that user, create a calendar named `HOL bookings` (*Other calendars* → *Create new calendar*). The user must own it.
3. *Settings and sharing* → *Integrate calendar*: copy the **Calendar ID** (it ends in `@group.calendar.google.com`).
4. Do not share the calendar publicly or with the whole organization. Share it only with the named people who need to see bookings, view only.

### A.5 What to hand back

Send these over a secure channel (the key not by plain email):

1. The JSON key file.
2. The sender mailbox address.
3. The Calendar ID.

Then follow [step 8](#service-account-google-workspace-for-production) to add the `GOOGLE` API key.

### A.6 Least-privilege checklist

- **Exactly two scopes** (A.3). Never use `mail.google.com`, `gmail.modify`, `gmail.readonly`, `calendar`, or any Drive, Directory, or Admin scope. `gmail.send` can only send; it cannot read, search, or delete mail.
- **No IAM roles** on the service account, in the project or the organization.
- **A dedicated Cloud project** that holds nothing else, with only the Gmail and Calendar APIs enabled.
- **One key only.** Create a single JSON key, hand it over once, and delete every local copy. Set a key expiry if your policy supports it, and review the key yearly.
- **No memberships.** Do not add the service account to any Google Group, shared drive, or other Workspace resource.
- **Delegation is per domain, not per user.** Google cannot limit it to one mailbox, so the two scopes technically apply to every user in the domain. This is why the scope list must stay minimal and the key guarded. The app only ever acts as the sender mailbox.
- **Monitoring (recommended).** In the Admin console, *Reporting* → *Audit and investigation* → *Gmail log events* and *Calendar log events*, add an alert for sends from any account other than the sender mailbox.

To revoke access, delete the delegation entry (A.3) or delete the key (A.2).

### A.7 Troubleshooting

| Error | Usual cause |
| --- | --- |
| `unauthorized_client` | Delegation entry missing, wrong Client ID, or scopes not exactly as listed. Wait a few minutes and recheck A.3 |
| `invalid_grant` | The sender mailbox doesn't exist, is suspended, or has no Gmail license |
| Key creation disabled | An organization policy blocks keys (A.2, step 5) |
| 403 on the calendar | The sender mailbox lacks edit rights on `HOL bookings` (A.4, step 2) |
