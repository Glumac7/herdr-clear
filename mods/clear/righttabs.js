import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, theme, shared } from "herdr";
import { find, segmented, narrow, edgeHandle } from "./kit.js";
import { LIVE } from "./subagents.js";

export const STACK = "right-body";
const TABS = [["youtrack", "Tickets"], ["worktrees", "Worktrees"], ["subagents", "Agents"]];

export function rightTabs() {
  const t = theme();
  if (narrow("right")) return div().size_full().bg(t.chrome);
  const active = find(layout(), STACK)?.active ?? TABS[0][0];
  // The Agents tab counts the shown session's running subagents, so work in flight is visible from any tab.
  const now = shared("clear.chat.now")?.file;
  const live = shared(LIVE);
  const running = live?.file === now ? live.running : 0;
  const items = TABS.map(([id, text]) => (id === "subagents" && running ? [id, text, running, t.working] : [id, text]));
  return h_flex().size_full().px(12).items_center().justify_center().bg(t.chrome)
    .child(segmented("rt", items, active, (id) => run("layout.select", { stack: STACK, child: id })));
}

// Folded, the panel is a strip holding only its handle.
export function sidePanel(content) {
  const t = theme();
  return div().relative().size_full().bg(t.chrome)
    .when(!narrow("right"), (el) => el.child(content))
    .child(edgeHandle(t, "right"));
}
