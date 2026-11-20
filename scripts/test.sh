#!/bin/sh
# Installe, type et teste, DANS le service node de compose.tools.yml (jamais sur le poste). Depuis la racine :
#   docker compose -f compose.tools.yml up -d
#   docker compose -f compose.tools.yml exec -T node scripts/test.sh install
#   docker compose -f compose.tools.yml exec -T node scripts/test.sh web [apps/web/test/x.ts ...]
#   docker compose -f compose.tools.yml exec -T node scripts/test.sh worker [apps/worker/test/x.ts ...]
#   docker compose -f compose.tools.yml exec -T node scripts/test.sh tsc-web | tsc-worker
# Sans fichier, `web` et `worker` lancent tous les tests du dossier, l'un apres l'autre ; sortie non nulle si l'un
# echoue. `worker` utilise la base de test migree (MCP_TEST_DATABASE_URL, posee par le service).
set -u
cd /repo

fail=0
tests() { # dossier, fichiers donnes -> liste a tester (les *-env.ts et mcp-fixtures.ts sont des aides)
  dir=$1; shift
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@"; else ls "$dir"/*.ts | grep -v -E -- '-env\.ts$|/mcp-fixtures\.ts$'; fi
}

each() { # description, commande a lancer avant le fichier, fichiers...
  desc=$1; cmd=$2; shift 2
  for t in "$@"; do
    if $cmd "$t" >"$HOME/.test-out" 2>&1; then echo "ok   $t"; else echo "FAIL $t"; tail -15 "$HOME/.test-out"; fail=1; fi
  done
  echo "$desc : $([ "$fail" = 0 ] && echo 'tout passe' || echo 'des tests echouent')"
}

case "${1:-}" in
  install)
    exec pnpm install --frozen-lockfile ;;
  tsc-web)
    exec apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false ;;
  tsc-worker)
    exec apps/web/node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit ;;
  web)
    shift
    each "tests web" "node_modules/.bin/tsx" $(tests apps/web/test "$@") ;;
  worker)
    shift
    [ -n "${MCP_TEST_DATABASE_URL:-}" ] || { echo "MCP_TEST_DATABASE_URL absent : lancer dans le service node de compose.tools.yml" >&2; exit 2; }
    each "tests worker" "node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json" $(tests apps/worker/test "$@") ;;
  *)
    echo "usage : scripts/test.sh install | tsc-web | tsc-worker | web [fichiers] | worker [fichiers]" >&2; exit 2 ;;
esac
exit "$fail"
