#!/usr/bin/env bash
# Test of db/init/db-bootstrap.sh: community_ prefix of this fork's migrations and pick-up of databases already
# migrated under the old names (004 to 007), single rename marker, guard against old files left in the folder,
# and a check that no 00N_migration.sql of the repository drifts from upstream.
# Usage: PGHOST=127.0.0.1 PGPORT=55460 PGUSER=postgres PGPASSWORD=test db/test/bootstrap-migrations.sh
# Creates then drops kurrier_boot_* databases on the given server; touches no other database.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOT="$ROOT/init/db-bootstrap.sh"
SRC="$ROOT/init/migrations"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-test.XXXXXX")"
export PGDATABASE=postgres
ADMIN=(psql -v ON_ERROR_STOP=1 -tA -q)
fail=0

check() { # description, expected, got
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fail=1; fi
}
newdb() { "${ADMIN[@]}" -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"; }
bootfail() { # database, folder -> exit code of the bootstrap, log in $WORK/out
  PGDATABASE="$1" MIGRATIONS_DIR="$2" bash "$BOOT" >"$WORK/out" 2>&1; echo $?
}
boot() { # database, folder -> bootstrap log in $WORK/out
  PGDATABASE="$1" MIGRATIONS_DIR="$2" bash "$BOOT" >"$WORK/out" 2>&1 || { echo "FAIL bootstrap failed on $1"; tail -15 "$WORK/out"; fail=1; }
}
# Database as the old bootstrap left it: migrations under the old names, without the rename marker.
legacydb() { # database, folder
  boot "$1" "$2"
  PGDATABASE="$1" psql -q -c "DELETE FROM public.migrations WHERE version = 'community_000_legacy_rename'"
}
versions() { PGDATABASE="$1" psql -tA -c "SELECT string_agg(version, ',' ORDER BY version COLLATE \"C\") FROM public.migrations"; }
runs() { grep -c "Running" "$WORK/out"; }

# "Old repository" folder: same files, named 004 to 007 as before the prefix.
LEGACY="$WORK/legacy"; mkdir -p "$LEGACY"
cp "$SRC"/00[1-3]_migration.sql "$LEGACY"/
for i in 1 2 3 4; do cp "$SRC/community_00${i}_migration.sql" "$LEGACY/00$((i + 3))_migration.sql"; done
OLD_ALL="001_migration,002_migration,003_migration,004_migration,005_migration,006_migration,007_migration"
NEW_ALL="001_migration,002_migration,003_migration,community_000_legacy_rename,community_001_migration,community_002_migration,community_003_migration,community_004_migration"

# 1. Empty database: everything is applied, under the community_ names.
newdb kurrier_boot_a
boot kurrier_boot_a "$SRC"
check "empty database: 7 migrations applied" 7 "$(runs)"
check "empty database: recorded names" "$NEW_ALL" "$(versions kurrier_boot_a)"
boot kurrier_boot_a "$SRC"
check "empty database, 2nd pass: nothing replayed" 0 "$(runs)"

# 2. Database migrated by the old repository (004 to 007): renamed, nothing replayed, nothing skipped.
newdb kurrier_boot_b
legacydb kurrier_boot_b "$LEGACY"
check "old database: original names" "$OLD_ALL" "$(versions kurrier_boot_b)"
boot kurrier_boot_b "$SRC"
check "old database: nothing replayed" 0 "$(runs)"
check "old database: names renamed" "$NEW_ALL" "$(versions kurrier_boot_b)"
boot kurrier_boot_b "$SRC"
check "old database, 2nd pass: nothing replayed" 0 "$(runs)"

# 3. Database left halfway (004 and 005 only): the two missing ones are applied, not the others.
newdb kurrier_boot_c
PARTIAL="$WORK/partial"; mkdir -p "$PARTIAL"; cp "$LEGACY"/00[1-5]_migration.sql "$PARTIAL"/
legacydb kurrier_boot_c "$PARTIAL"
boot kurrier_boot_c "$SRC"
check "database halfway: only community_003 and community_004 applied" 2 "$(runs)"
check "database halfway: recorded names" "$NEW_ALL" "$(versions kurrier_boot_c)"

# 4. Future collision: an upstream 004 (other content) arrives after the rename. It must be applied once, and
# not be renamed to community_001 on the next pass.
UP="$WORK/upstream"; mkdir -p "$UP"; cp "$SRC"/*.sql "$UP"/
echo 'CREATE TABLE upstream_004_probe (id int);' > "$UP/004_migration.sql"
boot kurrier_boot_b "$UP"
check "upstream 004 after rename: applied" 1 "$(runs)"
check "upstream 004: table created" "upstream_004_probe" "$(PGDATABASE=kurrier_boot_b psql -tA -c "SELECT to_regclass('public.upstream_004_probe')")"
boot kurrier_boot_b "$UP"
check "upstream 004, 2nd pass: nothing replayed" 0 "$(runs)"
check "upstream 004: recorded under its own name" "001_migration,002_migration,003_migration,004_migration,${NEW_ALL#001_migration,002_migration,003_migration,}" "$(versions kurrier_boot_b)"

# 5. Fresh database, upstream migrations 004 to 006 (other content) then one of ours failing on the 1st pass,
# fixed on the 2nd: the 2nd start must not rename the UPSTREAM 004 to 006 to community_001 to 003 (marked applied
# without having run).
newdb kurrier_boot_d
FAIL5="$WORK/fail5"; mkdir -p "$FAIL5"; cp "$SRC"/*.sql "$FAIL5"/
for i in 4 5 6; do echo "CREATE TABLE upstream_00${i}_probe (id int);" > "$FAIL5/00${i}_migration.sql"; done
GOOD5="$WORK/good5"; mkdir -p "$GOOD5"; cp "$FAIL5"/*.sql "$GOOD5"/
echo 'SELEC 1;' > "$FAIL5/community_001_migration.sql"
check "fresh database, community_001 failing: bootstrap fails (code 3)" 3 "$(bootfail kurrier_boot_d "$FAIL5")"
boot kurrier_boot_d "$GOOD5"
check "failure then fix: only community_001 to 004 replayed" 4 "$(runs)"
check "failure then fix: upstream rows intact" "001_migration,002_migration,003_migration,004_migration,005_migration,006_migration,community_000_legacy_rename,community_001_migration,community_002_migration,community_003_migration,community_004_migration" "$(versions kurrier_boot_d)"
check "failure then fix: mcp_oauth_clients created" "mcp_oauth_clients" "$(PGDATABASE=kurrier_boot_d psql -tA -c "SELECT to_regclass('public.mcp_oauth_clients')")"

# 6. Old database, folder copied by hand without deleting 004 to 007: explicit stop before touching the database.
newdb kurrier_boot_e
legacydb kurrier_boot_e "$LEGACY"
STALE="$WORK/stale"; mkdir -p "$STALE"; cp "$SRC"/*.sql "$STALE"/; cp "$LEGACY"/00[4-7]_migration.sql "$STALE"/
check "old files left: bootstrap refuses (code 3)" 3 "$(bootfail kurrier_boot_e "$STALE")"
check "old files left: explicit message" 1 "$(grep -c 'is identical to community_' "$WORK/out")"
check "old files left: database untouched" "$OLD_ALL" "$(versions kurrier_boot_e)"

# 7. No NNN migration of the repository drifts from upstream: v4.4.0, failing that v3.0.11 (001 to 003). An NNN
# added here (outside the community_ prefix) would take the number of an upstream migration, which would then be
# skipped silently.
UPSTREAM_V4=5707ed41; UPSTREAM_V3=e271b0f9
if git -C "$ROOT" cat-file -e "$UPSTREAM_V4^{commit}" 2>/dev/null && git -C "$ROOT" cat-file -e "$UPSTREAM_V3^{commit}" 2>/dev/null; then
  for f in "$SRC"/[0-9][0-9][0-9]_migration.sql; do
    n="$(basename "$f")"; rel="db/init/migrations/$n"; drift=drift
    for ref in $UPSTREAM_V4 $UPSTREAM_V3; do
      if git -C "$ROOT" show "$ref:$rel" 2>/dev/null | cmp -s - "$f"; then drift=ok; break; fi
    done
    check "$n identical to upstream (otherwise rename it community_NNN)" ok "$drift"
  done
else
  echo "skip drift check: upstream commits $UPSTREAM_V4 / $UPSTREAM_V3 absent from this repository"
fi

for d in a b c d e; do "${ADMIN[@]}" -c "DROP DATABASE IF EXISTS kurrier_boot_$d" >/dev/null; done
rm -rf "$WORK"
[ "$fail" = 0 ] && echo "All tests pass." || echo "Failed."
exit "$fail"
