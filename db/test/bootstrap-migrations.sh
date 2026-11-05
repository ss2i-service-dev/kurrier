#!/usr/bin/env bash
# Test de db/init/db-bootstrap.sh : prefixe ss2i_ de nos migrations et reprise des bases deja migrees sous
# les anciens noms (004 a 009), marqueur de renommage unique, garde contre les anciens fichiers restes dans le
# dossier, et controle qu'aucun 00N_migration.sql du depot ne s'ecarte de l'amont. Usage : PGHOST=127.0.0.1 PGPORT=55460 PGUSER=postgres PGPASSWORD=test db/test/bootstrap-migrations.sh
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
bootfail() { # base, dossier -> code de sortie du bootstrap, journal dans $WORK/out
  PGDATABASE="$1" MIGRATIONS_DIR="$2" bash "$BOOT" >"$WORK/out" 2>&1; echo $?
}
boot() { # base, dossier -> journal du bootstrap dans $WORK/out
  PGDATABASE="$1" MIGRATIONS_DIR="$2" bash "$BOOT" >"$WORK/out" 2>&1 || { echo "FAIL bootstrap en erreur sur $1"; tail -15 "$WORK/out"; fail=1; }
}
# Base telle que l'ancien bootstrap la laissait : migrations sous les anciens noms, sans marqueur de renommage.
legacydb() { # base, dossier
  boot "$1" "$2"
  PGDATABASE="$1" psql -q -c "DELETE FROM public.migrations WHERE version = 'ss2i_000_legacy_rename'"
}
versions() { PGDATABASE="$1" psql -tA -c "SELECT string_agg(version, ',' ORDER BY version COLLATE \"C\") FROM public.migrations"; }
runs() { grep -c "Running" "$WORK/out"; }

# Dossier "ancien depot" : memes fichiers, nommes 004 a 009 comme avant le prefixe.
LEGACY="$WORK/legacy"; mkdir -p "$LEGACY"
cp "$SRC"/00[1-3]_migration.sql "$LEGACY"/
for i in 1 2 3 4 5 6; do cp "$SRC/ss2i_00${i}_migration.sql" "$LEGACY/00$((i + 3))_migration.sql"; done
NEW_ALL="001_migration,002_migration,003_migration,ss2i_000_legacy_rename,ss2i_001_migration,ss2i_002_migration,ss2i_003_migration,ss2i_004_migration,ss2i_005_migration,ss2i_006_migration"

# 1. Base vide : tout est applique, sous les noms ss2i_.
newdb kurrier_boot_a
boot kurrier_boot_a "$SRC"
check "base vide : 9 migrations appliquees" 9 "$(runs)"
check "base vide : noms enregistres" "$NEW_ALL" "$(versions kurrier_boot_a)"
boot kurrier_boot_a "$SRC"
check "base vide, 2e passage : rien rejoue" 0 "$(runs)"

# 2. Base migree par l'ancien depot (004 a 009) : renommage, rien rejoue, rien saute.
newdb kurrier_boot_b
legacydb kurrier_boot_b "$LEGACY"
check "ancienne base : noms d'origine" "001_migration,002_migration,003_migration,004_migration,005_migration,006_migration,007_migration,008_migration,009_migration" "$(versions kurrier_boot_b)"
boot kurrier_boot_b "$SRC"
check "ancienne base : rien rejoue" 0 "$(runs)"
check "ancienne base : noms renommes" "$NEW_ALL" "$(versions kurrier_boot_b)"
boot kurrier_boot_b "$SRC"
check "ancienne base, 2e passage : rien rejoue" 0 "$(runs)"

# 3. Base restee a mi-chemin (004 a 007 seulement) : les deux manquantes sont appliquees, pas les autres.
newdb kurrier_boot_c
PARTIAL="$WORK/partial"; mkdir -p "$PARTIAL"; cp "$LEGACY"/00[1-7]_migration.sql "$PARTIAL"/
legacydb kurrier_boot_c "$PARTIAL"
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

# 5. Base neuve, migrations amont 004 a 006 (autre contenu) puis une de nos migrations en echec au 1er passage, corrigee au
# 2e : le 2e demarrage ne doit pas renommer les 004 a 006 AMONT en ss2i_001 a 003 (marquees appliquees sans l'etre).
newdb kurrier_boot_d
FAIL5="$WORK/fail5"; mkdir -p "$FAIL5"; cp "$SRC"/*.sql "$FAIL5"/
for i in 4 5 6; do echo "CREATE TABLE amont_00${i}_probe (id int);" > "$FAIL5/00${i}_migration.sql"; done
GOOD5="$WORK/good5"; mkdir -p "$GOOD5"; cp "$FAIL5"/*.sql "$GOOD5"/
echo 'SELEC 1;' > "$FAIL5/ss2i_001_migration.sql"
check "base neuve, ss2i_001 en echec : bootstrap en erreur (code 3)" 3 "$(bootfail kurrier_boot_d "$FAIL5")"
boot kurrier_boot_d "$GOOD5"
check "echec puis correction : seules ss2i_001 a 006 rejouees" 6 "$(runs)"
check "echec puis correction : lignes amont intactes" "001_migration,002_migration,003_migration,004_migration,005_migration,006_migration,ss2i_000_legacy_rename,ss2i_001_migration,ss2i_002_migration,ss2i_003_migration,ss2i_004_migration,ss2i_005_migration,ss2i_006_migration" "$(versions kurrier_boot_d)"
check "echec puis correction : mcp_oauth_clients creee" "mcp_oauth_clients" "$(PGDATABASE=kurrier_boot_d psql -tA -c "SELECT to_regclass('public.mcp_oauth_clients')")"

# 6. Ancienne base, dossier copie a la main sans supprimer 004 a 009 : arret explicite avant de toucher la base.
newdb kurrier_boot_e
legacydb kurrier_boot_e "$LEGACY"
STALE="$WORK/stale"; mkdir -p "$STALE"; cp "$SRC"/*.sql "$STALE"/; cp "$LEGACY"/00[4-9]_migration.sql "$STALE"/
check "anciens fichiers restes : bootstrap refuse (code 3)" 3 "$(bootfail kurrier_boot_e "$STALE")"
check "anciens fichiers restes : message explicite" 1 "$(grep -c 'identique a ss2i_' "$WORK/out")"
check "anciens fichiers restes : base non touchee" "001_migration,002_migration,003_migration,004_migration,005_migration,006_migration,007_migration,008_migration,009_migration" "$(versions kurrier_boot_e)"

# 7. Aucune migration NNN du depot ne s'ecarte de l'amont : v4.4.0, a defaut v3.0.11 (001 a 003). Une NNN ajoutee
# ici (hors prefixe ss2i_) occuperait le numero d'une migration amont et celle-ci serait sautee en silence.
UPSTREAM_V4=5707ed41; UPSTREAM_V3=e271b0f9
if git -C "$ROOT" cat-file -e "$UPSTREAM_V4^{commit}" 2>/dev/null && git -C "$ROOT" cat-file -e "$UPSTREAM_V3^{commit}" 2>/dev/null; then
  for f in "$SRC"/[0-9][0-9][0-9]_migration.sql; do
    n="$(basename "$f")"; rel="db/init/migrations/$n"; drift=ecart
    for ref in $UPSTREAM_V4 $UPSTREAM_V3; do
      if git -C "$ROOT" show "$ref:$rel" 2>/dev/null | cmp -s - "$f"; then drift=ok; break; fi
    done
    check "$n identique a l'amont (sinon la renommer ss2i_NNN)" ok "$drift"
  done
else
  echo "skip controle de derive : commits amont $UPSTREAM_V4 / $UPSTREAM_V3 absents de ce depot"
fi

for d in a b c d e; do "${ADMIN[@]}" -c "DROP DATABASE IF EXISTS kurrier_boot_$d" >/dev/null; done
rm -rf "$WORK"
[ "$fail" = 0 ] && echo "Tous les tests passent." || echo "Echec."
exit "$fail"
