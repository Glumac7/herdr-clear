import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, run, theme, props, closeOverlay, spaces, knownAgents, home, checking, notify, setShared } from "herdr";
import { UI, MONO, SIZE, button } from "./kit.js";
import { ticketTree, flatten, briefText, writeBrief, moveInProgress, firstMessage } from "./brief.js";
import { STARTED } from "./youtrack.js";

const HELPER = () => `${home()}/.local/bin/wt-ticket`;

export class StartState {
  constructor() {
    this.repos = null;
    this.error = null;
    this.busy = null;
  }

  start(cx) {
    if (checking()) return;
    const { ticket } = props();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/opt/homebrew/bin/python3", [HELPER(), "repos", ticket], { timeout: 60000 });
        this.repos = JSON.parse(r.stdout);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  go(cx, repo, branch) {
    if (this.busy) return;
    const { ticket, summary, overlay } = props();
    this.busy = repo.all ? `${ticket}: preparing…` : `${repo.repo}: preparing worktree…`;
    cx.notify();
    cx.spawn(async (cx) => {
      let res = { path: `${home()}/durchblicker`, branch: null };
      if (!repo.all) {
        const r = await exec("/opt/homebrew/bin/python3",
          [HELPER(), "start", repo.repo, ticket, summary, ...(branch ? ["--branch", branch] : [])], { timeout: 600000 })
          .catch((e) => ({ stdout: JSON.stringify({ error: String(e?.message ?? e) }) }));
        try { res = JSON.parse(r.stdout || r.stderr); } catch { res = { error: (r.stderr || "failed").trim() }; }
      }
      if (res.error) {
        this.busy = null;
        this.error = res.error;
        cx.notify();
        return;
      }
      this.busy = `${ticket}: reading ticket and subtasks…`;
      cx.notify();
      let path, all;
      try {
        const tree = await ticketTree(ticket);
        all = flatten(tree);
        path = await writeBrief(ticket, briefText(tree, repo.repo, res.branch));
      } catch (e) {
        this.busy = null;
        this.error = `Brief failed: ${String(e?.message ?? e)}`;
        cx.notify();
        return;
      }
      this.busy = `${ticket}: moving ${all.length} ticket${all.length > 1 ? "s" : ""} to In Progress…`;
      cx.notify();
      await moveInProgress(all)
        .then(() => setShared(STARTED, Date.now()))
        .catch((e) => notify({ title: `${ticket}: not moved to In Progress`, body: String(e?.message ?? e), level: "error" }));
      const name = `${ticket} ${repo.repo}`;
      const open = spaces().find((s) => (repo.all ? s.name === name : s.folder === res.path));
      if (open) {
        notify({ title: `${ticket} already has a space`, body: `Brief refreshed: ${path}`, level: "info", timeout: 6000 });
        run("space.select", { id: open.id });
        return closeOverlay(overlay);
      }
      const known = await knownAgents().catch(() => []);
      const agent = known.find((a) => a.installed && a.key === "omp") ?? known.find((a) => a.installed);
      run("space.new", {
        name,
        folder: res.path,
        ...(agent ? { argv: agent.run, task: firstMessage(ticket, path, all.length, repo.all ? null : repo.repo) } : {}),
      });
      notify({ title: `${ticket} started in ${repo.repo}`, level: "success", timeout: 6000,
        body: `${all.length} ticket${all.length > 1 ? "s" : ""} In Progress · ${res.branch ? `${res.created ? "new" : "existing"} branch ${res.branch}` : "agent picks the repos"}` });
      closeOverlay(overlay);
    });
  }
}

function choice(t, id, title, meta, onClick, strong) {
  return h_flex().id(id).h(36).px(12).gap(10).items_center().rounded(6).cursor_pointer()
    .bg(strong ? t.surface : t.popover).hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(500).text_size(SIZE.title).text_color(t.foreground).child(title))
    .child(div().flex_none().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(meta));
}

export function startPicker(state) {
  const t = theme();
  const { ticket, summary, overlay } = props() ?? {};
  const list = state.repos ?? [];
  const note = state.error ?? state.busy ?? (state.repos ? "Pick the main repo. The agent can add others." : "Finding repos…");
  return v_flex().size_full().bg(t.popover)
    .child(v_flex().px(16).pt(16).pb(12).gap(4)
      .child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(`Start ${ticket}`))
      .child(div().font_family(UI).font_weight(600).text_size(SIZE.heading).line_height(1.3).text_color(t.foreground).child(summary ?? ""))
      .child(div().pt(4).font_family(UI).text_size(SIZE.body).text_color(state.error ? t.blocked : state.busy ? t.working : t.muted).child(note)))
    .child(v_flex().id("start-list").flex_1().min_h(0).overflow_y_scroll().px(10).pb(10).gap(2)
      .child(choice(t, "start-all", "Let the agent decide", "all repos", (_e, cx) => state.go(cx, { repo: "durchblicker", all: true }, null), true))
      .children(list.map((r) => v_flex().gap(1)
        .child(choice(t, `start-${r.repo}`, r.repo,
          r.branches.length ? `${r.branches.length} branch${r.branches.length > 1 ? "es" : ""}` : "new branch",
          (_e, cx) => state.go(cx, r, null)))
        .children(r.branches.slice(1).map((b) => h_flex().id(`start-${r.repo}-${b}`).h(26).pl(24).pr(12).items_center().rounded(6)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => state.go(cx, r, b))
          .child(div().truncate().font_family(MONO).text_size(SIZE.meta).text_color(t.muted).child(b)))))))
    .child(h_flex().h(48).px(16).items_center().justify_end().border_t(1).border_color(t.border)
      .child(button("start-cancel", "Cancel", "Esc", () => closeOverlay(overlay))));
}
