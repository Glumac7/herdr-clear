import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, settings } from "herdr";
import { UI, MONO, SIZE, PURPLE, RED, dot, button } from "./kit.js";
import { slash, refocus } from "./chat.js";

const KINDS = [
  ["system", "System prompt & tools", "#8e8e93"],
  ["summary", "Compaction summary", "#5e5ce6"],
  ["user", "Your messages", "#0a84ff"],
  ["text", "Replies", "#30d158"],
  ["thinking", "Thinking", PURPLE],
  ["tools", "Tool calls", "#ff9f0a"],
  ["results", "Tool results", "#64d2ff"],
  ["notes", "Reminders & notices", "#ff375f"],
];
const WIDTH = 300;
const ROW = 24;

export const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Opens just above the meter that was clicked, centred on it.
export function openContext(e, session, size, terminal) {
  const { total, system, parts } = session.breakdown();
  const rows = KINDS.map(([k, label, color]) => ({ label, color, n: k === "system" ? system : parts[k] }))
    .filter((r) => r.n > 0);
  const height = 106 + (rows.length + (size ? 1 : 0)) * ROW;
  const z = settings().zoom || 1;
  const b = e.bounds;
  const at = b ? { x: (b.x + b.width / 2) / z - WIDTH / 2, y: b.y / z - height - 8 } : "pointer";
  openOverlay({ mod: "clear", kind: "popup", width: WIDTH, height, at,
    props: { role: "context", rows, total, size, cost: session.cost, terminal } });
}

export class ContextState {
  constructor() {
    this.error = null;
  }

  start() {}

  // omp compacts in the background; the chat shows the compaction note and the meter drops when it lands.
  compact(cx) {
    const { terminal, overlay } = props();
    cx.spawn(async (cx) => {
      this.error = await slash(terminal, "/compact");
      if (this.error) return cx.notify();
      closeOverlay(overlay);
      refocus();
    });
  }
}

export function contextView(state) {
  const t = theme();
  const { rows = [], total = 0, size, cost = 0, terminal } = props() ?? {};
  const whole = size || total || 1;
  const line = (color, label, n, muted) => h_flex().h(ROW).gap(8).items_center()
    .child(dot(color, 8))
    .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.body - 1).text_color(muted ? t.dim : t.foreground).child(label))
    .child(div().flex_none().font_family(MONO).text_size(SIZE.meta).text_color(t.muted).child(tokens(n)))
    .child(div().w(34).flex_none().text_right().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(`${Math.round((n / whole) * 100)}%`));
  return v_flex().size_full().p(12).gap(8).bg(t.popover)
    .child(h_flex().items_baseline().gap(6)
      .child(div().flex_1().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.foreground).child("Context"))
      .child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.muted).child(size ? `${tokens(total)} / ${tokens(size)}` : tokens(total))))
    .child(h_flex().w(WIDTH - 24).h(8).flex_none().rounded(4).overflow_hidden().bg(t.input)
      .children(rows.map((r, i) => div().h(8).flex_none().w(Math.max(2, (r.n / whole) * (WIDTH - 24))).bg(r.color)
        .when(i > 0, (el) => el.border_l(1).border_color(t.popover)))))
    .child(v_flex()
      .children(rows.map((r) => line(r.color, r.label, r.n)))
      .when(Boolean(size), (el) => el.child(line(t.input, "Free", Math.max(0, size - total), true))))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.meta - 0.5).text_color(state.error ? RED : t.dim)
        .child(state.error ?? `Split estimated · $${cost.toFixed(2)} spent`))
      .when(Boolean(terminal), (el) => el.child(button("ctx-compact", "Compact", "Summarize older turns to free context (/compact)",
        (cx) => state.compact(cx)))));
}
