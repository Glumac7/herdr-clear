#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_HOME:-$HOME/.config/herdr-app}"

git -C "$REPO" pull -q --ff-only
parts=$(cat "$HERDR/.herdr-clear-parts" 2>/dev/null || true)
exec "$REPO/install.sh" --force $parts
