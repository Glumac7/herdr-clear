import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, theme, run, focused, exec, checking } from "herdr";
import { UI, MONO, SIZE, RED, hue, short, keycaps } from "./kit.js";
import { newTab } from "./newtab.js";

export class StatusState {
  constructor() {
    this.git = null;
  }

  start(cx) {
    if (checking()) return;
    this.poll(cx);
    cx.timer.every(5000, (cx) => this.poll(cx));
  }

  poll(cx) {
    const space = spaces().find((s) => s.active);
    const cwd = focused()?.cwd || space?.folder;
    if (!cwd) return;
    cx.spawn(async (cx) => {
      const on = space?.machine ?? null;
      let git = null;
      try {
        const st = await exec("git", ["status", "--porcelain=v1", "--branch"], { cwd, on, timeout: 4000 });
        if (st.code === 0) {
          const [head, ...files] = st.stdout.split("\n").filter(Boolean);
          const diff = await exec("git", ["diff", "--shortstat", "HEAD"], { cwd, on, timeout: 4000 });
          git = {
            files: files.length,
            ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
            behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
            add: Number(/(\d+) insertion/.exec(diff.stdout)?.[1] ?? 0),
            del: Number(/(\d+) deletion/.exec(diff.stdout)?.[1] ?? 0),
          };
        }
      } catch {}
      if (JSON.stringify(git) !== JSON.stringify(this.git)) { this.git = git; cx.notify(); }
    });
  }
}

export function statusBar(state) {
  const t = theme();
  const space = spaces().find((s) => s.active);
  const color = space ? hue(space.id) : t.dim;
  const g = state.git;
  const where = space?.branch || short(focused()?.cwd) || space?.machine || "";
  return h_flex().size_full().px(8).gap(6).items_center().bg(t.chrome).border_t(1).border_color(t.border)
    .child(div().flex_1())
    .when(Boolean(space), (el) => el.child(h_flex().gap(7).items_center()
      .child(div().size(8).rounded(2).bg(color))
      .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(color).child(space.name))))
    .child(h_flex().gap(10).items_center().px(8).font_family(MONO).text_size(SIZE.meta).text_color(t.dim)
      .child(div().max_w(320).truncate().child(where))
      .when(Boolean(g?.files), (el) => el
        .child(div().text_color(t.muted).child(`${g.files} changed`))
        .child(div().text_color(t.done).child(`+${g.add}`))
        .child(div().text_color(RED).child(`-${g.del}`)))
      .when(Boolean(g?.ahead), (el) => el.child(div().text_color(t.muted).child(`↑${g.ahead}`)))
      .when(Boolean(g?.behind), (el) => el.child(div().text_color(t.muted).child(`↓${g.behind}`))))
    .child(action(t, "cl-act-new", "New tab", "clear.newtab", () => newTab()))
    .child(action(t, "cl-act-palette", "Commands", "app.palette", () => run("app.palette")));
}

function action(t, id, text, bound, go) {
  const caps = keycaps(bound);
  return h_flex().id(id).h(22).px(9).gap(6).items_center().rounded(6).cursor_pointer()
    .font_family(UI).font_weight(500).text_size(SIZE.meta).text_color(t.muted)
    .hover((x) => x.bg(t.hover).text_color(t.foreground))
    .on_click(go)
    .child(text)
    .when(Boolean(caps), (el) => el.child(caps));
}
