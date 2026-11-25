import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, run, theme, window, setAgentOrder, openOverlay, exec, checking } from "herdr";
import { UI, MONO, SIZE, RED, PURPLE, status, hue, statusMark, iconButton, foldSection, isOpen, narrow, toggleSide, edgeHandle } from "./kit.js";
import { spaceFolder } from "./newtab.js";
import { agentBoard, settledBoard, agentName, sessionList } from "./agents.js";
import { parseTitle } from "./names.js";

const PROJECTS = "clear.projects.open";

const TRUNK = /^(main|master|develop|trunk)$/;
const FAILED = /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE/;
const RUNNING = /PENDING|QUEUED|IN_PROGRESS|WAITING|EXPECTED/;

function checks(rollup) {
  const states = (rollup ?? []).map((c) => c.conclusion || c.state || c.status || "");
  if (states.some((s) => FAILED.test(s))) return "failing";
  if (states.some((s) => RUNNING.test(s))) return "running";
  return states.length ? "passing" : null;
}

export class SidebarState {
  constructor() {
    this.prs = {};
  }

  start(cx) {
    if (checking()) return;
    this.poll(cx);
    cx.timer.every(120000, (cx) => this.poll(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // The open PR for each space's branch, with its checks and review.
  poll(cx) {
    cx.spawn(async (cx) => {
      const next = {};
      for (const s of spaces()) {
        const folder = spaceFolder(s);
        if (!s.branch || TRUNK.test(s.branch) || !folder) continue;
        const r = await exec("gh", ["pr", "view", s.branch, "--json", "number,url,state,isDraft,reviewDecision,statusCheckRollup"],
          { cwd: folder, on: s.machine, timeout: 20000 }).catch(() => null);
        if (r?.code !== 0) continue;
        try {
          const p = JSON.parse(r.stdout);
          next[s.id] = { number: p.number, url: p.url, state: p.state, draft: p.isDraft, review: p.reviewDecision, checks: checks(p.statusCheckRollup) };
        } catch {}
      }
      if (JSON.stringify(next) !== JSON.stringify(this.prs)) { this.prs = next; cx.notify(); }
    });
  }
}

function prSummary(t, pr) {
  if (pr.state === "MERGED") return ["Merged", PURPLE];
  if (pr.state === "CLOSED") return ["Closed", t.dim];
  if (pr.draft) return ["Draft", t.dim];
  if (pr.checks === "failing") return ["Checks failing", RED];
  if (pr.review === "CHANGES_REQUESTED") return ["Changes requested", RED];
  if (pr.checks === "running") return ["Checks running", t.working];
  if (pr.review === "APPROVED") return ["Approved", t.done];
  return ["In review", t.muted];
}

export function head() {
  const t = theme();
  const mac = window()?.platform === "macos" && !window()?.fullscreen;
  if (narrow()) {
    return v_flex().size_full().bg(t.chrome).items_center().justify_end().pb(6)
      .child(iconButton("cl-toggle", "sidebar", "Open sidebar", (cx) => toggleSide(cx, "sidebar")));
  }
  return h_flex().size_full().bg(t.chrome).pl(mac ? 88 : 12).pr(10).gap(2).items_center()
    .child(div().flex_1())
    .child(iconButton("cl-search", "search", "Find anything", () => run("mod.open", { name: "picker" })))
    .child(iconButton("cl-toggle", "sidebar", "Fold sidebar", (cx) => toggleSide(cx, "sidebar")));
}

function spaceRow(t, s, pr) {
  const [word, tone] = pr ? prSummary(t, pr) : [];
  const tabs = `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}`;
  const urgent = s.status && s.status !== "idle";
  return h_flex().id(`cl-space-${s.id}`).px(8).py(6).gap(10).items_start().rounded(6).cursor_pointer()
    .when(s.active, (el) => el.bg(t.selected))
    .hover((x) => x.bg(s.active ? t.selected : t.hover))
    .tooltip(s.folder || s.name)
    .on_click(() => run("space.select", { id: s.id }))
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } });
    })
    .child(div().w(12).h(18).flex_none().flex().items_center().justify_center()
      .child(div().size(8).rounded(4).bg(hue(s.id))))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(s.active ? 600 : 500).text_size(SIZE.body)
          .text_color(s.active ? t.foreground : t.muted).child(s.name))
        .when(urgent, (el) => el.child(statusMark(s.status))))
      .child(h_flex().gap(6).items_center().min_w(0).font_family(UI).text_size(SIZE.meta).text_color(t.dim)
        .when(Boolean(s.branch), (el) => el.child(div().flex_shrink_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta - 0.5)
          .child(s.branch.split("/").pop())))
        .when(!s.branch, (el) => el.child(div().flex_none().child(tabs)))
        .when(Boolean(pr), (el) => el.child(h_flex().id(`cl-pr-${s.id}`).flex_none().gap(4).items_center().cursor_pointer()
          .tooltip("Open the pull request")
          .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [pr.url]); })
          .child(div().child("·"))
          .child(div().font_family(MONO).text_size(SIZE.meta - 0.5).text_color(t.muted).child(`#${pr.number}`))
          .child(div().text_color(tone).child(word))))));
}

// Folded, the sidebar keeps what matters most: one tile per running session, its status on the ring.
function rail(t, list) {
  return v_flex().size_full().bg(t.chrome).items_center().pt(8).gap(6)
    .children(list.map((a) => {
      const color = a.status && a.status !== "idle" ? status(a.status).color : hue(a.space);
      const { emoji, text } = parseTitle(a.title);
      return div().id(`cl-rail-${a.address}`).size(32).flex().items_center().justify_center().rounded(8).cursor_pointer()
        .bg(a.focused ? color + "33" : t.chrome).border(1.5).border_color(a.focused || a.status === "blocked" || a.status === "working" ? color : t.border)
        .tooltip(agentName(a))
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(a.status === "blocked", (el) => el.loop("opacity", { from: 0.5, to: 1, period: 900 }))
        .child(div().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.foreground)
          .child(emoji ?? (text || a.address).slice(0, 1).toUpperCase()));
    }));
}

export function sidebar(state, cx) {
  const t = theme();
  const everyone = agents();
  const list = sessionList();
  setAgentOrder(list.map((a) => a.address));
  const body = narrow() ? rail(t, list) : expanded(t, state, list, everyone);
  return div().relative().size_full().child(body).child(edgeHandle(t, "sidebar"));
}

function expanded(t, state, list, everyone) {
  const all = spaces();
  return v_flex().id("cl-sidebar").size_full().bg(t.chrome).overflow_y_scroll().pb(10)
    .child(agentBoard(t, list))
    .child(settledBoard(t, everyone))
    .child(foldSection(PROJECTS, "Projects", all.length, false,
      iconButton("cl-space-new", "plus", "New project", () => run("space.new"))))
    .when(isOpen(PROJECTS, false), (el) => el.child(v_flex().px(6).gap(1).children(all.map((s) => spaceRow(t, s, state.prs[s.id])))));
}
