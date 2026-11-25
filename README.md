# herdr-clear

My [Herdr](https://herdr.dev) setup: the **Clear** layout (chat view for omp sessions, YouTrack tickets, worktrees, subagents, `/btw` side chat) and the panels around it.

## Install

```sh
git clone git@github.com:Glumac7/herdr-clear.git && cd herdr-clear
./install.sh                    # everything
./install.sh clear sentry       # only some parts
./install.sh --list             # shows the parts (same as --help)
```

Existing files and keys are kept and listed; `--force` replaces them. Your `keys.json` is backed up once to `keys.json.before-herdr-clear`. Then switch layouts in Herdr with `cmd-shift-l` → `clear`.

## Update

```sh
./update.sh
```

Pulls and reinstalls the parts you installed. It overwrites your own edits to those parts and any of your keys that differ.

## Publish (maintainer)

`./publish.sh ["commit message"]` copies the live setup from this Mac into the repo, commits and pushes.

## Parts

| Part | What | Needs |
|---|---|---|
| `clear` | layout, theme, `clear` + `clear-tabs` mods, `layout:clear` and panel keys; pulls in `worktrees` | `omp`, `gh`, `YOUTRACK_PERMANENT_TOKEN` in `~/.zshrc`, Xcode CLT for spell hints |
| `worktrees` | `~/.local/bin/wt-ticket`, `wt-reap` (launch agent, every 30 min), worktrunk config, Herdr worktree folder `~/worktrees` | `wt` (worktrunk), `/opt/homebrew/bin/python3`, repos in `~/durchblicker` |
| `keys` | base macOS keymap (`cmd-t`, `cmd-d`, `cmd-1`…) | |
| `ticket-desk` | tickets panel (`cmd-shift-t`) | `/opt/homebrew/bin/python3` |
| `remote-checker` `servers` `skills` | GH, servers, skills panels (`cmd-shift-g/r/k`) | `gh` |
| `agenttrail` | agent map panel (`cmd-shift-m`) | |
| `usage-limits` | usage in the status bar | |
| `sentry` | Sentry popup (`cmd-s`) | `sentry-cli login` |
| `claude-usage` | Claude usage popup (`cmd-shift-u`) | Claude Code login |

The Clear layout has blocks for every panel; a panel you skip shows Herdr's fallback menu there.

`agenttrail`, `usage-limits`, `remote-checker`, `servers` and `skills` are other people's MIT mods, vendored as I run them; see [THIRD_PARTY.md](THIRD_PARTY.md).
