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

# Nos migrations portent le prefixe ss2i_ : l'amont numerote les siennes 001, 002... et ses 004 a 012 (v4.x) ne
# sont pas les 004 a 009 que ce fork avait ecrites sous le meme numero. Sous un meme nom, une migration amont
# serait prise pour deja appliquee et sautee en silence. Les bases deja migrees ont encore les anciens noms :
# on les renomme ici, une seule fois (jamais si le nom cible est deja enregistre, sinon la 004 amont appliquee
# plus tard serait renommee a son tour). Ce qui est enregistre sous l'ancien nom n'est pas rejoue, ce qui ne
# l'est pas sera applique par la boucle ci-dessous.
echo "Renaming legacy fork migrations (004-009 -> ss2i_001-006)..."
psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
UPDATE public.migrations m
SET version = map.new_version
FROM (VALUES
  ('004_migration', 'ss2i_001_migration'),
  ('005_migration', 'ss2i_002_migration'),
  ('006_migration', 'ss2i_003_migration'),
  ('007_migration', 'ss2i_004_migration'),
  ('008_migration', 'ss2i_005_migration'),
  ('009_migration', 'ss2i_006_migration')
) AS map(old_version, new_version)
WHERE m.version = map.old_version
  AND NOT EXISTS (SELECT 1 FROM public.migrations x WHERE x.version = map.new_version);
SQL

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/scripts/migrations}"

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
