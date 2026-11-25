#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_HOME:-$HOME/.config/herdr-app}"
BIN="${WT_BIN:-$HOME/.local/bin}"
MANAGED="mods layouts themes bin worktrunk launchd keys"
cd "$REPO"
trap 'rm -f keys/*.tmp' EXIT

git pull -q --ff-only

for d in mods/*/; do
  m=$(basename "$d")
  rsync -a --delete --exclude gpui-kit.d.ts --exclude .DS_Store --exclude /fonts/ --exclude /bin/spell "$HERDR/mods/$m/" "mods/$m/"
done
cp "$HERDR/layouts/clear.json" layouts/
cp "$HERDR/themes/clear.json" themes/
cp "$BIN/wt-ticket" "$BIN/wt-reap" bin/
cp "$HOME/.config/worktrunk/config.toml" worktrunk/
sed "s#$HOME#__HOME__#g" "$HOME/Library/LaunchAgents/at.dbdev.wt-reap.plist" > launchd/at.dbdev.wt-reap.plist

live="$HERDR/keys.json"
fragments=$(ls keys/*.json | grep -v '^keys/keys.json$')
for f in $fragments; do
  jq --slurpfile live "$live" '$live[0] as $l | with_entries(.key as $s
    | if $s == "global" then .value |= with_entries(select($l.global[.key] != null) | .value = $l.global[.key])
      else .value = $l[$s] end) | with_entries(select(.value != null))' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
done
jq -n --slurpfile live "$live" '[inputs | .global // {} | keys[]] as $owned | $live[0]
  | {global: (.global | with_entries(select(.key as $k | $owned | index($k) | not))), terminal}' $fragments > keys/keys.json.tmp
mv keys/keys.json.tmp keys/keys.json
unowned=$(jq -rn --slurpfile live "$live" '[inputs | keys[]] as $owned | $live[0] | keys[]
  | select(. != "global" and . != "terminal" and (. as $s | $owned | index($s) | not))' $fragments)
[ -z "$unowned" ] || echo "Not published (no keys/<part>.json has these sections):" $unowned

changes=$(git status --porcelain -- $MANAGED)
if [ -n "$changes" ]; then
  git add -A -- $MANAGED
  git status --short -- $MANAGED
  git commit -q -m "${1:-chore: update setup}" -- $MANAGED
fi
ahead=$(git rev-list @{u}..HEAD)
if [ -z "$ahead" ]; then
  echo "Nothing changed."
  exit 0
fi
git push -q
echo "Published. Others run ./update.sh"
