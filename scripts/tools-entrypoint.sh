#!/bin/sh
# Entree du service node de compose.tools.yml : active corepack dans ~/.local/bin (l'utilisateur 1000 ne peut
# pas ecrire dans /usr/local/bin ; le PATH du service l'y cherche), pour que `pnpm` soit la version du champ
# packageManager du package.json.
set -e
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin"
exec "$@"
