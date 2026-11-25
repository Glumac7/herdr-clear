#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_HOME:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}}"
BIN="${WT_BIN:-$HOME/.local/bin}"
MANAGED="mods layouts themes bin worktrunk launchd keys"
cd "$REPO"
trap 'rm -f keys/*.tmp' EXIT
SYNCED_FILE="$HERDR/.herdr-clear-synced"

git fetch -q
[ -s "$SYNCED_FILE" ] || {
  echo "No sync record at $SYNCED_FILE, so publish can't tell whether your live setup has everything in the repo." >&2
  echo "If it does (you published last): git rev-parse @{u} > $SYNCED_FILE. Otherwise save unpublished edits and run ./install.sh --force first." >&2
  exit 1
}
synced=$(cat "$SYNCED_FILE")
git cat-file -e "$synced^{commit}" 2>/dev/null || { echo "Sync record $synced is not in this clone; run ./install.sh --force after saving unpublished edits." >&2; exit 1; }
theirs=$(git log --format= --name-only "$synced..@{u}" -- $MANAGED | sort -u)
if [ -n "$theirs" ]; then
  echo "The repo has setup changes this Mac doesn't have; publishing now would undo them:" >&2
  printf '  %s\n' $theirs >&2
  echo "Save any unpublished edits, run: git pull --rebase && ./install.sh --force, redo your edits, then ./publish.sh." >&2
  exit 1
fi

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
  | {global: ((.global // {}) | with_entries(select(.key as $k | $owned | index($k) | not))), terminal} | with_entries(select(.value != null))' $fragments > keys/keys.json.tmp
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
before=$(git rev-parse HEAD)
if ! git pull -q --rebase --autostash; then
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    echo "Conflict with repo changes made while publishing: resolve it, git rebase --continue, ./install.sh --force, then ./publish.sh." >&2
  else
    echo "git pull failed (see above); fix it and run ./publish.sh again." >&2
  fi
  exit 1
fi
if ! git diff --quiet "$before" HEAD -- $MANAGED; then
  echo "The repo changed while publishing. Run ./install.sh --force (your edits are committed), then ./publish.sh." >&2
  exit 1
fi
ahead=$(git rev-list "@{u}..HEAD")
if [ -n "$ahead" ]; then
  git push -q
  echo "Published. Others run ./update.sh"
else
  echo "Nothing changed."
fi
git rev-parse HEAD > "$SYNCED_FILE"
