#!/usr/bin/env bash
# Builds the image on this host and (re)starts the compose project (spec 0001).
# It dumps the app schemas before `migrate` runs. Extra arguments go to `docker compose up`, for example
# `scripts/deploy.sh web` to start only migrate and web.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
compose=(docker compose -f "$root/docker/compose.yaml")
backups="${BACKUP_DIR:-$HOME/backups}"

tag="sha-$(git -C "$root" rev-parse --short HEAD)"
git -C "$root" diff --quiet HEAD || tag="$tag-dirty"
export IMAGE_TAG="$tag"

# Two images: reservations (web, migrate) and reservations-worker (the same
# plus Chromium for the Nile Portal reset sign in, spec 0023 AC-40).
echo "building reservations:$tag and reservations-worker:$tag"
"${compose[@]}" build --pull migrate worker
docker tag "reservations:$tag" reservations:latest
docker tag "reservations-worker:$tag" reservations-worker:latest

# Start db and apply the bootstrap first, so a rotated hol_app password is
# applied before migrate runs.
"${compose[@]}" up -d --wait db
(cd "$root" && npm run --silent db:bootstrap >/dev/null)

dump="$backups/hol_before_deploy_$(date -u +%Y%m%dT%H%M%SZ).dump"
echo "dumping hol_app and hol_auth to $dump"
mkdir -p "$backups"
umask 077
# Inside the container the local socket is trusted, so no password is needed.
"${compose[@]}" exec -T db \
  pg_dump -U hol_app -d reservations -n hol_app -n hol_auth -Fc >"$dump"

"${compose[@]}" up -d --remove-orphans "$@"
"${compose[@]}" ps
