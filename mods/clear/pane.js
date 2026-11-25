import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, spaces } from "herdr";
import { UI, MONO, SIZE, hue, pill, runner, programIcon, iconButton, short, dot } from "./kit.js";
import { viewSwitch, isOmp } from "./chat.js";

export function paneHeader(view) {
  const t = theme();
  const p = panes().find((x) => x.pane === props()?.pane);
  if (!p) return div();
  const space = spaces().find((s) => s.tabs.some((tab) => tab.id === p.tab));
  const color = space ? hue(space.id) : t.dim;
  const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
  const pane = p.pane;
  return h_flex().id(`cl-pane-${pane}`).size_full().pl(10).pr(4).gap(8).items_center()
    .bg(t.background).border_b(1).border_color(t.border)
    .on_hover((hovered, cx) => { view.hovered = hovered; cx.notify(); })
    .on_click(() => run("pane.focus", { pane }))
    .child(programIcon(p.program, 18))
    .child(h_flex().flex_none().gap(6).items_center()
      .child(dot(color, 7))
      .child(div().font_family(UI).font_weight(500).text_size(SIZE.body - 1).text_color(t.muted).child(space?.name ?? ""))
      .child(div().font_family(UI).text_size(SIZE.body).text_color(t.dim).child("›"))
      .child(div().max_w(220).truncate().font_family(UI).font_weight(600).text_size(SIZE.body - 1)
        .text_color(p.focused ? t.foreground : t.muted).child(name)))
    .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta).text_color(t.dim)
      .child(short(p.cwd) + (p.branch ? `  ⎇ ${p.branch}` : "")))
    .when(isOmp(p), (el) => el.child(viewSwitch(`cl-view-${pane}`, "main", p.terminal)))
    .when(!view.hovered && p.status === "working", (el) => el.child(runner(t.working, 48)))
    .when(!view.hovered, (el) => el.child(div().pr(6).child(pill(p.status) ?? div())))
    .when(view.hovered, (el) => el
      .child(iconButton(`cl-r-${pane}`, "split-right", "Split right", () => run("pane.split", { direction: "right", pane })))
      .child(iconButton(`cl-d-${pane}`, "split-down", "Split down", () => run("pane.split", { direction: "down", pane })))
      .child(iconButton(`cl-z-${pane}`, "zoom", p.zoomed ? "Unzoom" : "Zoom", () => run("pane.zoom", { pane })))
      .child(iconButton(`cl-x-${pane}`, "close", "Close", () => run("pane.close", { pane }))));
}
