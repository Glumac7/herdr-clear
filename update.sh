#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
git -C "$REPO" pull -q --ff-only
exec "$REPO/install.sh" --update
