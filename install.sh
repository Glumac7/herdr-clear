#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_HOME:-$HOME/.config/herdr-app}"
BIN="${WT_BIN:-$HOME/.local/bin}"
FONTS=/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts
PANEL_MODS="ticket-desk remote-checker servers skills agenttrail usage-limits"
ALL="clear worktrees keys $PANEL_MODS sentry claude-usage"

usage() {
  cat <<EOF
Usage: ./install.sh [--force] [part ...]

No part installs everything. Parts:
  clear        the Clear layout, theme, clear + clear-tabs mods, their keys (needs: worktrees)
  worktrees    wt-ticket, wt-reap (+ launch agent), worktrunk config, Herdr worktree folder
  keys         the base macOS keymap (cmd-t, cmd-d, ...)
  $PANEL_MODS
  sentry claude-usage

--force replaces what already exists (mods, layout, theme, scripts, config, conflicting keys).
Without it, existing things are kept and listed.
EOF
}

FORCE=0
PARTS=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help|--list) usage; exit 0 ;;
    *) case " $ALL " in *" $a "*) PARTS+=("$a") ;; *) echo "Unknown part: $a" >&2; usage >&2; exit 2 ;; esac ;;
  esac
done
[ ${#PARTS[@]} -gt 0 ] || PARTS=($ALL)
case " ${PARTS[*]} " in *" clear "*) case " ${PARTS[*]} " in *" worktrees "*) ;; *) PARTS+=(worktrees) ;; esac ;; esac

command -v jq >/dev/null || { echo "jq is required (brew install jq)" >&2; exit 1; }
[ -d "$HERDR" ] || { echo "No Herdr app folder at $HERDR; start Herdr once first." >&2; exit 1; }

SKIPPED=()
FAILED=()
MODS=()

place() { # src dest; returns 1 only when an existing dest is kept
  if [ -e "$2" ] && [ $FORCE = 0 ]; then SKIPPED+=("$2"); return 1; fi
  rm -rf "$2" && mkdir -p "$(dirname "$2")" && cp -R "$1" "$2" || { echo "Failed to install $2" >&2; exit 1; }
}

mod() {
  place "$REPO/mods/$1" "$HERDR/mods/$1" && MODS+=("$1") || true
  [ -f "$REPO/keys/$1.json" ] && keys "$REPO/keys/$1.json"
  return 0
}

keys() { # fragment
  local file="$HERDR/keys.json" merged conflicts
  [ -f "$file" ] || echo '{}' > "$file"
  conflicts=$(jq -r --slurpfile f "$1" '. as $k | $f[0] | to_entries[] | .key as $s | .value | to_entries[]
    | select($k[$s][.key] != null and $k[$s][.key] != .value) | "\($s) \(.key)"' "$file")
  if [ -n "$conflicts" ] && [ $FORCE = 0 ]; then
    while IFS= read -r c; do SKIPPED+=("key $c"); done <<< "$conflicts"
    merged=$(jq --slurpfile f "$1" '. as $k | reduce ($f[0] | to_entries[]) as $s ($k;
      .[$s.key] = (($s.value) + (.[$s.key] // {})))' "$file")
  else
    merged=$(jq --slurpfile f "$1" '. as $k | reduce ($f[0] | to_entries[]) as $s ($k;
      .[$s.key] = ((.[$s.key] // {}) + $s.value))' "$file")
  fi
  [ -f "$file.before-herdr-clear" ] || cp "$file" "$file.before-herdr-clear"
  printf '%s\n' "$merged" > "$file"
}

install_clear() {
  place "$REPO/layouts/clear.json" "$HERDR/layouts/clear.json" || true
  place "$REPO/themes/clear.json" "$HERDR/themes/clear.json" || true
  mod clear
  mod clear-tabs
  local dir="$HERDR/mods/clear"
  mkdir -p "$dir/fonts" "$dir/bin"
  if [ -d "$FONTS" ]; then
    cp "$FONTS"/SF-Mono-{Regular,RegularItalic,Medium,MediumItalic,Semibold,SemiboldItalic,Bold,BoldItalic}.otf "$dir/fonts/"
  else
    echo "SF Mono not found at $FONTS; Clear falls back to Herdr's monospace font."
  fi
  if command -v swiftc >/dev/null; then
    swiftc -O "$dir/bin/spell.swift" -o "$dir/bin/spell" 2>/dev/null || echo "Building the spell checker failed; spelling hints stay off."
  else
    echo "swiftc missing (xcode-select --install); spelling hints stay off."
  fi
}

install_worktrees() {
  mkdir -p "$BIN" "$HOME/.local/state/wt-reap"
  for s in wt-ticket wt-reap; do
    if place "$REPO/bin/$s" "$BIN/$s"; then chmod +x "$BIN/$s"; fi
  done
  place "$REPO/worktrunk/config.toml" "$HOME/.config/worktrunk/config.toml" || true
  local settings="$HERDR/settings.json"
  [ -f "$settings" ] || echo '{}' > "$settings"
  local current next
  current=$(jq -r '.worktrees.directory // empty' "$settings")
  if [ -z "$current" ] || [ $FORCE = 1 ]; then
    next=$(jq '.worktrees.directory = "~/worktrees"' "$settings")
    printf '%s\n' "$next" > "$settings"
  fi
  local plist="$HOME/Library/LaunchAgents/at.dbdev.wt-reap.plist"
  if [ ! -e "$plist" ] || [ $FORCE = 1 ]; then
    mkdir -p "$(dirname "$plist")"
    sed "s#__HOME__#$HOME#g" "$REPO/launchd/at.dbdev.wt-reap.plist" > "$plist"
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    SKIPPED+=("$plist")
  fi
}

for p in "${PARTS[@]}"; do
  case "$p" in
    clear) install_clear ;;
    worktrees) install_worktrees ;;
    keys) keys "$REPO/keys/keys.json" ;;
    *) mod "$p" ;;
  esac
done

STATE="$HERDR/.herdr-clear-parts"
{ if [ -f "$STATE" ]; then cat "$STATE"; fi; printf '%s\n' "${PARTS[@]}"; } | sort -u > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"

if command -v herdr-app >/dev/null; then
  for m in ${MODS[@]+"${MODS[@]}"}; do
    herdr-app check "$HERDR/mods/$m" >/dev/null || FAILED+=("$m")
  done
else
  echo "herdr-app not on PATH; mods were not checked."
fi

echo "Installed: ${PARTS[*]}"
[ ${#SKIPPED[@]} = 0 ] || { echo "Kept (already there, use --force to replace):"; printf '  %s\n' "${SKIPPED[@]}"; }
[ ${#FAILED[@]} = 0 ] || { echo "herdr-app check failed: ${FAILED[*]}" >&2; exit 1; }
