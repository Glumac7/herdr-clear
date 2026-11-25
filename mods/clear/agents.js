import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, terminals, agents, run, shared, setShared } from "herdr";
import { UI, MONO, SIZE, IMG, RED, status, hue, statusMark, section, segmented, foldSection, isOpen, elapsed, ago, short } from "./kit.js";
import { parseTitle, sessionName } from "./names.js";
import { isOmp, setViewFor } from "./chat.js";
import { openDrawer } from "./openin.js";

const VIEWS = [["working", "Working"], ["done", "Done"], ["idle", "Idle"]];
const VIEW = "clear.agents.view";
const SETTLED = "clear.settled.open";
const ARMED = "clear.settled.armed";

// Sessions the board lists, in its order: pinned, then most urgent, then newest. Settled tabs are put away.
export function sessionList() {
  const settled = new Set(spaces().flatMap((s) => s.tabs.filter((tab) => tab.settled).map((tab) => tab.id)));
  return agents().filter((a) => !settled.has(a.tab)).sort((a, b) =>
    (b.pinned - a.pinned) || status(a.status).rank - status(b.status).rank || b.seq - a.seq);
}

export const boardView = () => shared(VIEW) ?? "working";

export function showView(id) {
  if (VIEWS.some(([v]) => v === id)) setShared(VIEW, id);
}

export function stepView(by) {
  const i = VIEWS.findIndex(([v]) => v === boardView());
  setShared(VIEW, VIEWS[(i + by + VIEWS.length) % VIEWS.length][0]);
}

// Walks the sessions as the board shows them: the ones that need you on top, then the chosen view's.
export function stepSession(by) {
  const list = sessionList();
  const of = (s) => list.filter((a) => (a.status ?? "idle") === s);
  const order = [...of("blocked"), ...of(boardView())];
  if (!order.length) return;
  const i = order.findIndex((a) => a.focused);
  const next = order[i < 0 ? (by > 0 ? 0 : order.length - 1) : (i + by + order.length) % order.length];
  run("pane.focus", { pane: next.pane });
}

// The same name the tab bar and the chat header show: the omp session's title.
export function agentName(a) {
  return sessionName(a.title) || (a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : "") || a.program?.name || a.address;
}

function timeIn(a, tab) {
  if (a.status === "working") return tab?.working_since ? elapsed(tab.working_since) : "";
  return tab?.changed_at ? ago(tab.changed_at) : "";
}

function subAgents(all, address) {
  const n = all.filter((k) => k.parent === address && k.state === "live").length;
  return n ? `${n} sub-agent${n === 1 ? "" : "s"}` : null;
}

// A terminal is rarely the work itself: it's a shell an agent needed. So shells live under the session they serve:
// plain panes in its tab (the first agent of a tab takes them) and the chat's terminal drawer.
function shellsOf(a, all) {
  const first = panes().find((p) => p.tab === a.tab && isOmp(p))?.terminal === a.address;
  const inTab = first ? panes().filter((p) => p.tab === a.tab && p.terminal && !isOmp(p))
    .map((p) => ({ key: p.pane, name: p.program?.name || "shell", cwd: p.cwd, go: () => { setViewFor(a.tab, "main"); run("pane.focus", { pane: p.pane }); } })) : [];
  const drawers = all.filter((x) => x.labels?.["clear.drawer"] === a.address && x.state === "live")
    .map((x) => ({ key: x.address, name: "drawer", cwd: x.cwd, go: (cx) => cx.spawn(async () => { await openDrawer(a.address, x.cwd); }) }));
  return [...inTab, ...drawers];
}

function shellRow(t, s) {
  return h_flex().id(`cl-shell-${s.key}`).h(22).pl(30).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
    .hover((x) => x.bg(t.hover))
    .on_click((_e, cx) => s.go(cx))
    .child(svg(`${IMG}/terminal.svg`).size(11).flex_none().text_color(t.dim))
    .child(div().flex_none().font_family(UI).text_size(SIZE.meta).text_color(t.muted).child(s.name))
    .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta - 0.5).text_color(t.dim).child(short(s.cwd)));
}

function row(t, a, tab, all) {
  const quiet = a.status === "idle";
  const urgent = a.status === "blocked";
  const meta = [parseTitle(a.title).tag, a.space_name, subAgents(all, a.address)].filter(Boolean).join(" · ");
  return v_flex()
    .child(h_flex().id(`cl-agent-${a.address}`).px(8).py(6).gap(10).items_start().rounded(6).cursor_pointer()
      .when(urgent, (el) => el.bg(t.blocked + "14"))
      .when(!urgent && a.focused, (el) => el.bg(t.selected))
      .hover((x) => x.bg(urgent ? t.blocked + "22" : t.hover))
      .tooltip(`${a.space_name} · tab ${a.tab_index} · ${status(a.status).word} · ⌘W settles it`)
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(div().w(12).h(18).flex_none().flex().items_center().justify_center().child(statusMark(a.status)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(quiet ? 400 : 500).text_size(SIZE.body)
            .text_color(quiet ? t.muted : t.foreground).child(agentName(a)))
          .child(div().flex_none().font_family(MONO).text_size(SIZE.meta - 0.5).text_color(t.dim).child(timeIn(a, tab))))
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().size(6).rounded(3).flex_none().bg(hue(a.space)))
          .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(meta)))))
    .children(shellsOf(a, all).map((s) => shellRow(t, s)));
}

// Agents that need you stay on top whatever the view; the control picks one list below them.
export function agentBoard(t, list) {
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, tab])));
  const all = terminals();
  const of = (s) => list.filter((a) => (a.status ?? "idle") === s);
  const head = section("Sessions", list.length || null);
  if (!list.length) {
    return v_flex().flex_none().child(head)
      .child(div().px(16).pb(8).font_family(UI).text_size(SIZE.body).text_color(t.dim).child("No sessions running."));
  }
  const view = boardView();
  const rows = (items) => items.map((a) => row(t, a, tabs.get(a.tab), all));
  const shown = of(view);
  return v_flex().flex_none().pb(10).child(head)
    .child(v_flex().px(6).gap(1).children(rows(of("blocked"))))
    .child(div().px(8).pt(6).pb(6).child(segmented("cl-agents",
      VIEWS.map(([id, text]) => [id, text, of(id).length, id === "idle" ? t.muted : status(id).color]), view,
      (id) => setShared(VIEW, id))))
    .child(v_flex().px(6).gap(1)
      .when(!shown.length, (el) => el.child(div().px(10).py(6).font_family(UI).text_size(SIZE.body).text_color(t.dim)
        .child(`No ${status(view).word.toLowerCase()} sessions.`)))
      .children(rows(shown)));
}

// Put-away sessions (⌘W): still running, out of the lists. A click brings one back; the bin deletes it,
// after a second click, because that ends its agent and terminals.
export function settledBoard(t, sessions) {
  const settled = spaces().flatMap((s) => s.tabs.filter((tab) => tab.settled).map((tab) => ({ tab, space: s })));
  if (!settled.length) return div();
  const open = isOpen(SETTLED, false);
  const armed = shared(ARMED);
  return v_flex().flex_none().pb(6)
    .child(foldSection(SETTLED, "Settled", settled.length, false))
    .when(open, (el) => el.child(v_flex().px(6).gap(2).children(settled.map(({ tab, space }) => {
      const a = sessions.find((x) => x.tab === tab.id);
      const name = a ? agentName(a) : tab.name;
      const on = armed === tab.id;
      return h_flex().id(`cl-settled-${tab.id}`).px(8).py(6).gap(10).items_center().rounded(8).cursor_pointer()
        .bg(t.hover).hover((x) => x.bg(t.selected))
        .tooltip("Bring back")
        .on_click(() => { run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); })
        .child(div().size(8).rounded(4).flex_none().bg(hue(space.id)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().font_family(UI).font_weight(500).text_size(SIZE.body - 0.5).text_color(t.muted).child(name))
          .child(div().truncate().font_family(UI).text_size(SIZE.meta).text_color(t.dim)
            .child([space.name, tab.settled_at ? `settled ${ago(tab.settled_at)} ago` : null].filter(Boolean).join(" · "))))
        .child(h_flex().id(`cl-del-${tab.id}`).h(24).px(on ? 8 : 6).gap(5).items_center().rounded(6).flex_none().cursor_pointer()
          .when(on, (el) => el.bg(RED).text_color("#ffffff"))
          .when(!on, (el) => el.text_color(t.dim).hover((x) => x.bg(RED + "26").text_color(RED)))
          .tooltip(on ? "Click again to end it for good" : "Delete this session")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (!on) {
              setShared(ARMED, tab.id);
              cx.timer.after(4000, () => { if (shared(ARMED) === tab.id) setShared(ARMED, null); });
              return;
            }
            setShared(ARMED, null);
            run("tab.close", { id: tab.id, confirmed: true });
          })
          .child(svg(`${IMG}/trash.svg`).size(12).flex_none())
          .when(on, (el) => el.child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).child("Delete"))));
    }))));
}
