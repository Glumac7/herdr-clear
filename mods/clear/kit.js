import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, home, layout, spaces, shared, setShared, keys, run, window } from "herdr";

export const UI = ".SystemUIFont";
export const MONO = "SF Mono";
export const IMG = "mods/clear/img";

// macOS text styles: footnote 11 · body 13 · headline 13 · title3 15.
export const SIZE = { meta: 11, body: 13, title: 13, heading: 15 };

// Apple system colors (dark) for tones the theme has no name for.
export const RED = "#ff453a";
export const PURPLE = "#bf5af2";

export function status(s) {
  const t = theme();
  switch (s) {
    case "blocked": return { word: "Needs you", color: t.blocked, rank: 0 };
    case "done": return { word: "Done", color: t.done, rank: 1 };
    case "working": return { word: "Working", color: t.working, rank: 2 };
    default: return { word: "Idle", color: t.idle, rank: 3 };
  }
}

// Every space gets its own colour for life, so its tabs, agents, panes and tickets read as one group.
const HUES = [PURPLE, "#ff375f", "#64d2ff", "#ff9f0a", "#30d158", "#5e5ce6"];
const HUE_KEY = "clear.hues";

export function hue(spaceId) {
  const map = shared(HUE_KEY) ?? {};
  if (HUES.includes(map[spaceId])) return map[spaceId];
  const alive = new Set(spaces().map((s) => s.id));
  const kept = Object.fromEntries(Object.entries(map).filter(([id, c]) => alive.has(id) && HUES.includes(c)));
  const used = Object.values(kept);
  const pick = [...HUES].sort((a, b) => used.filter((x) => x === a).length - used.filter((x) => x === b).length)[0];
  setShared(HUE_KEY, { ...kept, [spaceId]: pick });
  return pick;
}

// Live status: amber pulses fast, blue pulses slow, green holds still.
export function pill(s, compact = false) {
  if (!s || s === "idle") return null;
  const st = status(s);
  return h_flex().flex_none().h(compact ? 18 : 20).px(compact ? 6 : 8).gap(6).items_center().rounded(10)
    .bg(st.color + "22")
    .child(dot(st.color, 6).when(s !== "done", (d) => d.loop("opacity", { from: 0.25, to: 1, period: s === "blocked" ? 900 : 1400 })))
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta - (compact ? 1 : 0)).text_color(st.color).child(st.word));
}

// A thin track with a runner sweeping across it while an agent works.
export function runner(color, width = 40) {
  return div().relative().w(width).h(2).flex_none().rounded(1).bg(color + "26").overflow_hidden()
    .child(div().absolute().top(0).w(12).h(2).rounded(1).bg(color)
      .loop("left", { from: -12, to: width, period: 1600, easing: "linear" }));
}

// One marker per status everywhere: spinner working, pulsing dot blocked, solid dot done, ring idle.
export function statusMark(s) {
  const t = theme();
  if (s === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (s === "blocked") return dot(t.blocked, 8).loop("opacity", { from: 0.35, to: 1, period: 900 });
  if (s === "done") return dot(t.done, 8);
  if (s === "idle") return div().size(8).flex_none().rounded(4).border(1.5).border_color(t.dim);
  return null;
}

// Herdr's own program icon on its brand tile, so omp, Claude and a shell read apart at a glance.
export function programIcon(program, size = 22) {
  const t = theme();
  const glyph = Math.round(size * 0.62);
  const mark = !program?.icon
    ? div().font_family(MONO).font_weight(600).text_size(glyph * 0.8).text_color(t.muted).child(">_")
    : program.tint ? svg(program.icon).size(glyph).text_color(program.color ?? t.foreground)
    : image(program.icon).w(glyph).h(glyph);
  return div().size(size).flex_none().flex().items_center().justify_center().rounded(Math.round(size * 0.24))
    .bg(program?.tile ?? t.raised).child(mark);
}

export function avatar(path, size, fallback) {
  const t = theme();
  const frame = div().size(size).flex_none().rounded(size / 2).overflow_hidden().bg(t.raised);
  return path ? frame.child(image(path).w(size).h(size).rounded(size / 2))
    : frame.flex().items_center().justify_center().font_family(UI).font_weight(600).text_size(size * 0.45).text_color(t.muted)
      .child((fallback ?? "?").slice(0, 1).toUpperCase());
}

const MODS = ["ctrl", "alt", "shift", "cmd"];
const GLYPH = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↩", escape: "⎋" };

// The live binding for an action as a menu-style shortcut (⇧⌘P); null when the action has no key.
export function keycaps(action) {
  const t = theme();
  const bound = keys().find((k) => k.action === action || k.action.startsWith(`${action}:`));
  if (!bound) return null;
  const rank = (k) => (MODS.includes(k) ? MODS.indexOf(k) : MODS.length);
  const parts = bound.keys.split(" ")[0].split("-").sort((a, b) => rank(a) - rank(b));
  return div().font_family(UI).text_size(SIZE.meta).text_color(t.dim)
    .child(parts.map((k) => GLYPH[k] ?? k.toUpperCase()).join(""));
}

export function elapsed(since) {
  const m = Math.max(0, Math.floor((Date.now() - since) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The left sidebar folds to a rail (room for the traffic lights on macOS); the right panel folds to a strip
// that only holds its handle.
const SIDES = {
  sidebar: { rail: () => (window()?.platform === "macos" ? 76 : 44), below: 160, open: 280, edge: "right" },
  right: { rail: () => 28, below: 120, open: 360, edge: "left" },
};

const width = (id) => find(layout(), id)?.size?.px ?? Infinity;
export const narrow = (id = "sidebar") => width(id) < SIDES[id].below;

// Resized in small eased steps, so the edge glides instead of jumping.
function glide(cx, id, to) {
  const from = width(id);
  if (!Number.isFinite(from) || from === to) return run("layout.resize", { id, px: to });
  const steps = 12;
  let i = 0;
  const step = (cx) => {
    i += 1;
    const k = 1 - (1 - i / steps) ** 3;
    run("layout.resize", { id, px: Math.round(from + (to - from) * k) });
    if (i < steps) cx.timer.after(16, step);
  };
  step(cx);
}

export function toggleSide(cx, id) {
  const side = SIDES[id];
  const key = `clear.width.${id}`;
  if (narrow(id)) return glide(cx, id, shared(key) ?? side.open);
  setShared(key, width(id));
  glide(cx, id, side.rail());
}

// A small pill centred on the panel's inner edge that folds or unfolds it. The parent must be relative.
export function edgeHandle(t, id) {
  const side = SIDES[id];
  const folded = narrow(id);
  const pointsLeft = (side.edge === "right") !== folded;
  const lane = div().absolute().top(0).bottom(0).w(16).flex().items_center().justify_center();
  return (side.edge === "right" ? lane.right(2) : lane.left(2))
    .child(div().id(`edge-${id}`).w(14).h(44).rounded(7).flex().items_center().justify_center().cursor_pointer()
      .bg(t.hover).text_color(t.dim).opacity(0.55)
      .hover((s) => s.opacity(1).bg(t.selected).text_color(t.foreground))
      .tooltip(folded ? "Expand" : "Collapse")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); toggleSide(cx, id); })
      .child(svg(`${IMG}/chevron-${pointsLeft ? "left" : "right"}.svg`).size(10)));
}

export function short(path) {
  if (!path) return "";
  const h = home();
  return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

export function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export const dot = (color, size = 7) => div().size(size).flex_none().rounded(size / 2).bg(color);

export function icon(name, size, color) {
  return svg(`${IMG}/${name}.svg`).size(size).flex_none().text_color(color);
}

export function label(text) {
  const t = theme();
  return div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted).child(text);
}

// A sidebar section header, as in Finder and Mail: small, semibold, secondary.
export function section(text, count, extra) {
  const t = theme();
  return h_flex().h(32).pl(16).pr(10).pt(6).gap(6).items_center().flex_none()
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted).child(text))
    .when(count != null, (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(String(count))))
    .child(div().flex_1())
    .when(Boolean(extra), (el) => el.child(extra));
}

export function iconButton(id, name, tip, action) {
  const t = theme();
  return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6)
    .text_color(t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(`${IMG}/${name}.svg`).size(15));
}

// A section header that folds its section; whether it's open is kept in shared state under `key`.
export function foldSection(key, text, count, fallback, extra) {
  const t = theme();
  const open = shared(key) ?? fallback;
  return h_flex().id(`fold-${key}`).h(32).pl(12).pr(10).pt(6).gap(6).items_center().flex_none().cursor_pointer()
    .text_color(t.muted).hover((s) => s.text_color(t.foreground))
    .on_click(() => setShared(key, !open))
    .child(svg(`${IMG}/chevron-${open ? "down" : "right"}.svg`).size(9).flex_none())
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).child(text))
    .when(count != null, (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(String(count))))
    .child(div().flex_1())
    .when(Boolean(extra), (el) => el.child(extra));
}

export const isOpen = (key, fallback) => shared(key) ?? fallback;

// A macOS segmented control; items are [id, label, count?, color?]. A color tints the segment and adds a dot.
export function segmented(prefix, items, active, select) {
  const t = theme();
  return h_flex().p(2).gap(2).rounded(8).bg(t.hover)
    .children(items.map(([id, text, count, color]) => {
      const on = id === active;
      return h_flex().id(`${prefix}-${id}`).flex_1().h(24).px(8).gap(5).items_center().justify_center().rounded(6).cursor_pointer()
        .font_family(UI).font_weight(on ? 600 : 500).text_size(SIZE.body - 1)
        .text_color(on ? color ?? t.foreground : t.muted)
        .when(on, (el) => el.bg(color ? color + "2e" : t.raised).shadow_sm())
        .when(!on, (el) => el.hover((s) => s.text_color(color ?? t.foreground)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); select(id, cx); })
        .when(Boolean(color), (el) => el.child(dot(color, 6)))
        .child(text)
        .when(count != null, (el) => el.child(div().font_weight(500).text_color(on && color ? color : t.dim).child(String(count))));
    }));
}

// Reasoning effort from least to most, cool to hot, in Apple system colors.
export const EFFORT = { off: "#8e8e93", minimal: "#8e8e93", low: "#30d158", medium: "#0a84ff", high: "#bf5af2", xhigh: "#ff9f0a", max: "#ff453a", auto: "#64d2ff" };

// macOS push buttons: "plain" (filled gray), "primary" (accent), "danger" (red on hover, solid red when armed).
export function button(id, text, tip, action, kind = "plain", armed = false) {
  const t = theme();
  const base = h_flex().id(id).h(24).px(12).flex_none().items_center().rounded(12).cursor_pointer()
    .font_family(UI).font_weight(500).text_size(SIZE.body - 1)
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(text);
  if (kind === "primary") return base.bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.85));
  if (kind === "danger" && armed) return base.bg(RED).text_color("#ffffff");
  return base.bg(t.input).text_color(t.foreground)
    .hover((s) => s.bg(t.raised).text_color(kind === "danger" ? RED : t.foreground));
}
