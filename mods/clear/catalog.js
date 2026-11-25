import { exec, shared, setShared } from "herdr";

const CACHE = "clear.models.cache";
const DEFAULT = "clear.models.default";
const TTL = 600000;

export const PROVIDERS = {
  anthropic: { name: "Anthropic", color: "#d97757", icon: "anthropic" },
  openai: { name: "OpenAI", color: "#10a37f", icon: "openai" },
  "openai-codex": { name: "OpenAI Codex", color: "#10a37f", icon: "openai" },
};

export const provider = (id) => PROVIDERS[id] ?? { name: id ?? "", color: null, icon: null };

// Dated snapshots (claude-opus-4-5-20251101) are the same model as their alias; list each model once.
const dedupe = (list) => {
  const ids = new Set(list.map((m) => m.selector));
  return list.filter((m) => !(/-\d{8}$/.test(m.selector) && ids.has(m.selector.replace(/-\d{8}$/, ""))));
};

// `omp models --json`, kept for 10 minutes so dialogs open without a wait and the context meter knows each window.
export async function modelList() {
  const cached = shared(CACHE);
  if (cached && Date.now() - cached.at < TTL) return dedupe(cached.list);
  const r = await exec("omp", ["models", "--json"], { timeout: 20000 });
  const list = JSON.parse(r.stdout).models.filter((m) => m.kind === "chat");
  setShared(CACHE, { at: Date.now(), list });
  return dedupe(list);
}

export const cachedModel = (selector) => (shared(CACHE)?.list ?? []).find((m) => m.selector === selector) ?? null;

const VERSION = /\d+(?:\.\d+)*/;
const newer = (a, b) => {
  const [x, y] = [a, b].map((m) => (m.name.match(VERSION)?.[0] ?? "0").split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

// One model per family (Claude Opus, GPT Sol, …): the highest version in its name.
export function latest(list) {
  const best = new Map();
  for (const m of list) {
    const family = `${m.provider}:${m.name.replace(VERSION, "").replace(/\s+/g, " ").trim()}`;
    if (!best.has(family) || newer(m, best.get(family))) best.set(family, m);
  }
  const keep = new Set(best.values());
  return list.filter((m) => keep.has(m));
}

const REACH = "clear.models.reach";
const RECHECK = 86400000;
const PROBE = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-context-files", "--no-extensions",
  "--no-lsp", "--allow-home", "--system-prompt", "Reply with OK.", "--thinking", "low"];

// omp lists every model the provider's catalog knows, including ones this account gets a 404 for.
export const available = (m) => (shared(REACH) ?? {})[m.selector]?.ok !== false;

// One tiny call per model, remembered; only a "model not found" answer hides it, and that is re-checked daily.
export async function checkModels(list) {
  const due = list.filter((m) => {
    const r = (shared(REACH) ?? {})[m.selector];
    return !r || (!r.ok && Date.now() - r.at > RECHECK);
  });
  const worker = async () => {
    for (let m = due.shift(); m; m = due.shift()) {
      const r = await exec("omp", [...PROBE, "--model", m.selector, "ping"], { cwd: "/tmp", timeout: 90000 }).catch(() => null);
      if (!r) continue;
      const ok = !/not_found_error/.test(`${r.stdout}${r.stderr}`);
      setShared(REACH, { ...(shared(REACH) ?? {}), [m.selector]: { ok, at: Date.now() } });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

const setting = async (key) =>
  JSON.parse((await exec("omp", ["config", "get", key, "--json"], { timeout: 10000 })).stdout).value;

// omp writes no session file before the first message, so a fresh agent's model is omp's default role.
export async function defaultModel() {
  const cached = shared(DEFAULT);
  if (cached && Date.now() - cached.at < TTL) return cached;
  const [roles, level] = await Promise.all([setting("modelRoles"), setting("defaultThinkingLevel")]);
  const [model, effort] = String(roles?.default ?? "").split(":");
  const value = { at: Date.now(), model: model || null, effort: effort || level || null };
  setShared(DEFAULT, value);
  return value;
}

export const cachedDefault = () => shared(DEFAULT) ?? null;
