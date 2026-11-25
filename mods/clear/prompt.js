import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { hc } from "herdr";
import { UI, MONO, SIZE, RED, IMG, button } from "./kit.js";

// Whatever omp is waiting on in its terminal (tool approvals, choices, console prompts, forms the chat can't fill in),
// mirrored in the chat from its screen. Clicks become the same keys you'd press there, and it re-reads after each one.

const strip = (l) => l.replace(/^[│┃]\s?/, "").replace(/\s*[│┃]\s*$/, "").replace(/\s+$/, "");

// The newest bordered box on screen that has a cursor row (❯) or a text field ("> ▏"): omp draws its dialogs that way.
function dialog(lines) {
  // Only the box at the bottom is open: below it are just omp's status bar, editor ("╰─ draft") and working line.
  // A box's bottom edge is "╰──…"; the editor line is "╰─" alone or followed by text.
  const bottom = (l) => /^[╰└]──/.test(l);
  const live = (end) => lines.slice(end + 1).every((l) => !l.trim() || /▶/.test(l) || /^╰─(\s|$)/.test(l) || /^\s*[⎋⠀-⣿]/.test(l));
  for (let end = lines.length - 1; end >= 0; end--) {
    if (!bottom(lines[end])) continue;
    if (!live(end)) return null;
    let start = end - 1;
    while (start >= 0 && /^[│┃├]/.test(lines[start])) start--;
    if (start < 0 || !/^[╭┌]/.test(lines[start])) continue;
    const inner = lines.slice(start + 1, end);
    const field = inner.some((l) => /^[│┃]\s*>\s/.test(l));
    if (!inner.some((l) => /^[│┃]\s*❯/.test(l)) && !field) continue;
    const split = inner.findIndex((l) => l.startsWith("├"));
    // Key hints are the footer, whether below a divider or as a plain row ("↑/↓ navigate  ⏎ select  ⎋ cancel").
    const rows = (split < 0 ? inner : inner.slice(0, split)).map(strip);
    const hints = rows.filter((l) => /⎋/.test(l));
    const body = rows.filter((l) => !/⎋/.test(l) && !/^\s*>\s*▏?\s*$/.test(l));
    const footer = [...hints, ...(split < 0 ? [] : inner.slice(split + 1).map(strip))].join(" ").trim();
    const title = lines[start].replace(/^[╭┌]/, "").replace(/[─━╮┐�]+/g, " ").trim();
    return { title, body, footer, field };
  }
  return null;
}

// Rows next to the cursor row, at its indent, are the choices; the text above them is the question.
function choices(body) {
  const at = body.findIndex((l) => /^\s*❯/.test(l));
  if (at < 0) return { context: body.filter(Boolean), options: [], cursor: -1 };
  const indent = body[at].search(/❯/);
  const row = (l) => l.length > indent + 2 && l.slice(0, indent + 2).trim() === "" && l[indent + 2] !== " ";
  let first = at;
  while (first > 0 && row(body[first - 1])) first--;
  let last = at;
  while (last < body.length - 1 && row(body[last + 1])) last++;
  const options = body.slice(first, last + 1).map((l) => l.replace("❯", " ").trim());
  return { context: body.slice(0, first).filter((l) => l.trim()), after: body.slice(last + 1).filter((l) => l.trim()), options, cursor: at - first };
}

// A console running with a PTY draws a box ending "input forwarded to PTY": its program may be asking for typed input.
// macOS can't tell omp whether it's waiting, so the box is the signal, not the agent's status.
function consoleBox(lines) {
  const at = lines.findLastIndex((l) => /input forwarded to PTY/.test(l));
  if (at < 0) return null;
  let start = at;
  while (start > 0 && !/^[╭┌]/.test(lines[start])) start--;
  const body = lines.slice(start + 1, at).map(strip).map((l) => l.replace(/^⟳\s*Console\s*/, "").replace(/\s*⟦\w+⟧\s*$/, "").trim()).filter(Boolean);
  return body;
}

export function readPrompt(screen) {
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const box = dialog(lines);
  if (box) return { kind: "dialog", title: box.title, footer: box.footer, ...choices(box.body) };
  const cmd = consoleBox(lines);
  if (cmd) return { kind: "console", title: "A command may be waiting for your input", context: cmd, options: [], cursor: -1, footer: "⎋ force-kill" };
  return null;
}

export class PromptState {
  constructor() {
    this.prompt = null;
    this.key = null;
    this.busy = false;
    this.error = null;
  }

  start() {
    this.reply = InputState.new({ placeholder: "Type an answer…" });
    this.reply.on("submit", (_e, cx) => this.type(cx));
  }

  // Re-reads the screen while the agent is blocked; the card follows each step of a multi-step dialog.
  refresh(cx, terminal) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const r = await hc(["read", terminal]).catch(() => null);
      this.reading = false;
      if (!r?.stdout) return;
      const p = readPrompt(r.stdout);
      const key = JSON.stringify(p);
      if (key !== this.key) { this.key = key; this.prompt = p; this.error = null; cx.notify(); }
    });
  }

  run(cx, terminal, keys) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      for (const k of keys) {
        const r = await hc(["keys", terminal, k]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code) { this.error = (r.stderr || "The key didn't reach the terminal.").trim(); break; }
      }
      this.busy = false;
      this.key = null;
      this.refresh(cx, terminal);
      cx.notify();
    });
  }

  // Moves omp's cursor from where it is to the clicked row, then confirms it.
  choose(cx, terminal, i) {
    const d = i - this.prompt.cursor;
    this.run(cx, terminal, [...Array(Math.abs(d)).fill(d > 0 ? "down" : "up"), "enter"]);
  }

  type(cx) {
    const text = this.reply.value();
    const terminal = this.terminal;
    if (!text.trim() || this.busy || !terminal) return;
    this.busy = true;
    this.reply.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", "--force", terminal, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code) { this.error = (r.stderr || "It didn't reach the terminal.").trim(); this.reply.set_value(text); }
      this.busy = false;
      this.key = null;
      this.refresh(cx, terminal);
      cx.notify();
    });
  }
}

function option(t, state, terminal, label, i) {
  const here = i === state.prompt.cursor;
  return h_flex().id(`pr-opt-${i}`).min_h(34).px(10).py(6).gap(10).items_center().rounded(8).cursor_pointer()
    .border(1).border_color(here ? t.accent + "66" : t.border).when(here, (el) => el.bg(t.accent + "14"))
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => state.choose(cx, terminal, i))
    .child(div().flex_1().min_w(0).font_family(UI).text_size(SIZE.body).line_height(1.4).text_color(t.foreground).child(label))
    .when(here, (el) => el.child(div().flex_none().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child("selected")));
}

export function promptCard(t, state, terminal, openTerminal) {
  state.terminal = terminal;
  const p = state.prompt;
  if (!p) return div();
  const text = (s) => div().font_family(p.kind === "console" ? MONO : UI).text_size(SIZE.body - 0.5).line_height(1.45).text_color(t.muted).child(s);
  return v_flex().w_full().p(14).gap(12).rounded(14).bg(t.surface).border(1).border_color(t.blocked + "66").shadow_md()
    .child(h_flex().gap(8).items_center()
      .child(div().size(8).rounded(4).flex_none().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 900 }))
      .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.blocked)
        .child(p.title || "omp needs your input"))
      .child(button("pr-term", "Open terminal", "Answer it in the terminal instead", openTerminal)))
    .child(v_flex().max_h(420).overflow_y_scroll().id("pr-body").gap(8)
      .children(p.context.map(text))
      .children(p.options.map((o, i) => option(t, state, terminal, o, i)))
      .children((p.after ?? []).map(text)))
    .child(h_flex().gap(8).items_center()
      .child(h_flex().flex_1().h(32).px(10).items_center().rounded(8).bg(t.background).border(1).border_color(t.border)
        .child(Input.new(state.reply).w_full().text_size(SIZE.body).text_color(t.foreground)))
      .child(button("pr-type", "Send", p.options.length ? "Types this into the dialog (for 'type to…' or Other)" : "Types this and presses Enter",
        (cx) => state.type(cx)))
      .child(button("pr-esc", escLabel(p.footer), "Presses Esc in the terminal", (cx) => state.run(cx, terminal, ["esc"]))))
    .when(Boolean(state.error || state.busy), (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(state.error ? RED : t.dim)
      .child(state.error ?? "Sending to the terminal…")));
}
