#!/usr/bin/env bash
# Test de db/init/db-bootstrap.sh : prefixe ss2i_ de nos migrations et reprise des bases deja migrees sous
# les anciens noms (004 a 009). Usage : PGHOST=127.0.0.1 PGPORT=55460 PGUSER=postgres PGPASSWORD=test db/test/bootstrap-migrations.sh
# Cree puis supprime des bases kurrier_boot_* sur le serveur indique ; ne touche a aucune autre base.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOT="$ROOT/init/db-bootstrap.sh"
SRC="$ROOT/init/migrations"
WORK="$(mktemp -d "${CLAUDE_CODE_TMPDIR:-$HOME/.cache}/boot-test.XXXXXX")"
export PGDATABASE=postgres
ADMIN=(psql -v ON_ERROR_STOP=1 -tA -q)
fail=0

check() { # description, attendu, obtenu
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 : attendu '$2', obtenu '$3'"; fail=1; fi
}
newdb() { "${ADMIN[@]}" -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"; }
boot() { # base, dossier -> journal du bootstrap dans $WORK/out
  PGDATABASE="$1" MIGRATIONS_DIR="$2" bash "$BOOT" >"$WORK/out" 2>&1 || { echo "FAIL bootstrap en erreur sur $1"; tail -15 "$WORK/out"; fail=1; }
}
versions() { PGDATABASE="$1" psql -tA -c "SELECT string_agg(version, ',' ORDER BY version COLLATE \"C\") FROM public.migrations"; }
runs() { grep -c "Running" "$WORK/out"; }

# Dossier "ancien depot" : memes fichiers, nommes 004 a 009 comme avant le prefixe.
LEGACY="$WORK/legacy"; mkdir -p "$LEGACY"
cp "$SRC"/00[1-3]_migration.sql "$LEGACY"/
for i in 1 2 3 4 5 6; do cp "$SRC/ss2i_00${i}_migration.sql" "$LEGACY/00$((i + 3))_migration.sql"; done
NEW_ALL="001_migration,002_migration,003_migration,ss2i_001_migration,ss2i_002_migration,ss2i_003_migration,ss2i_004_migration,ss2i_005_migration,ss2i_006_migration"

# 1. Base vide : tout est applique, sous les noms ss2i_.
newdb kurrier_boot_a
boot kurrier_boot_a "$SRC"
check "base vide : 9 migrations appliquees" 9 "$(runs)"
check "base vide : noms enregistres" "$NEW_ALL" "$(versions kurrier_boot_a)"
boot kurrier_boot_a "$SRC"
check "base vide, 2e passage : rien rejoue" 0 "$(runs)"

# 2. Base migree par l'ancien depot (004 a 009) : renommage, rien rejoue, rien saute.
newdb kurrier_boot_b
boot kurrier_boot_b "$LEGACY"
check "ancienne base : noms d'origine" "001_migration,002_migration,003_migration,004_migration,005_migration,006_migration,007_migration,008_migration,009_migration" "$(versions kurrier_boot_b)"
boot kurrier_boot_b "$SRC"
check "ancienne base : rien rejoue" 0 "$(runs)"
check "ancienne base : noms renommes" "$NEW_ALL" "$(versions kurrier_boot_b)"
boot kurrier_boot_b "$SRC"
check "ancienne base, 2e passage : rien rejoue" 0 "$(runs)"

# 3. Base restee a mi-chemin (004 a 007 seulement) : les deux manquantes sont appliquees, pas les autres.
newdb kurrier_boot_c
PARTIAL="$WORK/partial"; mkdir -p "$PARTIAL"; cp "$LEGACY"/00[1-7]_migration.sql "$PARTIAL"/
boot kurrier_boot_c "$PARTIAL"
boot kurrier_boot_c "$SRC"
check "base a mi-chemin : seules ss2i_005 et ss2i_006 appliquees" 2 "$(runs)"
check "base a mi-chemin : noms enregistres" "$NEW_ALL" "$(versions kurrier_boot_c)"

# 4. Collision future : une 004 amont (autre contenu) arrive apres le renommage. Elle doit etre appliquee une
# fois, et ne pas etre renommee en ss2i_001 au passage suivant.
UP="$WORK/upstream"; mkdir -p "$UP"; cp "$SRC"/*.sql "$UP"/
echo 'CREATE TABLE amont_004_probe (id int);' > "$UP/004_migration.sql"
boot kurrier_boot_b "$UP"
check "004 amont apres renommage : appliquee" 1 "$(runs)"
check "004 amont : table creee" "amont_004_probe" "$(PGDATABASE=kurrier_boot_b psql -tA -c "SELECT to_regclass('public.amont_004_probe')")"
boot kurrier_boot_b "$UP"
check "004 amont, 2e passage : rien rejoue" 0 "$(runs)"
check "004 amont : enregistree sous son nom" "001_migration,002_migration,003_migration,004_migration,${NEW_ALL#001_migration,002_migration,003_migration,}" "$(versions kurrier_boot_b)"

for d in a b c; do "${ADMIN[@]}" -c "DROP DATABASE IF EXISTS kurrier_boot_$d" >/dev/null; done
rm -rf "$WORK"
[ "$fail" = 0 ] && echo "Tous les tests passent." || echo "Echec."
exit "$fail"
