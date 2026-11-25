import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";
import { UI, SIZE, dot } from "./kit.js";

const LEVEL = { error: "blocked", warning: "blocked", success: "done", info: "accent" };

export function toast() {
  const t = theme();
  const p = props() ?? {};
  const color = t[LEVEL[p.level] ?? "accent"];
  return h_flex().id("cl-toast").size_full().gap(10).px(14).items_center().bg(t.popover).cursor_pointer()
    .hover((s) => s.bg(t.raised))
    .on_click(() => {
      if (p.action?.name) run(p.action.name, p.action.args ?? {});
      closeOverlay(p.overlay);
    })
    .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : dot(color, 8))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().truncate().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.foreground).child(p.title ?? ""))
      .when(Boolean(p.body), (el) => el.child(div().truncate().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.muted).child(p.body))));
}
