# 0024. Pull based encrypted backups with a scripted restore

**Date**: 2026-10-29
**Status**: Accepted

## Summary

A script on a separate backup server pulls a full copy of the app (database, secret files, and `docker/.env`) over SSH with a key, encrypts it, and keeps the newest 5 copies per server. It only takes a new copy when something real changed, plus once a week as a safety net. A second script puts a copy back on a new server, so recovery is: clone the repo, fetch the backup file, run the restore, deploy. Both scripts are already built on branch `feat/backup-script`; this spec records the decisions behind them.

## Context

The app keeps its state in three places: the Postgres volume (schemas `hol_app` and `hol_auth`), the secret files in `SECRETS_DIR`, and `docker/.env`. Losing the encryption keyring makes every saved API key unreadable, and losing the database loses every booking. Before this work the only copy was the pre deploy `pg_dump` that `scripts/deploy.sh` writes into `~/backups` on the same machine, with no retention and nothing off the host.

The owner wants backups of one or more servers, over SSH, with keys and never passwords. A backup should happen only when something changed (a secret file, new reservations, admin settings). A copy should hold everything needed to rebuild: someone clones the repo on a new server, fetches the backup, and gets the app running. Only the last 5 copies are kept.

Constraints: the worker changes real Authentik groups and sends real email, so a restored copy must never start by accident next to the old one. The app already runs in Docker Compose with a digest pinned Postgres image. The backup server should not need Node.

## Requirements

**User stories**:
- As the owner, I want backups pulled from every app server on a schedule so that losing a server does not lose the data.
- As the owner, I want a backup only when something changed so that the backup folder is not full of identical copies.
- As the owner, I want one command to rebuild a server from a backup so that recovery is quick and does not depend on memory.
- As the owner, I want a stolen backup file or backup key to be of little use so that a leak does not expose the lab credentials.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: `scripts/backup.sh` reads `backup/backup.conf`, which holds one `[section]` per app server (plus shared defaults), and backs up each section. Adding a second server is adding a second block. A failure in one server does not stop the others, and the script exits non zero if any failed.
- **AC-2**: Every SSH call is key only: `BatchMode=yes`, `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`, `IdentitiesOnly=yes`, and `StrictHostKeyChecking=yes`. A missing key or unknown host fails at once and never prompts.
- **AC-3**: A backup is taken only when something changed. A change means: any included secret file or `docker/.env` differs; or the database write counters moved and the stable content hash of the database also differs. A change in the noisy tables alone (`rate_limits`, `jobs`, `session`, `verification`) does not cause a backup. A backup is also taken when there is no saved state, when `--force` is given, and when the last backup is `force_after_days` (default 7) old or older.
- **AC-4**: Each backup is one file `hol-<server>-<UTC time>.tar.age`, encrypted with age to the public key in the config. It holds the `pg_dump` (custom format) of `hol_app` and `hol_auth`, every file in `SECRETS_DIR` except the skip list (the six required ones must exist; a new file is saved and counts as a change automatically), `docker/.env`, and a `MANIFEST` with the git commit, image names, last migration, and a checksum for every file. Left out on purpose (the skip list): `authentik_master_token`, `hol-test-*`, `*.stale`, `*.old-*`, and dotfiles.
- **AC-5**: A backup is checked before it is kept: the archive unpacks, has `db.dump`, `secrets/`, and a `MANIFEST`, and every checksum matches. The file is written under a temporary name and renamed only when complete. The saved change state is updated only after the file is in place. A missing required secret file fails the run.
- **AC-6**: After a successful save, only the newest `keep` (default 5) backups of that server stay. Pruning touches only names matching `hol-<server>-<timestamp>.tar.age` for that exact server name (a server `prod` never prunes `prod-2`), only inside an absolute directory, and never runs when the run failed.
- **AC-7**: The app server's backup key can be restricted with `restrict,command="…/scripts/backup-remote.sh"`. `backup-remote.sh` accepts only `fingerprint`, `contenthash`, and `archive` (the last word of the command), and only reads: it changes nothing on the app server. Two overlapping runs for one server do not both run (a per server lock).
- **AC-8**: `scripts/restore.sh` decrypts a backup, checks every checksum, writes the secret files (mode 600) and `docker/.env`, and loads the dump into the compose `db`. It refuses to replace an existing file that differs unless `--overwrite` is given, and rerunning with the same options works. It stops `web` and `worker` before loading, and it never starts them. It prints the next steps and warns when the checkout does not include the backup's commit.
- **AC-9**: `scripts/restore.sh --verify` restores into a throwaway Postgres container (the image named in the manifest), prints a row count per table, removes the container, and changes nothing else on the host.
- **AC-10**: The README has a "Backups and disaster recovery" section with two numbered procedures (set up the backups; bring the app up on a new server from a backup), the list of what is not in the backup, the gotchas, and a troubleshooting table. The README's older database restore snippet uses the same working command as `restore.sh`.
- **AC-11**: The backup file is never readable without the age private key, and the private key is never required on a backup or app server. No secret value appears in the log output of either script.

## Context note on scope

Out of scope: backing up Authentik, Cloudflare, Traefik, DNS, or the Turnstile widget (they are not ours to dump; the README says what to redo). Out of scope: restoring the raw Postgres volume, alerting beyond an exit code and an optional `on_failure_cmd`, and automatic age key rotation.

## Options considered

### Option 1: Pull from a backup server, bash scripts, encrypted archive (chosen)

The backup server holds the keys and the schedule, connects to each app server, and pulls. The app server only exposes three read only subcommands behind a forced command key. Archives are encrypted with age.

**Pros**:
- The app server holds no credential to the backups, so a compromised app server cannot delete or read them.
- Needs only `ssh`, `tar`, `age`, and bash on the backup server; no Node.
- Adding a server is one config block.

**Cons**:
- Two scripts that must stay in step (`backup.sh` and `backup-remote.sh`), and the backup server needs a copy of the repo.
- The passphrase free SSH key on the backup server is a credential worth guarding (the forced command limits what it can do).

### Option 2: Push from the app server

A cron job on the app server runs a dump and copies it to each backup server.

**Pros**:
- One script, simpler to schedule next to the app.

**Cons**:
- The app server needs write keys to every backup server, so one compromise reaches the backups.
- Adding a server means editing the app server.

### Option 3: Rely on SSH and disk permissions only (no encryption), or split secrets from the database

Plain archives with mode 600, or two archives sent to different hosts.

**Pros**:
- Plain is the simplest to restore. Split means no single host holds both the database and the keyring.

**Cons**:
- Plain: one stolen backup opens the keyring, the tokens, and the data. Split: two destinations to run and two things to keep in step on restore.

## Decision

**Chosen option**: Option 1: Pull from a backup server, bash scripts, encrypted archive.

Build `scripts/backup.sh` (pull side), `scripts/backup-remote.sh` (app side), and `scripts/restore.sh`, with `backup/backup.conf.example` and a README section; changes are detected by a cheap fingerprint first, then a stable content hash.

**Implementation skills**: none used. The scripts follow the style of `scripts/deploy.sh`.

## Rationale

The data is small but the secrets in it are worth a lot: the keyring, the Authentik provisioning token, and the Google and Cloudflare credentials. That rules out the plain option, because a leaked backup would reveal all of them at once. Encrypting the whole archive with age to a public key means the backup and app servers hold only the public half, and the private key stays offline. The cost is that losing the private key loses every backup, which the README says plainly.

Pull beats push because of who holds the keys. In a push model the app server, the machine most exposed to the internet, would hold write access to every backup. With pull, the app server holds only an authorized key limited to three read only subcommands, and the backup server alone can reach the backups. Bash keeps the backup server free of a Node install, and reuses the exact `docker compose exec db pg_dump` call from `scripts/deploy.sh`.

Change detection runs in two steps because the worker writes to the database all the time (job state, sessions, rate limit counters). The first step is cheap: a hash of the secret files and `docker/.env`, plus the insert, update, and delete counters of the real tables from `pg_stat_user_tables`. Only when those moved does the second step ask for a stable hash of a plain `pg_dump` (with the noisy tables' rows left out and Postgres 18's random `\restrict` token lines removed). That second hash is the final word, so a counter reset after a restart never causes a false backup for long. The noisy tables are still inside the archive; they just do not trigger one.

Restore runs `pg_restore` as the `postgres` superuser, not `hol_app`. `--clean` drops and recreates the two schemas and `hol_app` has no permission to create them; a drill showed the old command fails with 208 errors and leaves both schemas missing. `--single-transaction` makes a failed restore roll back instead.

## Feature design

**Data model sketch**: there are no new database tables. The new formats are files:

| Item | Where | Shape |
|---|---|---|
| Config | `backup/backup.conf` (gitignored) on the backup server | INI like blocks. Keys before the first `[section]` are defaults. Per server: `ssh_host`, `ssh_key`, `ssh_port` (22), `repo_dir`, `dest_dir` (absolute), `age_recipient` (`age1…`), `keep` (5), `force_after_days` (7), `on_failure_cmd` (optional) |
| Archive | `dest_dir/hol-<server>-<YYYYMMDDTHHMMSSZ>.tar.age` | age encrypted tar holding `db.dump`, `secrets/*`, `docker.env`, `MANIFEST` |
| Manifest | inside the archive | `key=value` lines (`format`, `created_utc`, `git_commit`, `git_dirty`, `web_image`, `worker_image`, `db_image`, `last_migration`, `secrets_dir`), then `files:` and a `sha256sum` line per file |
| State | `dest_dir/.state`, `dest_dir/.lock` | `secrets=`, `stats=`, `content=`, `last_epoch=`; a lock file for `flock` |

**State transitions**: per server, per run: `fingerprint` → (skip, or `contenthash` → skip, or `archive` → verify → encrypt → rename → write state → prune).

**API surface** (command line, since there is no HTTP):

| Command | Where it runs | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `scripts/backup.sh [--config F] [--server N] [--force] [--dry-run] [--list]` | backup server | config file | log lines; archives in `dest_dir`; exit 0 or 1 | SSH key | bad config, unreachable host, failed check, encryption failed |
| `scripts/backup-remote.sh fingerprint` | app server, over SSH | none | `secrets=<hash>`, `stats=<hash>` | forced command key | missing required secret (exit 3) |
| `scripts/backup-remote.sh contenthash` | app server | none | `content=<hash>` | same | pg_dump failed |
| `scripts/backup-remote.sh archive` | app server | none | a tar on stdout | same | empty dump (exit 4) |
| `scripts/restore.sh FILE --identity KEY [--verify] [--secrets-dir D] [--overwrite] [--yes]` | new server | backup file, age private key | files placed; database loaded; next steps printed | local user with docker access | wrong key, checksum mismatch, existing file differs, restore error |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| backup-remote | `SECRETS_DIR` of the app server | last `SECRETS_DIR=` in `docker/.env`, relative values resolved against `docker/`, default `../.secrets` (same rule as `scripts/db-container.ts`) |
| backup-remote | list of secret files to save | every non empty regular file in `SECRETS_DIR` not on the skip list in the script; six are required |
| backup-remote | stats hash | `pg_stat_user_tables` for `hol_app` and `hol_auth`, minus the noisy tables |
| backup-remote | content hash | plain `pg_dump` of the two schemas, minus noisy table rows and `\restrict` lines |
| backup-remote | manifest fields | `git rev-parse HEAD`, `docker inspect` of `web`, `worker`, `db`, `hol_app.kysely_migration` |
| backup.sh | whether to back up | saved `.state` against the fingerprint, `--force`, and the clock of the backup server |
| backup.sh | archive name time | UTC clock of the backup server |
| restore.sh | where secret files go | `--secrets-dir`, else `SECRETS_DIR` in the restored `docker/.env`, else `../.secrets` |
| restore.sh | database image for `--verify` | `db_image` in the manifest |

**Key invariants**:
- A backup file in `dest_dir` is always complete and checked: it appears only by rename after verification.
- The saved state never claims a change was backed up when no file was written.
- The newest `keep` archives of a server are never pruned by a failed run.
- The restore never starts `web` or `worker`.
- The app server is only read from; the backup scripts change nothing on it.

**Security model**:
- The backup server holds: the private SSH key (passphrase free, for cron), the age public key, and the encrypted archives. It never holds the age private key.
- The app server holds: one extra `authorized_keys` line with `restrict,command=…`, so that key runs only the three subcommands.
- `dest_dir` is mode 700 and files are written with `umask 077`.
- Plaintext exists only in transit inside SSH, and briefly in a mode 700 temp folder on each side. No script prints a secret or a hash of a secret to its log.
- The age private key lives offline. Losing it loses every backup; leaking it opens every backup. The README states both.

**Configuration required**:
- `backup/backup.conf` (see the example) on the backup server; no new environment variables for the app.
- Optional test overrides: `BACKUP_SSH_BIN` and `AGE_BIN` (the scripts use `ssh` and `age` by default).

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: first run saves one archive, a second run says unchanged and saves nothing, verifies **AC-3**, **AC-5**.
- A changed secret, or a changed database content, saves a new archive; a change in a noisy table only does not, verifies **AC-3**.
- Retention: with `keep = 2`, three forced backups leave two; another server whose name starts with the same text is untouched; a relative directory is refused, verifies **AC-6**.
- A corrupt archive is not saved, verifies **AC-5**.
- One bad server in the config does not stop the next, and the exit code is 1, verifies **AC-1**.
- The ssh call carries the key only options, verifies **AC-2**.
- `restore.sh --verify` against a real archive restores into a throwaway Postgres and shows live row counts, verifies **AC-9**.
- A real restore into a scratch Compose project (own project name, volume, and port) gives the same booking count and `hol_app` as owner; rerunning it works, verifies **AC-8**.

## Build plan

The project uses Tracer Bullet, so one thin thread (remote fingerprint, archive, backup of one server, verify restore) came first and then each strand was thickened. Status: all built on `feat/backup-script`; the real server run (task 11) is still to do.

1. `scripts/backup-remote.sh` with `fingerprint`, `contenthash`, `archive`, and the forced command safe subcommand parsing, satisfies **AC-3**, **AC-4**, **AC-7**.
2. `scripts/backup.sh` for one server: SSH call, decide, archive, check, encrypt, rename, state, satisfies **AC-2**, **AC-3**, **AC-5**.
3. `scripts/restore.sh --verify`, satisfies **AC-9**.
4. Config parsing with several `[section]` blocks, per server lock, failure isolation, `--force`, `--dry-run`, `--list`, `on_failure_cmd`, satisfies **AC-1**, **AC-7**.
5. Retention with the anchored name pattern and absolute directory guard, satisfies **AC-6**.
6. Real restore (secrets, `docker/.env`, no overwrite without a flag, `postgres` superuser `pg_restore`, stops web and worker, never starts them), satisfies **AC-8**.
7. `backup/backup.conf.example`, `.gitignore` entry, commands in `AGENTS.md`, satisfies **AC-1**.
8. Vitest file `scripts/backup.test.ts` with a fake app server and stub `ssh` and `age`, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-6**.
9. README section, gotchas, troubleshooting, and the corrected older restore snippet, satisfies **AC-10**.
10. Scratch drill of the real restore in a separate Compose project, satisfies **AC-8**.
11. Run the whole flow against a real second server over real SSH with a real key and real `age`, satisfies **AC-2**, **AC-7**, **AC-11** Done 2026-10-30 on nile@10.1.250.110 (backup host) pulling from this machine: restricted key accepted only the three subcommands, first backup saved and the second said unchanged, six forced backups left 5, a wrong age key was refused, and `--verify` restored with the live row counts.

## Consequences

**Positive**:
- The data and the secrets now exist off the host, encrypted, in a form that can be checked.
- Recovery is a short, tested procedure instead of knowledge in one person's head.
- The restore command is also safer than the one the README had.

**Negative / tradeoffs**:
- Everything depends on the age private key. There is no recovery if it is lost.
- The backup server needs the repo, a passphrase free SSH key, and `age`, which is one more machine to look after.
- The change detector depends on Postgres write counters and on which tables are noisy; a new noisy table would trigger extra (but harmless, deduplicated by content hash) work until it is added to the list.
- A restore gets the app back, not the world around it: Authentik, Cloudflare, Traefik, and DNS are not in the backup.

**Neutral**:
- `scripts/deploy.sh` keeps writing its own pre deploy dump to `~/backups`; it is a local safety net and is not part of this system.
- Archive names have second resolution, so two forced backups in one second would collide; cron runs do not.

## Follow-up

- [x] Run the full flow against a real server over SSH with real `age` (build plan task 11, done 2026-10-30). A real database edit (a testbed type deleted in the console) was detected and backed up on 2026-10-30. Still untested for real: a changed secret file on the live app, and a full (non verify) restore onto a second machine.
- [ ] Add a monitor or alert for "no new backup in N days" (today a failure is a log line and an exit code).
- [ ] Decide whether to encrypt the disk holding `dest_dir`, and where the off site copy of the age private key lives.
- [ ] Consider a `shellcheck` run in CI (not installed here, so the scripts were checked by `bash -n` and tests only).
- [ ] If Postgres moves to a new major version, the restore drill must be repeated (the image is pinned by digest in `docker/compose.yaml`).
