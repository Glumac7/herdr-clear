// Roles come from props.role; the layout's toast gets no role, only the notification.
import { View, div } from "gpui-kit";
import { props, nextCommand, checking } from "herdr";
import { head, sidebar, SidebarState } from "./sidebar.js";
import { paneHeader } from "./pane.js";
import { statusBar, StatusState } from "./status.js";
import { tracker, TrackerState } from "./youtrack.js";
import { worktrees, WorktreeState } from "./worktrees.js";
import { startPicker, StartState } from "./start.js";
import { toast } from "./toast.js";
import { newTab } from "./newtab.js";
import { rightTabs, sidePanel } from "./righttabs.js";
import { toggleSide } from "./kit.js";
import { chatView, ChatState, syncView, setView, wantedView, openModels, openEffort, chatTarget } from "./chat.js";
import { modelsView, ModelsState, effortView, EffortState } from "./models.js";
import { contextView, ContextState } from "./context.js";
import { subagentsView, SubagentsState } from "./subagents.js";
import { SheetState, sheetBar } from "./cmdrun.js";
import { openInView, OpenInState, drawerBar, openDrawer } from "./openin.js";
import { syncTabNames } from "./names.js";
import { showView, stepView, stepSession } from "./agents.js";

const STATE = { spaces: SidebarState, status: StatusState, youtrack: TrackerState, worktrees: WorktreeState,
  start: StartState, chat: ChatState, models: ModelsState, effort: EffortState, openin: OpenInState, context: ContextState,
  subagents: SubagentsState, sheet: SheetState };

export default class Clear extends View {
  init(_props, cx) {
    this.hovered = false;
    const role = props()?.role;
    if (STATE[role]) {
      this.state = new STATE[role]();
      this.state.start(cx);
    }
    if (role === "status" && !checking()) cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "newtab") newTab();
        if (c === "sidebar") toggleSide(cx, "sidebar");
        if (c === "panel") toggleSide(cx, "right");
        if (c === "chat" || c === "terminal") setView(c === "chat" ? "chat" : "main");
        if (c === "view") setView(wantedView() === "chat" ? "main" : "chat");
        if (c === "models") openModels("switch");
        if (c === "handoff") openModels("handoff");
        if (c === "view-next") stepView(1);
        if (c === "view-prev") stepView(-1);
        if (c === "view-working" || c === "view-done" || c === "view-idle") showView(c.slice(5));
        if (c === "session-next") stepSession(1);
        if (c === "session-prev") stepSession(-1);
        if (c === "effort") openEffort();
        if (c === "drawer") {
          const target = chatTarget();
          if (target) await openDrawer(target.terminal, target.cwd);
        }
      }
    });
  }

  render(cx) {
    const p = props() ?? {};
    if (p.pane) return paneHeader(this);
    switch (p.role) {
      case "head": return head();
      case "spaces": return sidebar(this.state, cx);
      case "status":
        if (!checking()) { syncView(cx); syncTabNames(cx); }
        return statusBar(this.state);
      case "youtrack": return sidePanel(tracker(this.state, cx));
      case "worktrees": return sidePanel(worktrees(this.state));
      case "righttabs": return rightTabs();
      case "start": return startPicker(this.state);
      case "chat": return chatView(this.state, cx);
      case "models": return modelsView(this.state);
      case "context": return contextView(this.state);
      case "subagents": return sidePanel(subagentsView(this.state));
      case "sheet": return sheetBar(this.state);
      case "effort": return effortView(this.state);
      case "openin": return openInView(this.state);
      case "drawer": return drawerBar();
      default: return p.overlay ? toast() : div();
    }
  }
}
