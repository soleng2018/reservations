#!/usr/bin/env bash
# The app host's half of the backup (README, "Backups and disaster recovery").
# scripts/backup.sh on the backup host runs it over SSH. It only reads: it
# changes nothing on this host. One subcommand per call:
#
#   fingerprint   two hashes, cheap: the secret files + docker/.env, and the
#                 database's write counters (noisy tables left out)
#   contenthash   a stable hash of the database content (a plain pg_dump with
#                 the noisy tables' rows left out)
#   archive       a tar on stdout: db.dump, secrets/, docker.env, MANIFEST
#
# Install the backup key on this host with a forced command so it can run
# nothing else (the subcommand arrives in SSH_ORIGINAL_COMMAND):
#   restrict,command="/home/nova/reservations/scripts/backup-remote.sh" ssh-ed25519 AAAA... hol-backup
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
compose=(docker compose -f "$root/docker/compose.yaml")

# Files in SECRETS_DIR that go in the backup: every regular file except the skip
# list, so a new secret is saved (and counts as a change) without editing this
# script. The first group is needed to start the app, so a missing one fails the
# run. Skipped on purpose: authentik_master_token (delete it after setup),
# hol-test-*.pw (e2e only), *.stale / *.old-* copies, and dotfiles.
required=(postgres_password hol_app_password auth_secret hol_encryption_keys.json
  authentik_client_secret authentik_provisioning_token)
skip=(authentik_master_token 'hol-test-*' '*.stale' '*.old-*' '.*')

# Rows that change all the time without the owner changing anything: rate limit
# counters, job state, sign in sessions, one time tokens. They stay in the
# archive but are not a reason to make a new one.
noisy_tables=(rate_limits jobs session verification)

# SECRETS_DIR as Compose sees it: the last value in docker/.env, a relative
# path resolved against docker/, default ../.secrets (same rule as
# scripts/db-container.ts).
secrets_dir() {
  local value=""
  if [ -f "$root/docker/.env" ]; then
    value="$(sed -n -E 's/^[[:space:]]*SECRETS_DIR[[:space:]]*=[[:space:]]*(.*[^[:space:]])?[[:space:]]*$/\1/p' "$root/docker/.env" |
      sed -E "s/^([\"'])(.*)\1\$/\2/" | grep -v '^$' | tail -n 1 || true)"
  fi
  value="${value:-../.secrets}"
  case "$value" in
  /*) printf '%s\n' "$value" ;;
  *) printf '%s\n' "$root/docker/$value" ;;
  esac
}

dir="$(secrets_dir)"

# True when the file name matches the skip list.
skipped() {
  local pattern
  for pattern in "${skip[@]}"; do
    # shellcheck disable=SC2254
    case "$1" in $pattern) return 0 ;; esac
  done
  return 1
}

# The secret file names to save, one per line. Fails when a required one is gone.
included() {
  local f
  for f in "${required[@]}"; do
    [ -s "$dir/$f" ] || {
      echo "backup-remote: required secret file missing: $f" >&2
      exit 3
    }
    echo "$f"
  done
  find "$dir" -maxdepth 1 -type f -size +0 -printf '%f\n' | sort | while read -r f; do
    skipped "$f" && continue
    printf '%s\n' "${required[@]}" | grep -qxF -- "$f" && continue
    echo "$f"
  done
  return 0
}

psql_app() {
  "${compose[@]}" exec -T db psql -U hol_app -d reservations -At "$@"
}

noisy_filter() {
  local t out=""
  for t in "${noisy_tables[@]}"; do out="$out,'$t'"; done
  printf '%s' "${out#,}"
}

secrets_hash() {
  {
    included | sort | while read -r f; do
      printf '%s  %s\n' "$(sha256sum <"$dir/$f" | cut -d' ' -f1)" "secrets/$f"
    done
    [ -f "$root/docker/.env" ] &&
      printf '%s  docker.env\n' "$(sha256sum <"$root/docker/.env" | cut -d' ' -f1)"
    return 0
  } | sha256sum | cut -d' ' -f1
}

# Insert, update and delete counters per table. A restart of Postgres can reset
# them, which only causes one extra content check, never a missed change.
stats_hash() {
  psql_app -c "select relname, n_tup_ins, n_tup_upd, n_tup_del
    from pg_stat_user_tables
    where schemaname in ('hol_app', 'hol_auth')
      and relname not in ($(noisy_filter))
    order by schemaname, relname" | sha256sum | cut -d' ' -f1
}

# Plain format has no timestamp header. Postgres 18 adds a random \restrict
# token line, which is dropped so the same content hashes the same.
content_hash() {
  local excludes=() t
  for t in "${noisy_tables[@]}"; do
    case "$t" in
    session | verification) excludes+=("--exclude-table-data=hol_auth.$t") ;;
    *) excludes+=("--exclude-table-data=hol_app.$t") ;;
    esac
  done
  "${compose[@]}" exec -T db pg_dump -U hol_app -d reservations \
    -n hol_app -n hol_auth -Fp --no-owner "${excludes[@]}" |
    grep -v -E '^\\(un)?restrict ' | sha256sum | cut -d' ' -f1
}

container_image() {
  local id
  id="$("${compose[@]}" ps -q "$1" | head -n 1)"
  [ -n "$id" ] && docker inspect --format '{{.Config.Image}}' "$id" || echo unknown
}

tmp=""
cleanup() { [ -z "$tmp" ] || rm -rf "$tmp"; }

archive() {
  local f
  tmp="$(mktemp -d)"
  trap cleanup EXIT
  mkdir "$tmp/secrets"

  # Same dump as scripts/deploy.sh; the local socket in the container is trusted.
  "${compose[@]}" exec -T db \
    pg_dump -U hol_app -d reservations -n hol_app -n hol_auth -Fc >"$tmp/db.dump"
  [ -s "$tmp/db.dump" ] || {
    echo "backup-remote: pg_dump wrote nothing" >&2
    exit 4
  }

  included | while read -r f; do cp "$dir/$f" "$tmp/secrets/$f"; done
  [ -f "$root/docker/.env" ] && cp "$root/docker/.env" "$tmp/docker.env"

  {
    echo "format=1"
    echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "git_commit=$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
    git -C "$root" diff --quiet HEAD 2>/dev/null || echo "git_dirty=true"
    echo "web_image=$(container_image web)"
    echo "worker_image=$(container_image worker)"
    echo "db_image=$(container_image db)"
    echo "last_migration=$(psql_app -c 'select name from hol_app.kysely_migration order by name desc limit 1' || echo unknown)"
    echo "secrets_dir=$dir"
    echo "files:"
    (cd "$tmp" && find . -type f ! -name MANIFEST | sort | xargs sha256sum)
  } >"$tmp/MANIFEST"

  tar -cf - -C "$tmp" .
}

# The caller sends "<repo>/scripts/backup-remote.sh <subcommand>". With a forced
# command sshd hands that whole string over in SSH_ORIGINAL_COMMAND, so only
# the last word counts, and the case below accepts nothing but the three names.
cmd="${SSH_ORIGINAL_COMMAND:-${1:-}}"
cmd="${cmd##* }"
case "$cmd" in
fingerprint)
  echo "secrets=$(secrets_hash)"
  echo "stats=$(stats_hash)"
  ;;
contenthash) echo "content=$(content_hash)" ;;
archive) archive ;;
*)
  echo "usage: backup-remote.sh fingerprint | contenthash | archive" >&2
  exit 2
  ;;
esac
