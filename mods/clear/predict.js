import { exec, home } from "herdr";

// Next-word ghost text like omp's own composer: an n-gram model of your past omp prompts (~/.omp/agent/history.db).
const WORD = /[\p{L}\p{N}'’_-]+/gu;
const TTL = 10 * 60 * 1000;

class Model {
  constructor() {
    this.uni = new Map();
    this.next = new Map();
    this.forms = new Map();
    this.at = 0;
    this.loading = null;
  }

  // Loads in the background; predictions start once it's in and refresh every ten minutes.
  warm() {
    if (this.loading || Date.now() - this.at < TTL) return;
    this.loading = exec("sqlite3", ["-json", `${home()}/.omp/agent/history.db`, "select prompt, use_count from history order by id desc limit 5000"],
      { timeout: 15000 }).then((r) => {
      if (r.code !== 0) return;
      this.uni.clear();
      this.next.clear();
      for (const row of JSON.parse(r.stdout || "[]")) this.learn(row.prompt, row.use_count || 1);
      this.at = Date.now();
    }).catch(() => {}).finally(() => { this.loading = null; });
  }

  learn(text, weight = 1) {
    const words = text.match(WORD) ?? [];
    const keys = words.map((w) => w.toLowerCase());
    keys.forEach((k, i) => {
      if (!this.forms.has(k)) this.forms.set(k, words[i]);
      this.uni.set(k, (this.uni.get(k) ?? 0) + weight);
      if (i > 0) this.bump(keys[i - 1], k, weight);
      if (i > 1) this.bump(`${keys[i - 2]} ${keys[i - 1]}`, k, weight);
    });
  }

  bump(context, word, weight) {
    let m = this.next.get(context);
    if (!m) this.next.set(context, (m = new Map()));
    m.set(word, (m.get(word) ?? 0) + weight);
  }

  best(context, prefix, min) {
    const m = this.next.get(context);
    if (!m) return null;
    let total = 0;
    let top = null;
    for (const [w, n] of m) {
      total += n;
      if (w.startsWith(prefix) && w !== prefix && (!top || n > top[1])) top = [w, n];
    }
    return top && top[1] >= min && top[1] / total >= (prefix ? 0 : 0.2) ? top[0] : null;
  }

  // The rest of the word being typed, or the next word after a space; null when nothing is likely enough.
  predict(before) {
    if (!this.at) return null;
    const partial = /[\p{L}\p{N}'’_-]*$/u.exec(before)[0];
    if (!partial && !/[ \t]$/.test(before)) return null;
    const words = (before.slice(0, before.length - partial.length).match(WORD) ?? []).map((w) => w.toLowerCase());
    const p1 = words.at(-1);
    const p2 = words.at(-2);
    const prefix = partial.toLowerCase();
    let word = (p2 && this.best(`${p2} ${p1}`, prefix, 2)) || (p1 && this.best(p1, prefix, partial ? 2 : 3));
    if (!word && prefix.length >= 2) {
      let top = null;
      for (const [w, n] of this.uni) if (n >= 3 && w.length > prefix.length && w.startsWith(prefix) && (!top || n > top[1])) top = [w, n];
      word = top?.[0];
    }
    if (!word) return null;
    const form = this.forms.get(word) ?? word;
    return form.slice(partial.length) || null;
  }
}

export const model = new Model();
