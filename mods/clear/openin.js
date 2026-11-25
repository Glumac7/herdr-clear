import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, hc, run, props, terminals, openOverlay, closeOverlay, shared, setShared, checking } from "herdr";
import { UI, MONO, SIZE, RED, IMG, short } from "./kit.js";

const APPS = "clear.apps";
const EDITORS = ["Cursor", "Visual Studio Code", "Zed", "Windsurf", "Xcode", "Sublime Text", "WebStorm", "IntelliJ IDEA"];

async function editors() {
  const cached = shared(APPS);
  if (cached) return cached;
  const r = await exec("sh", ["-c", 'for a in "$@"; do [ -d "/Applications/$a.app" ] || [ -d "$HOME/Applications/$a.app" ] && echo "$a"; done', "sh", ...EDITORS]);
  const found = r.stdout.split("\n").filter(Boolean);
  setShared(APPS, found);
  return found;
}

// A shell in the agent's folder, kept by the core and shown in a window over the chat, like T3 Code's terminal drawer.
// One per agent: reopening finds it by label.
export async function openDrawer(agent, cwd) {
  let shell = terminals().find((t) => t.labels?.["clear.drawer"] === agent && t.state === "live")?.address;
  if (!shell) {
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--keep", "--cwd", cwd, "--label", `clear.drawer=${agent}`]);
    if (r.code !== 0) return (r.stderr || r.stdout).trim();
    shell = JSON.parse(r.stdout).address;
  }
  openOverlay({
    kind: "window", key: `clear-drawer-${agent}`, width: 0.62, height: 360,
    layout: { type: "column", children: [
      { type: "block", size: { px: 36 }, content: { mod: "clear", props: { role: "drawer", terminal: shell, folder: cwd } } },
      { type: "block", content: { terminal: shell } },
    ] },
  });
  return null;
}

export class OpenInState {
  constructor() {
    this.apps = [];
    this.error = null;
  }

  start(cx) {
    if (checking()) return;
    cx.spawn(async (cx) => { this.apps = await editors().catch(() => []); cx.notify(); });
  }

  go(cx, action) {
    const { overlay } = props();
    cx.spawn(async (cx) => {
      const error = await action();
      if (error) { this.error = error; cx.notify(); return; }
      closeOverlay(overlay);
    });
  }
}

function item(t, state, id, icon, label, hint, action) {
  return h_flex().id(`oi-${id}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => state.go(cx, action))
    .child(svg(`${IMG}/${icon}.svg`).size(14).flex_none().text_color(t.muted))
    .child(div().flex_1().font_family(UI).font_weight(500).text_size(SIZE.body).text_color(t.foreground).child(label))
    .when(Boolean(hint), (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(hint)));
}

export function openInView(state) {
  const t = theme();
  const { agent, folder } = props() ?? {};
  const open = (...args) => async () => { const r = await exec("open", args); return r.code === 0 ? null : r.stderr.trim(); };
  return v_flex().size_full().p(6).gap(1).bg(t.popover)
    .child(div().px(8).pt(4).pb(4).truncate().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(short(folder)))
    .when(Boolean(state.error), (el) => el.child(div().px(8).pb(4).font_family(UI).text_size(SIZE.meta).text_color(RED).child(state.error)))
    .child(item(t, state, "drawer", "terminal", "Terminal", "drawer", () => openDrawer(agent, folder)))
    .child(item(t, state, "tab", "tab", "Terminal in new tab", null, async () => { run("tab.new", { folder }); return null; }))
    .child(item(t, state, "finder", "folder", "Finder", null, open(folder)))
    .children(state.apps.map((app) => item(t, state, app, "external", app, null, open("-a", app, folder))));
}

export function drawerBar() {
  const t = theme();
  const { terminal, folder, overlay } = props() ?? {};
  const action = (id, icon, tip, go) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
    .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); go(); })
    .child(svg(`${IMG}/${icon}.svg`).size(14));
  return h_flex().size_full().pl(12).pr(6).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .child(svg(`${IMG}/terminal.svg`).size(14).flex_none().text_color(t.muted))
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.body - 1).text_color(t.foreground).child("Terminal"))
    .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(short(folder)))
    .child(action("dr-tab", "tab", "Move to its own tab", () => { run("terminal.keep", { terminal, place: "tab" }); closeOverlay(overlay); }))
    .child(action("dr-close", "close", "Hide (keeps running)", () => closeOverlay(overlay)));
}
