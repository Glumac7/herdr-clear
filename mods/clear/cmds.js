import { exec, shared, setShared } from "herdr";
import { COMMANDS } from "./commands.js";

// omp's command list, asked from omp itself (its RPC mode lists every builtin, skill, plugin and prompt command with
// its subcommands). Commands only the interactive terminal has are added from commands.js. Kept per folder,
// because project skills and plugins differ.
const CACHE = "clear.cmds.live";
const TTL = 30 * 60000;

// Starts omp in RPC mode in the background, waits for the command list line it prints at startup, then stops it.
// (omp keeps running after its input closes, so it's killed rather than waited for.)
const FETCH = 'out=$(mktemp); (sleep 40 | omp --mode rpc --no-session > "$out" 2>/dev/null) & p=$!; '
  + 'for i in $(seq 1 120); do grep -m1 available_commands_update "$out" && break; sleep 0.25; done; '
  + 'pkill -P $p 2>/dev/null; kill $p 2>/dev/null; rm -f "$out"';

const GROUPS = [
  ["Modes", "plan plan-review vibe goal guided-goal fast slow advisor skillful extended-context computer browser prewalk ratchet autoresearch"],
  ["Model", "model switch effort modelpreset login logout setup agents"],
  ["Context", "context compact shake handoff clear todo memory force btw tan queue"],
  ["Session", "new resume rename fork branch tree pin unpin delete move wt export share dump collab join leave session restart retry fresh add-dir remove-dir dirs commit"],
  ["Views", "usage stats trace tools jobs hub extensions changelog hotkeys settings git local copy open debug security"],
].map(([name, list]) => [name, new Set(list.split(" "))]);
export const ORDER = ["Modes", "Model", "Context", "Session", "Views", "Workflows", "Skills"];

const groupOf = (c) => c.source === "skill" ? "Skills"
  : GROUPS.find(([, set]) => set.has(c.name))?.[0] ?? "Workflows";

// The terminal-only table says which commands open a panel; those show in a sheet.
const PANELS = new Set(COMMANDS.filter((c) => c[3]).map((c) => c[0]));

function merge(live) {
  const names = new Set(live.map((c) => c.name));
  const list = live.map((c) => ({
    name: c.name,
    hint: c.input?.hint && c.input.hint !== "arguments" ? c.input.hint : c.source === "skill" ? "[what to do]" : c.input?.hint === "arguments" ? "[arguments]" : "",
    desc: c.description ?? "",
    subs: (c.subcommands ?? []).map((s) => ({ name: s.name, desc: s.description ?? "", usage: s.usage ?? "" })),
    source: c.source,
    panel: PANELS.has(c.name),
  }));
  for (const [name, hint, desc, panel] of COMMANDS) {
    if (!names.has(name)) list.push({ name, hint, desc, subs: [], source: "builtin", panel: Boolean(panel) });
  }
  // Within a group, commands keep the order of the list above: the everyday ones first.
  return list.map((c) => {
    const group = groupOf(c);
    const order = [...(GROUPS.find(([g]) => g === group)?.[1] ?? [])].indexOf(c.name);
    return { ...c, group, rank: ORDER.indexOf(group) * 1000 + (order < 0 ? 999 : order) };
  });
}

// omp's raw list is cached; the catalog is built from it on read (once per list), so grouping changes apply at once.
const built = new Map();

export function catalog(cwd) {
  const entry = (shared(CACHE) ?? {})[cwd];
  const key = `${cwd}:${entry?.at ?? 0}`;
  if (!built.has(key)) built.set(key, merge(entry?.live ?? []));
  return built.get(key);
}

export async function refreshCatalog(cwd) {
  const entry = (shared(CACHE) ?? {})[cwd];
  if (!cwd || (entry && (entry.loading || Date.now() - entry.at < TTL))) return;
  setShared(CACHE, { ...(shared(CACHE) ?? {}), [cwd]: { ...(entry ?? {}), loading: true, at: entry?.at ?? 0 } });
  const r = await exec("bash", ["-c", FETCH], { cwd, timeout: 45000 }).catch(() => null);
  let live = null;
  try { live = JSON.parse(r?.stdout ?? "").commands; } catch {}
  const prev = (shared(CACHE) ?? {})[cwd];
  // A failed fetch keeps the last list and tries again in a minute.
  setShared(CACHE, { ...(shared(CACHE) ?? {}), [cwd]: live
    ? { at: Date.now(), live }
    : { at: Date.now() - TTL + 60000, live: prev?.live } });
}

export const findCommand = (cwd, name) => catalog(cwd).find((c) => c.name === name) ?? null;

// Whether a picked command still needs something from you before it runs.
export const needsInput = (c) => Boolean(c && (c.subs.length || /^</.test(c.hint)));
