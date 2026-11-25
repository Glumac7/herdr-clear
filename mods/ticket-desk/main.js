import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, exec, run, theme, layout, checking, home } from "herdr";

const PANEL = "panel", BLOCK = "ticket-desk";
const TICKET = /\bIT-?(\d{3,5})\b/i;
const HELPER = `${home()}/.config/herdr-app/mods/ticket-desk/desk.py`;

const usd = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${(n ?? 0).toFixed(2)}`);
const ticketOf = (...texts) => {
  for (const t of texts) {
    const m = TICKET.exec(t ?? "");
    if (m) return `IT-${m[1]}`;
  }
  return null;
};
const modelName = (m) => (m ? m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2") : "");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class TicketDesk extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.busy = false;
    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  visible() {
    const root = layout();
    return !find(root, PANEL)?.hidden && find(root, "panel-body")?.active === BLOCK;
  }

  rows() {
    const where = new Map(panes().map((p) => [p.pane, p]));
    const groups = new Map();
    for (const a of agents()) {
      const p = where.get(a.pane);
      const folder = p?.cwd ?? null;
      const key = ticketOf(folder, p?.branch) ?? (folder ? folder.split("/").pop() : a.space_name);
      if (!groups.has(key)) groups.set(key, { key, ticket: key.startsWith("IT-"), folder, agents: [] });
      groups.get(key).agents.push({ ...a, folder });
    }
    const rank = { blocked: 0, done: 1, working: 2, idle: 3 };
    const best = (g) => Math.min(...g.agents.map((a) => rank[a.status] ?? 4));
    return [...groups.values()].sort((a, b) => best(a) - best(b) || a.key.localeCompare(b.key));
  }

  refresh(cx) {
    if (this.busy || checking() || (this.data && !this.visible())) return;
    const folders = [...new Set(this.rows().flatMap((g) => g.agents.map((a) => a.folder)).filter(Boolean))];
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/usr/bin/python3", ["-I", HELPER, JSON.stringify(folders)], { timeout: 600000 });
        if (r.code === 0) { this.data = JSON.parse(r.stdout); this.error = null; }
        else this.error = (r.stderr || `desk.py exited ${r.code}`).trim().split("\n").pop();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.busy = false;
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const d = this.data;
    const rows = this.rows();
    const waiting = rows.flatMap((g) => g.agents).filter((a) => a.status === "blocked");
    const color = { blocked: t.blocked, working: t.working ?? t.accent, done: t.accent, idle: t.dim };
    const prColor = { failing: t.blocked, approved: t.accent, merged: t.dim, closed: t.dim };

    const chip = (text, c, onClick) => div().px(6).h(18).flex().items_center().rounded(4).flex_none()
      .border_1().border_color(c + "66").bg(c + "1a").text_size(10.5).text_color(c)
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click(onClick)).child(text);

    const agentLine = (a) => {
      const f = d?.folders?.[a.folder];
      const p = a.program;
      return h_flex().gap(6).items_center().h(20)
        .child(div().w(7).h(7).rounded(4).flex_none().bg(color[a.status] ?? t.dim))
        .when(Boolean(p?.icon), (el) => el.child(p.tint ? svg(p.icon).size(12).text_color(t.muted) : image(p.icon).w(12).h(12)))
        .child(div().text_size(11.5).text_color(a.status === "blocked" ? t.blocked : t.foreground)
          .child(a.status === "blocked" ? "waiting for you" : a.status))
        .when(Boolean(f?.model), (el) => el.child(div().text_size(11).text_color(t.dim).child(modelName(f.model))))
        .child(div().flex_1())
        .when(Boolean(f?.stuck), (el) => el.child(chip("looping?", t.blocked)));
    };

    const row = (g) => {
      const f = d?.folders?.[g.folder] ?? {};
      const cost = g.ticket ? d?.tickets?.[g.key] : f;
      const urgent = g.agents.some((a) => a.status === "blocked");
      const go = () => run("agent.focus", { terminal: (g.agents.find((a) => a.status === "blocked") ?? g.agents[0]).address });
      return v_flex().id(`td-${g.key}`).flex_none().gap(4).p(8).rounded(8).cursor_pointer()
        .border_1().border_color(urgent ? t.blocked + "88" : t.border).bg(urgent ? t.blocked + "12" : t.raised)
        .hover((s) => s.bg(t.hover)).on_click(go)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(g.key))
          .when(Boolean(f.repo), (el) => el.child(div().text_size(11).text_color(t.muted).child(f.repo)))
          .child(div().flex_1())
          .when(Boolean(f.pr), (el) => el.child(chip(`#${f.pr.number} ${f.pr.state}`, prColor[f.pr.state] ?? t.muted,
            (_e, cx) => cx.open_url(f.pr.url)))))
        .when(Boolean(f.branch), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(f.branch)))
        .child(h_flex().gap(10).text_size(11).text_color(t.muted)
          .when(f.ahead != null, (el) => el.child(`↑${f.ahead} ↓${f.behind}`))
          .when(Boolean(f.files), (el) => el.child(`${f.files} files +${f.added} −${f.removed}`))
          .child(div().flex_1())
          .when(Boolean(cost), (el) => el.child(`${usd(cost.cost)} · today ${usd(cost.today)}`)))
        .children(g.agents.map(agentLine));
    };

    const omp = d?.omp;
    return v_flex().id(BLOCK).size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(v_flex().flex_none().px(12).py(10).gap(4).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(12.5).font_semibold().child("Ticket Desk"))
          .child(div().flex_1())
          .when(waiting.length > 0, (el) => el.child(chip(`${waiting.length} waiting · jump`, t.blocked,
            () => run("agent.focus", { terminal: waiting[0].address })))))
        .child(h_flex().gap(10).text_size(11).text_color(t.muted)
          .child(`today ${d ? usd(d.today) : "…"}`)
          .child(`week ${d ? usd(d.week) : "…"}`)
          .when(Boolean(omp), (el) => el.child(`omp ${usd(omp.week)}${omp.last ? ` (synced ${omp.last})` : ""}`)))
        .when(Boolean(this.error), (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(this.error))))
      .child(v_flex().id("td-list").flex_1().min_h(0).p(8).gap(8).overflow_y_scrollbar()
        .when(rows.length === 0, (el) => el.child(div().p(8).text_size(11.5).text_color(t.dim).child("No agents running.")))
        .children(rows.map(row)));
  }
}
