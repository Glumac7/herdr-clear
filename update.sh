#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_HOME:-$HOME/.config/herdr-app}"
STATE="$HERDR/.herdr-clear-parts"

[ -s "$STATE" ] || { echo "No install record at $STATE. Run ./install.sh <parts> once so update knows what you use." >&2; exit 1; }
git -C "$REPO" pull -q --ff-only
exec "$REPO/install.sh" --force $(cat "$STATE")
