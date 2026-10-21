#!/usr/bin/env bash
# Builds the image on this host and (re)starts the compose project (spec 0001).
# Dev and production share one database, so it dumps the app schemas before
# `migrate` runs. Extra arguments go to `docker compose up`, for example
# `scripts/deploy.sh web` to start only migrate and web.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
compose=(docker compose -f "$root/docker/compose.yaml")
backups="${BACKUP_DIR:-$HOME/backups}"
secrets="$(grep -E '^SECRETS_DIR=' "$root/docker/.env" | cut -d= -f2-)"

tag="sha-$(git -C "$root" rev-parse --short HEAD)"
git -C "$root" diff --quiet HEAD || tag="$tag-dirty"
export IMAGE_TAG="$tag"

echo "building reservations:$tag"
"${compose[@]}" build migrate
docker tag "reservations:$tag" reservations:latest

dump="$backups/hol_before_deploy_$(date -u +%Y%m%dT%H%M%SZ).dump"
echo "dumping hol_app and hol_auth to $dump"
umask 077
# PGPASSWORD passes by name, so the value never shows in the process list.
PGPASSWORD="$(cat "$secrets/hol_app_password")" docker exec -i -e PGPASSWORD insforge-postgres \
  pg_dump -h 127.0.0.1 -U hol_app -d insforge -n hol_app -n hol_auth -Fc >"$dump"

"${compose[@]}" up -d --remove-orphans "$@"
"${compose[@]}" ps
