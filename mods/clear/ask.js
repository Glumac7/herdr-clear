import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { hc, theme } from "herdr";
import { UI, SIZE, RED, button } from "./kit.js";

// omp's ask tool sends one HTML <form>. The chat can fill in its single- and multiple-choice groups;
// anything else (text, dropdowns) is shown but answered in the terminal.

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'" };
const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]).replace(/\s+/g, " ").trim();
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? m[1] ?? m[2] ?? m[3] : null;
};
const flag = (tag, name) => new RegExp(`\\s${name}(?=[\\s/>=])`, "i").test(tag.replace(/"[^"]*"|'[^']*'/g, "\"\""));

const TOKENS = /<legend\b[^>]*>([\s\S]*?)<\/legend>|<(p|h[1-6]|li|pre)\b[^>]*>([\s\S]*?)<\/\2>|<label\b([^>]*)>([\s\S]*?)<\/label>|<input\b[^>]*>|<(select|textarea)\b[\s\S]*?<\/\6>|<\/fieldset>/gi;

export function parseForm(html) {
  const form = (/<form\b[\s\S]*?<\/form>/i.exec(html ?? "") ?? [html ?? ""])[0];
  const labelFor = new Map();
  for (const m of form.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) if (attr(m[1], "for")) labelFor.set(attr(m[1], "for"), strip(m[2]));
  const fields = [];
  const context = [];
  let legend = null;
  let last = null;
  let unsupported = false;
  const input = (tag, label) => {
    const type = (attr(tag, "type") ?? "text").toLowerCase();
    if (type === "hidden") return;
    if (type !== "radio" && type !== "checkbox") { unsupported = true; return; }
    const name = attr(tag, "name") ?? "";
    let field = fields.find((f) => f.name === name);
    if (!field) {
      // The question is the group's legend, else the text right before it, which then isn't repeated as context.
      const question = legend ?? last?.text ?? name;
      if (!legend && last) last.used = true;
      field = { name, kind: type, question, options: [] };
      fields.push(field);
    }
    field.options.push({ label: label || attr(tag, "value") || "", value: attr(tag, "value") ?? "on", checked: flag(tag, "checked"), disabled: flag(tag, "disabled") });
  };
  for (const m of form.matchAll(TOKENS)) {
    if (m[1] != null) { legend = strip(m[1]); continue; }
    if (m[2]) { last = { text: strip(m[3]), used: false }; if (last.text) context.push(last); continue; }
    if (m[4] != null) { const tag = /<input\b[^>]*>/i.exec(m[5])?.[0]; if (tag) input(tag, strip(m[5])); continue; }
    if (m[6]) { unsupported = true; continue; }
    if (m[0].toLowerCase() === "</fieldset>") { legend = null; continue; }
    input(m[0], labelFor.get(attr(m[0], "id")) ?? "");
  }
  // A lone checkbox is a yes/no flag; the chat only handles choice groups.
  if (fields.some((f) => f.options.length < 2 && f.kind === "checkbox")) unsupported = true;
  return { context: context.filter((c) => !c.used).map((c) => c.text), fields, unsupported: unsupported || !fields.length };
}

// What each group starts with: the form's own preselection.
export const defaults = (form) => Object.fromEntries(form.fields.map((f) => [f.name,
  f.kind === "radio" ? f.options.find((o) => o.checked)?.value ?? null : f.options.filter((o) => o.checked).map((o) => o.value)]));

// --- Answering: walk omp's form in the terminal by reading its screen after each key. ---

const BOX = /^\s*│/;
const norm = (line) => line.replace(/│/g, "").replace("❯", "").trim()
  .replace(/^(\[[ xX✓✔]?\]|[○◉●◯◎☐☑☒■□▢])\s*/u, "").trim();
const same = (line, label) => {
  const n = norm(line);
  return n === label || (n.endsWith("…") && label.startsWith(n.slice(0, -1).trim())) || n.startsWith(`${label} `);
};

async function cursor(terminal) {
  const r = await hc(["read", terminal]);
  return (r.stdout ?? "").split("\n").find((l) => BOX.test(l) && l.includes("❯")) ?? null;
}

// Moves down to the row whose text is `label`. The form lists rows top to bottom, so the walk only goes down.
async function reach(terminal, label) {
  for (let i = 0; i < 80; i++) {
    const line = await cursor(terminal);
    if (!line) throw new Error("The question isn't on the terminal screen anymore.");
    if (same(line, label)) return;
    await hc(["keys", terminal, "down"]);
  }
  throw new Error(`Couldn't find “${label}” in the terminal's form.`);
}

export async function answerForm(terminal, form, choices) {
  if (!(await cursor(terminal))) throw new Error("The question isn't on the terminal screen.");
  for (const f of form.fields) {
    for (const o of f.options) {
      const want = f.kind === "radio" ? choices[f.name] === o.value : (choices[f.name] ?? []).includes(o.value);
      // A radio row is picked once; a checkbox row is toggled only where it differs from its preset.
      const act = f.kind === "radio" ? want && !o.checked : want !== o.checked;
      if (!act || o.disabled) continue;
      await reach(terminal, o.label);
      await hc(["keys", terminal, "space"]);
    }
  }
  await reach(terminal, "Submit");
  await hc(["keys", terminal, "enter"]);
}

// --- The card shown in the chat in place of "switch to the terminal". ---

export class AskState {
  constructor() {
    this.id = null;
    this.form = null;
    this.choices = {};
    this.busy = false;
    this.error = null;
  }

  // One state per pending question; a new question starts from its own presets.
  sync(call) {
    if (call.id === this.id) return;
    this.id = call.id;
    this.form = parseForm(call.form);
    this.choices = defaults(this.form);
    this.busy = false;
    this.error = null;
  }

  pick(f, o) {
    if (f.kind === "radio") this.choices[f.name] = o.value;
    else {
      const set = new Set(this.choices[f.name] ?? []);
      if (set.has(o.value)) set.delete(o.value); else set.add(o.value);
      this.choices[f.name] = [...set];
    }
  }

  ready() {
    return this.form?.fields.every((f) => f.kind !== "radio" || this.choices[f.name] != null);
  }

  send(cx, terminal, done) {
    if (this.busy || !this.ready()) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await answerForm(terminal, this.form, this.choices);
        done();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
      }
      cx.notify();
    });
  }
}

function mark(t, kind, on) {
  const color = on ? t.accent : t.dim;
  return div().size(16).flex_none().flex().items_center().justify_center().border(1.5).border_color(color)
    .rounded(kind === "radio" ? 8 : 4).when(on, (el) => el.bg(kind === "radio" ? "#00000000" : t.accent))
    .when(on && kind === "radio", (el) => el.child(div().size(8).rounded(4).bg(t.accent)))
    .when(on && kind === "checkbox", (el) => el.child(div().font_family(UI).font_weight(700).text_size(10).text_color(t.accent_foreground).child("✓")));
}

function option(t, state, f, o, key) {
  const on = f.kind === "radio" ? state.choices[f.name] === o.value : (state.choices[f.name] ?? []).includes(o.value);
  return h_flex().id(`ask-${key}`).min_h(34).px(10).py(6).gap(10).items_center().rounded(8).cursor_pointer()
    .border(1).border_color(on ? t.accent + "66" : t.border).when(on, (el) => el.bg(t.accent + "14"))
    .when(!on && !o.disabled, (el) => el.hover((s) => s.bg(t.hover)))
    .when(Boolean(o.disabled), (el) => el.opacity(0.4))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { if (o.disabled || state.busy) return; state.pick(f, o); cx.notify(); })
    .child(mark(t, f.kind, on))
    .child(div().flex_1().min_w(0).font_family(UI).text_size(SIZE.body).line_height(1.4).text_color(t.foreground).child(o.label));
}

export function askCard(t, state, call, terminal, openTerminal, done) {
  state.sync(call);
  const form = state.form;
  return v_flex().w_full().p(14).gap(12).rounded(14).bg(t.surface).border(1).border_color(t.blocked + "66").shadow_md()
    .child(h_flex().gap(8).items_center()
      .child(div().size(8).rounded(4).flex_none().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 900 }))
      .child(div().flex_1().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.blocked).child(call.intent || "omp needs your answer"))
      .child(button("ask-term", "Open terminal", "Answer it in the terminal instead", openTerminal)))
    .child(v_flex().max_h(420).overflow_y_scroll().id("ask-body").gap(12)
      .children(form.context.map((c) => div().font_family(UI).text_size(SIZE.body - 0.5).line_height(1.45).text_color(t.muted).child(c)))
      .when(!form.unsupported, (el) => el.children(form.fields.map((f, i) => v_flex().gap(6)
        .child(div().font_family(UI).font_weight(600).text_size(SIZE.body).line_height(1.4).text_color(t.foreground).child(f.question))
        .when(f.kind === "checkbox", (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child("Pick any")))
        .children(f.options.map((o, j) => option(t, state, f, o, `${i}-${j}`))))))
      .when(form.unsupported, (el) => el.children(form.fields.map((f) => div().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.foreground).child(f.question)))
        .child(div().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.dim).child("This question has a field the chat can't fill in yet. Answer it in the terminal."))))
    .when(!form.unsupported, (el) => el.child(h_flex().gap(10).items_center()
      .child(div().flex_1().min_w(0).font_family(UI).text_size(SIZE.meta + 0.5).text_color(state.error ? RED : t.dim)
        .child(state.error ?? (state.busy ? "Answering in the terminal…" : state.ready() ? "" : "Pick an answer for each question.")))
      .child(button("ask-send", state.busy ? "Sending…" : "Send answer", "omp gets the answer as if you'd filled in the form",
        (cx) => state.send(cx, terminal, done), "primary"))));
}
