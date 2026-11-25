import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { UI, MONO, SIZE, RED, IMG } from "./kit.js";
import { findCommand } from "./cmds.js";

// The chat's side of omp commands: the line each run leaves in the conversation, the mode chips by the composer,
// and the bar that offers a picked command's options.

const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

// A command's result, kept where it ran in the conversation.
export function commandNote(t, n, reopen) {
  const color = n.error ? RED : t.muted;
  return h_flex().w_full().gap(10).items_start()
    .child(div().flex_none().mt(1).h(22).px(8).flex().items_center().rounded(6).bg(n.error ? RED + "1a" : t.raised)
      .font_family(MONO).font_weight(600).text_size(SIZE.meta).text_color(n.error ? RED : t.foreground).child(n.cmd.split(/\s/)[0]))
    .child(v_flex().flex_1().min_w(0).pt(3).gap(2)
      .when(n.running, (el) => el.child(div().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.dim)
        .loop("opacity", { from: 0.45, to: 1, period: 1200 }).child("Running…")))
      .children((n.error ? [n.error] : n.lines ?? []).map((l) => div().font_family(UI).text_size(SIZE.meta + 0.5).line_height(1.45).text_color(color).child(l))))
    .when(Boolean(n.panel), (el) => el.child(stop(div().id(`note-open-${n.id}`).flex_none().h(22).px(8).flex().items_center().rounded(6).cursor_pointer()
      .font_family(UI).text_size(SIZE.meta).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => reopen(cx, n.cmd)).child("Run again"))));
}

const MODES = {
  plan: ["Plan", "#64d2ff", "/plan", "Plan mode: the agent plans before it changes anything. Click to leave."],
  "plan-paused": ["Plan paused", "#8e8e93", "/plan", "Plan mode is paused. Click to resume it."],
  vibe: ["Vibe", "#bf5af2", "/vibe", "Vibe mode: you direct worker sessions. Click to leave."],
  goal: ["Goal", "#ff9f0a", "/goal", "Goal mode: the agent keeps going toward its objective. Click for details, pause or drop."],
  fast: ["Fast", "#ffd60a", "/fast off", "Fast mode (priority tier). Click to turn it off."],
  advisor: ["Advisor", "#30d158", "/advisor off", "A second model reviews each turn. Click to turn it off."],
};

export function modeChips(t, modes, run) {
  return h_flex().gap(4).children(modes.filter((m) => MODES[m]).map((m) => {
    const [label, color, cmd, tip] = MODES[m];
    return stop(h_flex().id(`mode-${m}`).h(24).px(9).gap(5).items_center().rounded(12).cursor_pointer()
      .bg(color + "1f").hover((s) => s.bg(color + "33")).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx, cmd); })
      .child(div().size(6).rounded(3).bg(color))
      .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta + 0.5).text_color(color).child(label)));
  }));
}

// While the composer holds "/name …", what that command takes: its options as chips, or what to type.
export function optionBar(t, cwd, text, fill, run) {
  const m = /^\/(\S+)\s(.*)$/s.exec(text);
  const c = m && findCommand(cwd, m[1]);
  if (!c || (!c.subs.length && !c.hint)) return null;
  const typed = m[2].trim();
  const subs = c.subs.filter((s) => !typed || s.name.startsWith(typed.split(/\s/)[0]));
  const chosen = c.subs.find((s) => typed.split(/\s/)[0] === s.name);
  return v_flex().w_full().px(4).gap(6)
    .child(h_flex().gap(8).items_center().min_w(0)
      .child(div().flex_none().font_family(MONO).font_weight(600).text_size(SIZE.meta).text_color(t.foreground).child(`/${c.name}`))
      .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.meta).text_color(t.dim)
        .child(chosen ? `${chosen.desc}${chosen.usage ? ` · then ${chosen.usage}` : ""}` : c.subs.length ? c.desc : `${c.desc} · ${c.hint}`)))
    .when(subs.length > 0 && !chosen, (el) => el.child(h_flex().gap(6).flex_wrap().children(subs.map((s) =>
      stop(h_flex().id(`opt-${c.name}-${s.name}`).h(26).px(10).gap(6).items_center().rounded(13).cursor_pointer()
        .bg(t.raised).hover((x) => x.bg(t.selected)).tooltip(s.desc + (s.usage ? `\nThen type: ${s.usage}` : ""))
        .on_click((_e, cx) => { cx.stop_propagation(); s.usage ? fill(cx, `/${c.name} ${s.name} `) : run(cx, `/${c.name} ${s.name}`); })
        .child(div().font_family(MONO).font_weight(500).text_size(SIZE.meta + 0.5).text_color(t.foreground).child(s.name))
        .when(Boolean(s.usage), (el) => el.child(div().font_family(MONO).text_size(SIZE.meta - 1).text_color(t.dim).child("…"))))))));
}

export function commandButton(t, open) {
  return stop(div().id("chat-cmds").h(30).px(10).flex_none().flex().items_center().rounded(15).cursor_pointer()
    .bg(t.raised).hover((s) => s.opacity(0.85)).tooltip("Commands (/)")
    .font_family(MONO).font_weight(600).text_size(SIZE.body).text_color(t.foreground)
    .on_click((_e, cx) => { cx.stop_propagation(); open(cx); }).child("/"));
}

// The conversation's blocks with each command note placed at the moment it ran.
export function interleave(blocks, notes) {
  if (!notes.length) return blocks.map((b) => ({ block: b }));
  const time = (b) => b.ts ?? b.start ?? 0;
  const out = [];
  const queue = [...notes].sort((a, b) => a.at - b.at);
  for (const b of blocks) {
    while (queue.length && time(b) && queue[0].at < time(b)) out.push({ note: queue.shift() });
    out.push({ block: b });
  }
  return [...out, ...queue.map((n) => ({ note: n }))];
}
