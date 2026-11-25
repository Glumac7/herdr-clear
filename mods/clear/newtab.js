import { spaces, panes, run } from "herdr";

// The space's directory is where its first terminal is now (what its name shows), else the folder it was made with.
export function spaceFolder(space) {
  const tabs = [...space.tabs].sort((a, b) => a.index - b.index);
  const all = panes();
  for (const tab of tabs) {
    const cwd = all.find((p) => p.tab === tab.id && p.terminal && p.cwd)?.cwd;
    if (cwd) return cwd;
  }
  return space.folder || null;
}

export function newTab(space = spaces().find((s) => s.active)) {
  if (!space) return run("tab.new");
  const folder = spaceFolder(space);
  run("tab.new", folder ? { space: space.id, folder } : { space: space.id });
}
