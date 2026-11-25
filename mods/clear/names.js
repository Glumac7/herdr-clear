import { agents, spaces, run, shared, setShared } from "herdr";

const AUTO = "clear.tabnames";

// omp titles its terminal "π ⠴ 🍎 HERDR: Restyle herdr UI": prompt glyph, spinner, emoji, category, summary.
export function parseTitle(raw) {
  const s = (raw ?? "").replace(/^[\sπ>⠀-⣿·•-]+/u, "").trim();
  const m = /^(\p{Extended_Pictographic}\uFE0F?)?\s*(?:([A-Z][A-Z0-9-]{1,15}):\s+)?(.*)$/u.exec(s);
  return { emoji: m?.[1] ?? null, tag: m?.[2] ?? null, text: (m?.[3] ?? s).trim() };
}

export const sessionName = (raw) => {
  const { emoji, text } = parseTitle(raw);
  return [emoji, text].filter(Boolean).join(" ");
};

// Tabs nobody named take their omp session's name, so the tab bar, sidebar and chat say the same thing.
// A name someone gave a tab is never touched.
export function syncTabNames(cx) {
  const auto = shared(AUTO) ?? {};
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, t])));
  const renames = [];
  for (const a of agents()) {
    const tab = tabs.get(a.tab);
    const want = sessionName(a.title).slice(0, 48);
    if (!tab || !want || want === "omp" || tab.name === want) continue;
    if (tab.named && auto[tab.id] !== tab.name) continue;
    if (renames.some((r) => r.id === tab.id)) continue;
    renames.push({ id: tab.id, name: want });
  }
  if (!renames.length) return;
  cx.timer.after(0, () => {
    setShared(AUTO, { ...auto, ...Object.fromEntries(renames.map((r) => [r.id, r.name])) });
    for (const r of renames) run("tab.rename", r);
  });
}
