#!/usr/bin/env bash
# Nightly wa-portal Postgres backup -> S3.
# Runs on the wa-portal EC2 box via cron. Uses the instance IAM role
# (wa-portal-backup-role) for S3 auth — no access keys on disk.
#
# Dumps the DB from the running postgres container, gzips it, uploads to
# s3://wa-portal-db-backups/dumps/, and prunes local copies older than 3 days.
# S3 lifecycle deletes objects older than 30 days automatically.
set -uo pipefail

BUCKET="wa-portal-db-backups"
REGION="ap-south-1"
DB_CONTAINER="wa-portal-db"
DB_USER="waportal"
DB_NAME="waportal"
LOCAL_DIR="/home/ubuntu/db-backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="waportal-${STAMP}.sql.gz"
LOCAL="${LOCAL_DIR}/${FILE}"

mkdir -p "$LOCAL_DIR"

# Dump from the container, gzip on the fly.
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip > "$LOCAL"; then
  echo "[backup] $(date -u +%FT%TZ) pg_dump FAILED" >&2
  rm -f "$LOCAL"
  exit 1
fi

SIZE="$(stat -c%s "$LOCAL" 2>/dev/null || echo 0)"
if [ "$SIZE" -lt 100 ]; then
  echo "[backup] $(date -u +%FT%TZ) dump too small (${SIZE}b) — aborting upload" >&2
  exit 1
fi

# Upload to S3 (auth via instance role).
if aws s3 cp "$LOCAL" "s3://${BUCKET}/dumps/${FILE}" --region "$REGION" >/dev/null 2>&1; then
  echo "[backup] $(date -u +%FT%TZ) OK -> s3://${BUCKET}/dumps/${FILE} (${SIZE}b)"
else
  echo "[backup] $(date -u +%FT%TZ) S3 upload FAILED (dump kept locally at ${LOCAL})" >&2
  exit 1
fi

# Keep only the last 3 local dumps (S3 lifecycle handles long-term retention).
ls -1t "${LOCAL_DIR}"/waportal-*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
