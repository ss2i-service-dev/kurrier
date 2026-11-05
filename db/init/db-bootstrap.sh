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

# Nos migrations portent le prefixe ss2i_ : l'amont numerote les siennes 001, 002... et ses 004 a 012 (v4.x) ne
# sont pas les 004 a 009 que ce fork avait ecrites sous le meme numero. Sous un meme nom, une migration amont
# serait prise pour deja appliquee et sautee en silence. Les bases deja migrees ont encore les anciens noms :
# on les renomme ici, UNE SEULE FOIS, le marqueur ss2i_000_legacy_rename etant pose dans la meme transaction.
# Une base neuve recoit le marqueur avant la boucle et n'est plus jamais renommee : sans lui, un demarrage
# apres un echec en cours de route aurait pris les 004 a 006 AMONT pour nos anciennes migrations et les aurait
# renommees en ss2i_001 a 003 (marquees appliquees sans l'etre). Ce qui est enregistre sous l'ancien nom n'est
# pas rejoue, ce qui ne l'est pas sera applique par la boucle ci-dessous.
#
# Garde : un dossier de migrations qui garde un ancien 00N_migration.sql identique a son ss2i_00(N-3) (copie a
# la main sans supprimer les anciens fichiers) rejouerait ce fichier, desormais non enregistre, et echouerait
# sur « already exists » : on s'arrete avant de toucher la base, avec la consigne.
for n in 4 5 6 7 8 9; do
  old="$MIGRATIONS_DIR/$(printf '%03d' "$n")_migration.sql"
  new="$MIGRATIONS_DIR/ss2i_$(printf '%03d' $((n - 3)))_migration.sql"
  if [ -f "$old" ] && [ -f "$new" ] && cmp -s "$old" "$new"; then
    echo "ERREUR : $(basename "$old") est identique a $(basename "$new") : ancien nom reste dans $MIGRATIONS_DIR apres le renommage ss2i_." >&2
    echo "Supprimer 004 a 009_migration.sql du dossier (ils sont remplaces par ss2i_001 a 006) puis relancer." >&2
    exit 3
  fi
done

echo "Renaming legacy fork migrations (004-009 -> ss2i_001-006), once..."
psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
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
  AND NOT EXISTS (SELECT 1 FROM public.migrations x WHERE x.version = 'ss2i_000_legacy_rename')
  AND NOT EXISTS (SELECT 1 FROM public.migrations x WHERE x.version = map.new_version);
INSERT INTO public.migrations(version) VALUES ('ss2i_000_legacy_rename') ON CONFLICT DO NOTHING;
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
