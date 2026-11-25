#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_HOME:-$HOME/.config/herdr-app}"
cd "$REPO"

git pull -q --ff-only

for d in mods/*/; do
  m=$(basename "$d")
  rsync -a --delete --exclude gpui-kit.d.ts --exclude .DS_Store --exclude /fonts/ --exclude /bin/spell "$HERDR/mods/$m/" "mods/$m/"
done
cp "$HERDR/layouts/clear.json" layouts/
cp "$HERDR/themes/clear.json" themes/
cp "$HOME/.local/bin/wt-ticket" "$HOME/.local/bin/wt-reap" bin/
cp "$HOME/.config/worktrunk/config.toml" worktrunk/
sed "s#$HOME#__HOME__#g" "$HOME/Library/LaunchAgents/at.dbdev.wt-reap.plist" > launchd/at.dbdev.wt-reap.plist

live="$HERDR/keys.json"
fragments=$(ls keys/*.json | grep -v '^keys/keys.json$')
for f in $fragments; do
  jq --slurpfile live "$live" '$live[0] as $l | with_entries(.key as $s
    | if $s == "global" then .value |= with_entries(select($l.global[.key] != null) | .value = $l.global[.key])
      else .value = ($l[$s] // .value) end)' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
done
jq -n --slurpfile live "$live" '[inputs | .global // {} | keys[]] as $owned | $live[0]
  | {global: (.global | with_entries(select(.key as $k | $owned | index($k) | not))), terminal}' $fragments > keys/keys.json.tmp
mv keys/keys.json.tmp keys/keys.json

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing changed."
  exit 0
fi
git add -A
git status --short
git commit -q -m "${1:-chore: update setup}"
git push -q
echo "Published. Others run ./update.sh"
