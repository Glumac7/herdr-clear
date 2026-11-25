import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec, props, closeOverlay, checking, shared, setShared } from "herdr";
import { UI, MONO, SIZE, RED, IMG, EFFORT, button, dot } from "./kit.js";
import { slash, NOW, refocus } from "./chat.js";
import { modelList, cachedModel, available, latest, provider } from "./catalog.js";

// omp's /handoff runs in the background and lands as a compaction entry in the session file.
async function compactions(file) {
  const r = await exec("grep", ["-c", '"type":"compaction"', file], { timeout: 5000 }).catch(() => null);
  return Number(r?.stdout.trim() || 0);
}

// Model, provider and effort for one omp agent, or a hand-off of its session to another model.
export class ModelsState {
  constructor() {
    this.list = null;
    this.error = null;
    this.busy = null;
  }

  start(cx) {
    this.search = InputState.new({ placeholder: "Search models and providers…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.focus = InputState.new({ placeholder: "What should the next model focus on? (optional)" });
    this.search.focus();
    if (checking()) return;
    cx.spawn(async (cx) => {
      this.list = await modelList().catch((e) => { this.error = `Could not list models: ${e}`; return null; });
      cx.notify();
    });
  }

  run(cx, steps) {
    if (this.busy) return;
    const { terminal, overlay } = props();
    cx.spawn(async (cx) => {
      for (const [label, go] of steps) {
        this.busy = label;
        this.error = null;
        cx.notify();
        const error = await go(terminal);
        if (error) { this.busy = null; this.error = error; cx.notify(); return; }
      }
      closeOverlay(overlay);
      refocus();
    });
  }

  pick(cx, model) {
    const toModel = [`Switching to ${model.name}…`, async (t) => {
      const error = await slash(t, `/switch ${model.selector}`);
      if (!error) setShared(NOW, { ...shared(NOW), model: model.selector });
      return error;
    }];
    if (props().mode !== "handoff") return this.run(cx, [toModel]);
    const { file } = props();
    const focus = this.focus.value().trim();
    let before = 0;
    this.run(cx, [
      ["Writing the hand-off summary…", async (t) => {
        if (!file) return "This agent's session file wasn't found.";
        before = await compactions(file);
        return slash(t, `/handoff ${focus}`.trim());
      }],
      ["Waiting for the summary…", async () => {
        for (let i = 0; i < 120; i++) {
          if (await compactions(file) > before) return null;
          await exec("sleep", ["1.5"]);
        }
        return "No hand-off summary after 3 minutes. Check the terminal.";
      }],
      toModel,
    ]);
  }
}

export class EffortState {
  constructor() {
    this.levels = null;
    this.error = null;
  }

  start(cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      const list = await modelList().catch(() => []);
      this.levels = list.find((m) => m.selector === props()?.model)?.thinking ?? Object.keys(EFFORT).filter((l) => !["off", "auto"].includes(l));
      cx.notify();
    });
  }

  // Shown at once in the composer; the session file confirms it a moment later.
  set(cx, level) {
    const { terminal, overlay } = props();
    cx.spawn(async (cx) => {
      const error = await slash(terminal, `/effort ${level}`);
      if (error) { this.error = error; cx.notify(); return; }
      setShared(NOW, { ...shared(NOW), effort: level });
      closeOverlay(overlay);
      refocus();
    });
  }
}

export function effortView(state) {
  const t = theme();
  const current = props()?.effort;
  return v_flex().size_full().p(6).gap(2).bg(t.popover)
    .child(div().px(8).pt(4).pb(4).font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted).child("Reasoning effort"))
    .when(Boolean(state.error), (el) => el.child(div().px(8).pb(4).font_family(UI).text_size(SIZE.meta).text_color(RED).child(state.error)))
    .children((state.levels ?? []).map((l) => {
      const color = EFFORT[l] ?? t.muted;
      const on = l === current;
      return h_flex().id(`eff-${l}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(on, (el) => el.bg(color + "26")).hover((s) => s.bg(color + "33"))
        .on_click((_e, cx) => state.set(cx, l))
        .child(dot(color, 8))
        .child(div().flex_1().font_family(UI).font_weight(on ? 600 : 500).text_size(SIZE.body).text_color(on ? color : t.foreground).child(l))
        .when(on, (el) => el.child(svg(`${IMG}/check.svg`).size(12).flex_none().text_color(color)));
    }));
}

function row(t, state, m, current, color) {
  const on = m.selector === current;
  return h_flex().id(`mdl-${m.selector}`).h(34).px(10).gap(10).items_center().rounded(8).cursor_pointer()
    .when(on, (el) => el.bg(color + "26")).hover((s) => s.bg(on ? color + "26" : t.hover))
    .on_click((_e, cx) => state.pick(cx, m))
    .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(on ? 600 : 500).text_size(SIZE.body).text_color(t.foreground).child(m.name))
    .child(div().flex_none().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(`${Math.round(m.contextWindow / 1000)}k`))
    .child(on ? svg(`${IMG}/check.svg`).size(13).flex_none().text_color(color) : div().size(13).flex_none());
}

function providerHeader(t, id) {
  const p = provider(id);
  const color = p.color ?? t.muted;
  return h_flex().px(10).pt(12).pb(4).gap(8).items_center()
    .child(div().size(20).flex_none().flex().items_center().justify_center().rounded(5).bg(color + "26")
      .when(Boolean(p.icon), (el) => el.child(svg(`${IMG}/${p.icon}.svg`).size(12).text_color(color))))
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta + 0.5).text_color(color).child(p.name));
}

export function modelsView(state) {
  const t = theme();
  const { mode, model: current, overlay } = props() ?? {};
  const handoff = mode === "handoff";
  const q = state.search.value().trim().toLowerCase();
  const list = latest((state.list ?? []).filter(available)).filter((m) => !handoff || m.selector !== current)
    .filter((m) => !q || `${m.provider} ${provider(m.provider).name} ${m.name} ${m.id}`.toLowerCase().includes(q));
  const providers = [...new Set(list.map((m) => m.provider))];
  return v_flex().size_full().bg(t.popover)
    .child(v_flex().px(16).pt(16).pb(10).gap(4)
      .child(div().font_family(UI).font_weight(600).text_size(SIZE.heading).text_color(t.foreground)
        .child(handoff ? "Hand off to another model" : "Model"))
      .child(div().font_family(UI).text_size(SIZE.body - 1).text_color(t.muted).child(handoff
        ? "omp writes a hand-off summary, compacts the session to it, then carries on with the model you pick."
        : `Now: ${cachedModel(current)?.name ?? current ?? "unknown"}`)))
    .when(handoff, (el) => el.child(div().mx(16).mb(10).h(32).px(10).flex().items_center().rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(Input.new(state.focus).w_full().text_size(SIZE.body).text_color(t.foreground))))
    .child(div().mx(16).mb(8).h(32).px(10).flex().items_center().rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(Input.new(state.search).w_full().text_size(SIZE.body).text_color(t.foreground)))
    .child(v_flex().id("mdl-list").flex_1().min_h(0).overflow_y_scroll().px(8).pb(8).gap(2)
      .when(!state.list && !state.error, (el) => el.child(div().p(10).font_family(UI).text_size(SIZE.body).text_color(t.dim).child("Loading models…")))
      .children(providers.flatMap((p) => [
        providerHeader(t, p),
        ...list.filter((m) => m.provider === p).map((m) => row(t, state, m, current, provider(p).color ?? t.accent)),
      ])))
    .child(h_flex().h(48).px(16).gap(10).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.meta + 0.5)
        .text_color(state.error ? RED : t.muted).child(state.error ?? state.busy ?? "Applies when the agent is idle."))
      .child(button("mdl-cancel", "Cancel", "Esc", () => closeOverlay(overlay))));
}
