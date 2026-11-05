#!/usr/bin/env bash
set -euo pipefail

echo "🟡 Waiting for Postgres at $PGHOST..."
until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; do
  sleep 2
done
echo "✅ Postgres is ready."

echo "🧩 Ensuring migrations table exists..."
psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.migrations (
  version text PRIMARY KEY,
  applied_at timestamptz DEFAULT now()
);
SQL

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/scripts/migrations}"

# This fork's migrations carry the community_ prefix: upstream numbers its own 001, 002... and its 004 to 012
# (v4.x) are not the 004 to 007 this fork wrote under the same numbers. Under the same name, an upstream
# migration would be taken for already applied and skipped silently. Databases already migrated still have the
# old names: they are renamed here, ONCE, the marker community_000_legacy_rename being written in the same
# transaction. A fresh database gets the marker before the loop and is never renamed afterwards: without it, a
# restart after a failure halfway would take the UPSTREAM 004 to 007 for our old migrations and rename them to
# community_001 to 004 (marked applied without having run). What is recorded under the old name is not replayed,
# what is not will be applied by the loop below.
#
# Guard: a migrations folder that still holds an old 00N_migration.sql identical to its community_00(N-3)
# (copied by hand without deleting the old files) would replay that file, now unrecorded, and fail on
# "already exists": stop before touching the database, with the instruction.
for n in 4 5 6 7; do
  old="$MIGRATIONS_DIR/$(printf '%03d' "$n")_migration.sql"
  new="$MIGRATIONS_DIR/community_$(printf '%03d' $((n - 3)))_migration.sql"
  if [ -f "$old" ] && [ -f "$new" ] && cmp -s "$old" "$new"; then
    echo "ERROR: $(basename "$old") is identical to $(basename "$new"): old file left in $MIGRATIONS_DIR after the community_ rename." >&2
    echo "Delete 004 to 007_migration.sql from the folder (replaced by community_001 to 004) and run again." >&2
    exit 3
  fi
done

echo "Renaming legacy fork migrations (004-007 -> community_001-004), once..."
psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE public.migrations m
SET version = map.new_version
FROM (VALUES
  ('004_migration', 'community_001_migration'),
  ('005_migration', 'community_002_migration'),
  ('006_migration', 'community_003_migration'),
  ('007_migration', 'community_004_migration')
) AS map(old_version, new_version)
WHERE m.version = map.old_version
  AND NOT EXISTS (SELECT 1 FROM public.migrations x WHERE x.version = 'community_000_legacy_rename')
  AND NOT EXISTS (SELECT 1 FROM public.migrations x WHERE x.version = map.new_version);
INSERT INTO public.migrations(version) VALUES ('community_000_legacy_rename') ON CONFLICT DO NOTHING;
COMMIT;
SQL

echo "🚀 Applying new migrations..."
for file in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  base=$(basename "$file")
  version="${base%.sql}"
  exists=$(psql -tA -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
    -c "SELECT 1 FROM public.migrations WHERE version = '$version' LIMIT 1")

  if [ "$exists" = "1" ]; then
    echo "⏭️  Skipping $base (already applied)"
  else
    echo "🟢 Running $base ..."
    psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$file"
    psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
      -c "INSERT INTO public.migrations(version) VALUES ('$version');"
  fi
done

echo "✅ All migrations done."

echo "✅ Bootstrap complete."
