#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh onto this host (README, "Backups
# and disaster recovery", part B). It puts the secret files and docker/.env
# back, then loads the database dump into the compose `db`. It never builds,
# never starts web or worker: you run scripts/deploy.sh afterwards, on purpose,
# once the old server's worker is stopped (two workers on one Authentik send
# duplicate emails and fight over the groups).
#
#   scripts/restore.sh BACKUP.tar.age --identity AGE_KEY_FILE [options]
#     --verify              restore into a throwaway Postgres and print counts;
#                           changes nothing on this host
#     --secrets-dir DIR     where the secret files go (default: SECRETS_DIR from
#                           the restored docker/.env)
#     --overwrite           replace secret files / docker/.env that already
#                           exist and differ
#     --yes                 do not ask before loading the dump
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
age_bin="${AGE_BIN:-age}"
compose=(docker compose -f "$root/docker/compose.yaml")

die() {
  echo "restore: $*" >&2
  exit 1
}

file="" identity="" verify=0 secrets_override="" overwrite=0 yes=0
while [ $# -gt 0 ]; do
  case "$1" in
  --identity) identity="${2:?--identity needs a file}"; shift ;;
  --verify) verify=1 ;;
  --secrets-dir) secrets_override="${2:?--secrets-dir needs a folder}"; shift ;;
  --overwrite) overwrite=1 ;;
  --yes) yes=1 ;;
  -*) die "unknown option $1" ;;
  *) [ -z "$file" ] || die "one backup file only"; file="$1" ;;
  esac
  shift
done
[ -n "$file" ] && [ -r "$file" ] || die "usage: restore.sh BACKUP.tar.age --identity KEY [--verify]"
[ -n "$identity" ] && [ -r "$identity" ] || die "--identity must be the age private key file"

work="$(mktemp -d)"
cleanup() { rm -rf "${work:?}"; }
trap cleanup EXIT

echo "decrypting $(basename "$file")"
"$age_bin" -d -i "$identity" -o "$work/plain.tar" "$file" || die "could not decrypt (wrong key, or a damaged file)"
mkdir "$work/x"
tar -xf "$work/plain.tar" -C "$work/x"
rm -f "${work:?}/plain.tar"
x="$work/x"
[ -s "$x/MANIFEST" ] && [ -s "$x/db.dump" ] || die "not a reservations backup (no MANIFEST or db.dump)"

echo "checking every file against the manifest"
sed -n '/^files:$/,$p' "$x/MANIFEST" | tail -n +2 | (cd "$x" && sha256sum -c --quiet -) ||
  die "a file does not match the manifest: the backup is damaged"

field() { sed -n -E "s/^$1=(.*)$/\\1/p" "$x/MANIFEST" | head -n 1; }
commit="$(field git_commit)"
echo
echo "backup made    $(field created_utc)"
echo "git commit     $commit${commit:+ }$(field git_dirty | sed 's/true/(had uncommitted changes)/')"
echo "web image      $(field web_image)"
echo "database       $(field db_image)"
echo "last migration $(field last_migration)"
echo "secrets were   $(field secrets_dir)"
echo

# ---- --verify: a throwaway Postgres, nothing on this host changes ------------
if [ "$verify" = 1 ]; then
  img="$(field db_image)"
  [ -n "$img" ] && [ "$img" != unknown ] || die "the manifest names no database image"
  name="hol-restore-verify-$$"
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=reservations \
    --tmpfs /var/lib/postgresql "$img" >/dev/null
  # shellcheck disable=SC2064
  trap "docker stop '$name' >/dev/null 2>&1 || true; cleanup" EXIT
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d reservations >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 2
  psql_v() { docker exec -i "$name" psql -h 127.0.0.1 -U postgres -d reservations -v ON_ERROR_STOP=1 "$@"; }
  psql_v -qc "create role hol_app login; create extension if not exists btree_gist;"
  docker exec -i "$name" pg_restore -h 127.0.0.1 -U postgres -d reservations --exit-on-error \
    <"$x/db.dump" || die "pg_restore failed: the dump is not restorable"
  echo "restored into a throwaway database. Rows per table:"
  psql_v -At -c "select format('  %-28s %s', table_schema || '.' || table_name,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1])
    from information_schema.tables where table_schema in ('hol_app', 'hol_auth') and table_type = 'BASE TABLE' order by 1"
  echo
  echo "verify ok: the archive decrypts, matches its manifest, and the dump restores."
  exit 0
fi

# ---- real restore -----------------------------------------------------------
dotenv_dest="$root/docker/.env"

# Replace-or-add check: refuse to overwrite a differing file unless --overwrite.
place() {
  local src="$1" dest="$2"
  if [ -e "$dest" ] && ! cmp -s "$src" "$dest" && [ "$overwrite" != 1 ]; then
    die "$dest already exists and differs. Check it, then rerun with --overwrite"
  fi
  install -m 600 "$src" "$dest"
}

if [ -f "$x/docker.env" ]; then
  # The final text first, so a rerun with the same options compares equal.
  cp "$x/docker.env" "$work/env.final"
  if [ -n "$secrets_override" ]; then
    { grep -v -E '^[[:space:]]*SECRETS_DIR[[:space:]]*=' "$x/docker.env" || true; } >"$work/env.final"
    printf 'SECRETS_DIR=%s\n' "$secrets_override" >>"$work/env.final"
  fi
  place "$work/env.final" "$dotenv_dest"
  echo "wrote docker/.env"
else
  echo "the backup has no docker/.env: make one from docker/.env.example"
fi

# SECRETS_DIR the way Compose resolves it (same rule as scripts/backup-remote.sh).
value="$(sed -n -E 's/^[[:space:]]*SECRETS_DIR[[:space:]]*=[[:space:]]*(.*[^[:space:]])?[[:space:]]*$/\1/p' "$dotenv_dest" 2>/dev/null |
  sed -E "s/^([\"'])(.*)\1\$/\2/" | grep -v '^$' | tail -n 1 || true)"
value="${secrets_override:-${value:-../.secrets}}"
case "$value" in
/*) dir="$value" ;;
*) dir="$root/docker/$value" ;;
esac
mkdir -p "$dir"
chmod 700 "$dir"
for f in "$x"/secrets/*; do
  place "$f" "$dir/$(basename "$f")"
done
echo "wrote $(ls -1 "$x/secrets" | wc -l) secret files to $dir"
[ "$dir" = "$(field secrets_dir)" ] || echo "note: the secrets folder differs from the old host ($(field secrets_dir)); check docker/.env"

# Migrations only go forward: the code must be the backup's commit or newer.
# Older code would refuse a database that is ahead of it.
if git -C "$root" merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
  echo "ok: this checkout includes the backup's commit"
else
  echo "WARNING: this checkout does not include the backup's commit $commit."
  echo "         Update it (git pull, or git fetch --all) before you deploy."
fi

# The pinned database image must match, or Postgres refuses the data/restore.
want="$(field db_image)"
have="$(sed -n -E 's/^[[:space:]]*image:[[:space:]]*(postgres:[^[:space:]]+).*/\1/p' "$root/docker/compose.yaml" | head -n 1)"
[ -z "$want" ] || [ -z "$have" ] || [ "$want" = "$have" ] ||
  echo "note: compose.yaml pins $have but the backup came from $want (a newer commit may move it)"

if [ "$yes" != 1 ]; then
  echo
  echo "This replaces everything in the hol_app and hol_auth schemas on this host's database."
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = restore ] || die "cancelled (the files above are already in place)"
fi

# Nothing may use the database while it is replaced, and the worker must not
# start by itself afterwards.
"${compose[@]}" stop web worker >/dev/null 2>&1 || true
(cd "$root" && npm run --silent db:up)
# As postgres, not hol_app: --clean drops and recreates the two schemas, and
# hol_app has no CREATE on the database. Ownership still goes back to hol_app
# because the dump says so (no --no-owner). The container's local socket is
# trusted, as in db/bootstrap.sql's runner.
"${compose[@]}" exec -T db \
  pg_restore -U postgres -d reservations --clean --if-exists --single-transaction --exit-on-error \
  <"$x/db.dump"
echo
echo "database restored."
echo "Next, in this order:"
echo "  1. Make sure the old server's worker is stopped (or this is the only server)."
echo "  2. Make sure this checkout includes commit $commit (git pull), then: npm install"
echo "  3. scripts/deploy.sh web          # migrate and web, no worker yet"
echo "  4. docker compose -f docker/compose.yaml up -d worker   # only when step 1 is true"
echo "  5. Follow the smoke checks in the README (part B, step 9)."
