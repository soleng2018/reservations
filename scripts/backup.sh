#!/usr/bin/env bash
# Pulls backups of the reservations app from one or more servers over SSH
# (README, "Backups and disaster recovery"). Runs on the BACKUP host, not on the
# app host: the app host holds no key to the backups. Per server it asks
# scripts/backup-remote.sh what changed, and only when something did it pulls an
# archive, checks it, encrypts it with age, and keeps the newest `keep` files.
#
#   scripts/backup.sh [--config FILE] [--server NAME] [--force] [--dry-run] [--list]
#
# Config: backup/backup.conf (see backup/backup.conf.example). SSH is key only.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ssh_bin="${BACKUP_SSH_BIN:-ssh}"
age_bin="${AGE_BIN:-age}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# ---- config ----------------------------------------------------------------
# Keys before the first [section] are defaults for every server. cfg holds
# "section.key" entries; servers lists the section names in file order.
declare -A cfg=()
servers=()

parse_config() {
  local file="$1" section="" line key value
  [ -r "$file" ] || {
    echo "backup: cannot read config $file" >&2
    return 1
  }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -n "$line" ] || continue
    if [[ "$line" =~ ^\[([A-Za-z0-9_-]+)\]$ ]]; then
      section="${BASH_REMATCH[1]}"
      servers+=("$section")
    elif [[ "$line" =~ ^([a-z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      cfg["${section:-defaults}.$key"]="$value"
    else
      echo "backup: bad config line: $line" >&2
      return 1
    fi
  done <"$file"
}

# A server's setting, falling back to the defaults, then to $3.
setting() {
  local name="$1" key="$2" fallback="${3:-}"
  printf '%s' "${cfg["$name.$key"]:-${cfg["defaults.$key"]:-$fallback}}"
}

expand_home() { printf '%s' "${1/#\~/$HOME}"; }

# ---- pure helpers (tested) ---------------------------------------------------
# Archive names for a server, oldest first. The anchored pattern keeps server
# "prod" from matching the files of a server named "prod-2".
list_archives() {
  local dir="$1" name="$2"
  [ -d "$dir" ] || return 0
  ls -1 "$dir" | grep -E "^hol-${name}-[0-9]{8}T[0-9]{6}Z\.tar\.age\$" | sort || true
}

# Deletes all but the newest $3 archives of server $2 in $1. It only removes
# names list_archives returns, inside an absolute directory, and nothing else.
prune_archives() {
  local dir="${1:?directory}" name="${2:?server}" keep="${3:?keep}" old f
  case "$dir" in
  /?*) ;;
  *)
    echo "backup: refusing to prune a relative or root directory: $dir" >&2
    return 1
    ;;
  esac
  old="$(list_archives "$dir" "$name" | head -n "-$keep")" || true
  [ -n "$old" ] || return 0
  while read -r f; do
    [ -n "$f" ] || continue
    rm -f -- "${dir:?}/${f:?}"
    log "$name: removed old backup $f"
  done <<<"$old"
}

# Prints "<action> <reason>" from the saved state and what the server reported.
# action is backup (go), check (ask for the content hash first) or skip.
# Args: force secrets stats state_secrets state_stats age_seconds limit_seconds.
decide_stage1() {
  local force="$1" secrets="$2" stats="$3" st_secrets="$4" st_stats="$5" age="$6" limit="$7"
  if [ "$force" = 1 ]; then
    echo "backup forced"
  elif [ -z "$st_secrets" ] || [ -z "$st_stats" ]; then
    echo "backup first run"
  elif [ "$age" -ge "$limit" ]; then
    echo "backup weekly safety net"
  elif [ "$secrets" != "$st_secrets" ]; then
    echo "check secret files changed"
  elif [ "$stats" != "$st_stats" ]; then
    echo "check database changed"
  else
    echo "skip unchanged"
  fi
}

# After the content hash: "backup" when anything real changed, else "skip".
decide_stage2() {
  local secrets="$1" content="$2" st_secrets="$3" st_content="$4"
  if [ "$secrets" != "$st_secrets" ] || [ "$content" != "$st_content" ]; then
    echo backup
  else
    echo skip
  fi
}

# Reads "key=value" lines from stdin, prints the value of $1.
kv() { sed -n -E "s/^$1=(.*)$/\\1/p" | head -n 1; }

# ---- one server ----------------------------------------------------------------
run_remote() {
  local name="$1" sub="$2" host key port repo
  host="$(setting "$name" ssh_host)"
  key="$(expand_home "$(setting "$name" ssh_key)")"
  port="$(setting "$name" ssh_port 22)"
  repo="$(setting "$name" repo_dir)"
  # Key only: a password prompt would fail at once, never hang a cron job.
  "$ssh_bin" -i "$key" -p "$port" \
    -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    "$host" "$repo/scripts/backup-remote.sh $sub"
}

write_state() {
  local file="$1" secrets="$2" stats="$3" content="$4" epoch="$5"
  printf 'secrets=%s\nstats=%s\ncontent=%s\nlast_epoch=%s\n' \
    "$secrets" "$stats" "$content" "$epoch" >"$file.tmp"
  mv -f "$file.tmp" "$file"
}

# Checks the plain tar before it is encrypted: it unpacks, has the three kinds
# of content, and every file matches the manifest.
verify_plain() {
  local tarfile="$1" work ok=0
  work="$(mktemp -d)"
  if tar -xf "$tarfile" -C "$work" &&
    [ -s "$work/db.dump" ] && [ -s "$work/MANIFEST" ] && [ -d "$work/secrets" ] &&
    sed -n '/^files:$/,$p' "$work/MANIFEST" | tail -n +2 |
    (cd "$work" && sha256sum -c --quiet -) >/dev/null 2>&1; then
    ok=1
  fi
  rm -rf "${work:?}"
  [ "$ok" = 1 ]
}

backup_server() {
  local name="$1" force="$2" dry="$3"
  local dest recipient keep days now age k
  dest="$(expand_home "$(setting "$name" dest_dir)")"
  recipient="$(setting "$name" age_recipient)"
  keep="$(setting "$name" keep 5)"
  days="$(setting "$name" force_after_days 7)"
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || { log "$name: keep must be a number from 1"; return 1; }
  [[ "$days" =~ ^[0-9]+$ ]] || { log "$name: force_after_days must be a number"; return 1; }
  [[ "$recipient" =~ ^age1[a-z0-9]+$ ]] || { log "$name: age_recipient must be an age public key (age1...)"; return 1; }
  [[ "$dest" = /?* ]] || { log "$name: dest_dir must be an absolute path"; return 1; }
  for k in ssh_host ssh_key repo_dir; do
    [ -n "$(setting "$name" "$k")" ] || { log "$name: missing $k in the config"; return 1; }
  done

  mkdir -p "$dest" && chmod 700 "$dest" || { log "$name: cannot create $dest"; return 1; }
  exec 9>"$dest/.lock" || { log "$name: cannot write in $dest"; return 1; }
  flock -n 9 || { log "$name: another backup is running, skipping"; return 0; }

  local state="$dest/.state" st_secrets="" st_stats="" st_content="" st_epoch=0
  if [ -f "$state" ]; then
    st_secrets="$(kv secrets <"$state")"
    st_stats="$(kv stats <"$state")"
    st_content="$(kv content <"$state")"
    st_epoch="$(kv last_epoch <"$state")"
    st_epoch="${st_epoch:-0}"
  fi
  now="$(date +%s)"
  age=$((now - st_epoch))

  local fp secrets stats
  fp="$(run_remote "$name" fingerprint)" || { log "$name: fingerprint failed"; return 1; }
  secrets="$(kv secrets <<<"$fp")"
  stats="$(kv stats <<<"$fp")"
  [ -n "$secrets" ] && [ -n "$stats" ] || { log "$name: unreadable fingerprint"; return 1; }

  local verdict action reason
  verdict="$(decide_stage1 "$force" "$secrets" "$stats" "$st_secrets" "$st_stats" "$age" $((days * 86400)))"
  action="${verdict%% *}"
  reason="${verdict#* }"
  if [ "$action" = skip ]; then
    log "$name: $reason"
    return 0
  fi

  local content
  content="$(run_remote "$name" contenthash | kv content)" || { log "$name: contenthash failed"; return 1; }
  [ -n "$content" ] || { log "$name: unreadable content hash"; return 1; }
  if [ "$action" = check ]; then
    if [ "$(decide_stage2 "$secrets" "$content" "$st_secrets" "$st_content")" = skip ]; then
      log "$name: unchanged (only noise changed)"
      [ "$dry" = 1 ] || write_state "$state" "$secrets" "$stats" "$content" "$st_epoch"
      return 0
    fi
  fi

  if [ "$dry" = 1 ]; then
    log "$name: would back up ($reason)"
    return 0
  fi

  log "$name: backing up ($reason)"
  local stamp work final
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$(mktemp -d "$dest/.work.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '${work:?}'" RETURN

  run_remote "$name" archive >"$work/plain.tar" || { log "$name: archive failed"; return 1; }
  verify_plain "$work/plain.tar" || { log "$name: the archive failed its check, nothing saved"; return 1; }
  "$age_bin" -r "$recipient" -o "$work/out.age" "$work/plain.tar" || { log "$name: encryption failed"; return 1; }
  [ -s "$work/out.age" ] || { log "$name: encrypted file is empty"; return 1; }

  final="$dest/hol-$name-$stamp.tar.age"
  mv "$work/out.age" "$final"
  # Hashes taken before the archive, so a change made during it shows next run.
  write_state "$state" "$secrets" "$stats" "$content" "$(date +%s)"
  log "$name: saved $(basename "$final") ($(stat -c %s "$final") bytes)"
  prune_archives "$dest" "$name" "$keep"
}

list_server() {
  local name="$1" dest f
  dest="$(expand_home "$(setting "$name" dest_dir)")"
  echo "$name ($dest):"
  list_archives "$dest" "$name" | while read -r f; do
    printf '  %s  %s bytes\n' "$f" "$(stat -c %s "$dest/$f")"
  done
}

main() {
  local config="$here/../backup/backup.conf" only="" force=0 dry=0 list=0
  while [ $# -gt 0 ]; do
    case "$1" in
    --config) config="${2:?--config needs a file}"; shift ;;
    --server) only="${2:?--server needs a name}"; shift ;;
    --force) force=1 ;;
    --dry-run) dry=1 ;;
    --list) list=1 ;;
    *) echo "usage: backup.sh [--config FILE] [--server NAME] [--force] [--dry-run] [--list]" >&2; exit 2 ;;
    esac
    shift
  done

  parse_config "$config"
  [ "${#servers[@]}" -gt 0 ] || { echo "backup: no [server] sections in $config" >&2; exit 1; }

  if [ -n "$only" ] && ! printf '%s\n' "${servers[@]}" | grep -qxF -- "$only"; then
    echo "backup: no server named '$only' in $config" >&2
    exit 1
  fi

  local failed=0 name hook rc
  for name in "${servers[@]}"; do
    [ -z "$only" ] || [ "$only" = "$name" ] || continue
    if [ "$list" = 1 ]; then
      list_server "$name"
      continue
    fi
    # A subshell, so one server's failure or lock never stops the others. It is
    # not run inside an `if`, which would switch errexit off in the function and
    # let an unchecked mkdir or mv failure pass.
    set +e
    (
      set -e
      backup_server "$name" "$force" "$dry"
    )
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      failed=$((failed + 1))
      hook="$(setting "$name" on_failure_cmd)"
      [ -z "$hook" ] || BACKUP_SERVER="$name" bash -c "$hook" || true
    fi
  done
  [ "$failed" -eq 0 ] || { log "$failed server(s) failed"; exit 1; }
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
