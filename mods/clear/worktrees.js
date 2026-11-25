import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, run, theme, home, checking, notify, readTextFile, watchFolder } from "herdr";
import { UI, MONO, SIZE, dot, button, section, short } from "./kit.js";

const STATE = () => `${home()}/.local/state/wt-reap`;
const REAP = () => `${home()}/.local/bin/wt-reap`;
const WARN = /uncommitted|untracked|not pushed|commits after|closed unmerged/;

function age(iso) {
  if (!iso) return "";
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return d < 1 ? "today" : `${d}d`;
}

export class WorktreeState {
  constructor() {
    this.report = null;
    this.busy = null;
    this.armed = null;
    this.folded = {};
  }

  start(cx) {
    if (checking()) return;
    this.load(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(STATE()); } catch { return; }
        await this.load(cx);
      }
    });
  }

  async load(cx) {
    try {
      const text = await readTextFile(`${STATE()}/report.json`);
      this.report = text ? JSON.parse(text) : null;
    } catch {}
    cx.notify();
  }

  reap(cx, apply) {
    if (this.busy) return;
    this.busy = apply ? "Removing…" : "Scanning…";
    this.armed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("/opt/homebrew/bin/python3", [REAP(), ...(apply ? ["--apply"] : [])], { timeout: 600000 })
        .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      const gone = (r.stdout ?? "").split("\n").filter((l) => l.includes("(removed)")).length;
      if (r.code !== 0) notify({ title: "Worktree scan failed", body: (r.stderr ?? "").trim().split("\n").pop(), level: "error" });
      else if (apply) notify({ title: `${gone} worktree${gone === 1 ? "" : "s"} removed`, level: "success", timeout: 5000 });
      this.busy = null;
      await this.load(cx);
    });
  }

  remove(cx, repo, row) {
    this.armed = null;
    this.busy = `Removing ${row.branch ?? "worktree"}…`;
    cx.notify();
    const merged = row.prs.some((p) => p.state === "MERGED");
    cx.spawn(async (cx) => {
      const r = await exec("wt", ["-C", repo.path, "remove", row.path, "--foreground", "--yes", ...(merged ? ["--force-delete"] : [])], { timeout: 300000 })
        .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) notify({ title: "Not removed", body: (r.stderr ?? "").trim().split("\n").pop(), level: "error" });
      this.busy = null;
      this.reap(cx, false);
    });
  }
}

function row(t, state, repo, w) {
  const key = `rm:${w.path}`;
  const armed = state.armed === key;
  const tone = w.action !== "keep" ? t.done : WARN.test(w.reason) ? t.blocked : t.dim;
  const reason = w.reason.charAt(0).toUpperCase() + w.reason.slice(1);
  return v_flex().id(`wt-${w.path}`).px(10).py(8).gap(4).rounded(6).bg(armed ? t.blocked + "14" : t.chrome)
    .hover((s) => s.bg(armed ? t.blocked + "14" : t.hover))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.body).text_color(t.foreground)
        .tooltip(short(w.path)).child(w.branch ?? short(w.path)))
      .child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(age(w.committed_at))))
    .child(h_flex().gap(8).items_center().flex_wrap()
      .child(dot(tone, 6))
      .child(div().font_family(UI).font_weight(500).text_size(SIZE.meta).text_color(w.action === "keep" ? t.muted : t.done)
        .child(w.action === "keep" ? reason : `Safe to remove · ${w.reason}`))
      .children(w.prs.slice(0, 3).map((p) => div().id(`wt-pr-${w.path}-${p.number}`).font_family(MONO).text_size(SIZE.meta)
        .text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .tooltip(`${p.state.toLowerCase()} · open on GitHub`).on_click((_e, cx) => { cx.stop_propagation(); exec("open", [p.url]); })
        .child(`#${p.number}`))))
    .child(h_flex().gap(6).pt(2)
      .child(button(`wt-open-${w.path}`, "Open", "New space in this worktree",
        () => run("space.new", { folder: w.path, name: (w.branch ?? "").split("/").pop() || undefined })))
      .child(button(`wt-rm-${w.path}`, armed ? "Confirm remove" : "Remove",
        armed ? "wt remove (refuses uncommitted changes)" : "Remove this worktree",
        (cx) => { if (!armed) { state.armed = key; cx.notify(); } else state.remove(cx, repo, w); }, "danger", armed)));
}

export function worktrees(state) {
  const t = theme();
  const rep = state.report;
  const repos = (rep?.repos ?? []).filter((r) => r.worktrees?.length || r.error);
  const ready = repos.reduce((n, r) => n + (r.worktrees ?? []).filter((w) => w.action !== "keep").length, 0);
  const total = repos.reduce((n, r) => n + (r.worktrees ?? []).length, 0);
  const armed = state.armed === "reap";
  const tools = h_flex().gap(6)
    .child(button("wt-scan", "Scan", "Scan all repos (removes nothing)", (cx) => state.reap(cx, false)))
    .when(ready > 0, (el) => el.child(button("wt-reap", armed ? `Remove ${ready}` : `Clean up ${ready}`,
      armed ? "Removes every worktree marked safe to remove" : "Remove what is merged or stale",
      (cx) => { if (!armed) { state.armed = "reap"; cx.notify(); } else state.reap(cx, true); }, "danger", armed)));
  return v_flex().size_full().bg(t.chrome)
    .child(section("Worktrees", total, tools))
    .child(div().px(12).pb(6).font_family(UI).text_size(SIZE.meta).text_color(state.busy ? t.working : t.dim)
      .child(state.busy ?? (rep ? `${ready} safe to remove · scanned ${age(rep.at)}` : "Not scanned yet.")))
    .child(v_flex().id("wt-list").flex_1().min_h(0).overflow_y_scroll().px(6).pb(10).gap(14)
      .children(repos.map((r) => {
        const folded = state.folded[r.repo];
        const go = (r.worktrees ?? []).filter((w) => w.action !== "keep").length;
        return v_flex().gap(2)
          .child(h_flex().id(`wt-repo-${r.repo}`).h(24).px(6).gap(6).items_center().cursor_pointer()
            .on_click((_e, cx) => { state.folded[r.repo] = !folded; cx.notify(); })
            .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted).child(r.repo))
            .child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(String(r.worktrees?.length ?? 0)))
            .child(div().flex_1())
            .when(go > 0, (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(t.done).child(`${go} to remove`)))
            .when(folded, (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child("Show"))))
          .when(Boolean(r.error), (el) => el.child(div().px(10).font_family(UI).text_size(SIZE.meta).text_color(t.blocked).child(r.error)))
          .when(!folded, (el) => el.children([...(r.worktrees ?? [])]
            .sort((a, b) => (a.action === "keep") - (b.action === "keep"))
            .map((w) => row(t, state, r, w))));
      })));
}
