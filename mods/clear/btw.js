import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { exec, hc, theme, agents } from "herdr";
import { UI, SIZE, RED, IMG, button, iconButton } from "./kit.js";
import { appear, flash } from "./motion.js";
import { richText } from "./blocks.js";

// omp's /btw: a side question about the session that never enters its transcript. omp saves each topic
// (question, answer, follow-ups) under <session>/btw-history/; the side chat reads those and asks through the terminal.

// omp's side-question footers: "… · ⎋ to close", "⎋ close · …" (history), "⏎ send · ⎋ cancel" (follow-up box).
// Pinned to those forms: the working line also starts with ⎋, and Esc there would stop the agent.
const PANEL = /·\s*⎋ (to )?close|⎋ close ·|·\s*⎋ cancel/;
const busy = (topic) => topic && /running|pending|streaming|start/i.test(topic.status ?? "") ;
const pause = (s) => exec("sleep", [String(s)]);

export async function screen(terminal) {
  return (await hc(["read", terminal]).catch(() => ({ stdout: "" }))).stdout ?? "";
}

// Esc closes omp's side panel, but in the editor it would interrupt the agent: only press it while the panel shows.
export async function closePanels(terminal) {
  for (let i = 0; i < 4; i++) {
    if (!PANEL.test(await screen(terminal))) return;
    await hc(["keys", terminal, "esc"]);
    await pause(0.3);
  }
}

export class BtwState {
  constructor() {
    this.open = false;
    this.file = null;
    this.topics = [];
    this.follow = false;
    this.sending = false;
    this.error = null;
    this.at = 0;
    this.seen = null;
    this.fresh = new Set();
    this.delay = new Map();
    this.copied = null;
  }

  start() {
    this.input = TextareaState.new({ placeholder: "Ask a side question…" });
    this.input.set_auto_grow(1, 6);
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.scroll = ScrollHandle.new();
  }

  // Reads the topics on open, often while one is answering, else now and then.
  tick(cx, file, terminal) {
    if (file !== this.file) { this.file = file; this.topics = []; this.follow = false; this.at = 0; this.seen = null; }
    this.terminal = terminal;
    if (!this.open || !file) return;
    const live = this.sending || this.topics.some(busy);
    if (Date.now() - this.at < (live ? 1200 : 10000)) return;
    this.at = Date.now();
    cx.spawn(async (cx) => {
      const dir = `${file.replace(/\.jsonl$/, "")}/btw-history`;
      const r = await exec("sh", ["-c", 'for f in "$1"/*.json; do [ -s "$f" ] && cat "$f" && echo; done', "sh", dir], { timeout: 8000 }).catch(() => null);
      const topics = (r?.stdout ?? "").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      if (file !== this.file) return;
      const grew = topics.length !== this.topics.length || JSON.stringify(topics.at(-1)) !== JSON.stringify(this.topics.at(-1));
      this.topics = topics;
      // Questions and answers that arrived since the last read animate in; the first read of a session shows them still.
      // A question you just asked is already on screen as the waiting bubble, so it takes that place without moving.
      const keys = topics.flatMap((x) => [x, ...(x.followUps ?? [])].flatMap((turn, i) => [
        { key: `${x.id}-${i}-q`, mine: turn.question === this.pendingQ?.question }, ...(turn.answer ? [{ key: `${x.id}-${i}-a` }] : [])]));
      if (this.seen) flash(this, cx, keys.filter((k) => !this.seen.has(k.key) && !k.mine).map((k) => k.key));
      this.seen = new Set(keys.map((k) => k.key));
      if (grew) { cx.notify(); cx.timer.after(40, () => this.scroll.scroll_to_item(this.topics.length + 1)); }
    });
  }

  toggle(cx, open = !this.open) {
    this.open = open;
    this.at = 0;
    if (open) this.input.focus();
    cx.notify();
  }

  ask(cx, question) {
    this.toggle(cx, true);
    if (question) { this.input.set_value(question); this.submit(cx); }
  }

  submit(cx) {
    const q = this.input.value().trim();
    const terminal = this.terminal;
    if (!q || this.sending || !terminal) return;
    const status = agents().find((a) => a.address === terminal)?.status;
    if (status === "blocked") { this.error = "omp is waiting on a question in the session; answer that first."; return cx.notify(); }
    if (this.topics.some(busy)) { this.error = "omp is still answering the last side question."; return cx.notify(); }
    const follow = this.follow && this.topics.length > 0;
    this.sending = true;
    this.pendingQ = { question: q, follow, at: Date.now() };
    flash(this, cx, [`wait-${this.pendingQ.at}`]);
    this.error = null;
    this.input.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await closePanels(terminal);
        if (follow) {
          // Bare /btw opens omp's history with the newest topic selected; f follows it up.
          await hc(["send", terminal, "/btw"]);
          await pause(0.5);
          if (!PANEL.test(await screen(terminal))) throw new Error("omp's side question history didn't open.");
          await hc(["keys", terminal, "f"]);
          await pause(0.3);
          await hc(["send", "--force", terminal, q]);
        } else {
          await hc(["send", terminal, `/btw ${q}`]);
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.pendingQ = null;
        this.input.set_value(q);
      }
      this.sending = false;
      this.at = 0;
      cx.notify();
    });
  }
}

function bubble(t, text) {
  return h_flex().w_full().justify_end().child(div().max_w(280).px(12).py(7).rounded(14).bg(t.raised)
    .font_family(UI).text_size(SIZE.body).line_height(1.45).text_color(t.foreground).child(text));
}

function answer(t, state, id, turn) {
  const pending = !turn.answer && !/fail|cancel/i.test(turn.status ?? "");
  const failed = /fail/i.test(turn.status ?? "");
  return v_flex().w_full().gap(4)
    .when(Boolean(turn.answer), (el) => el.child(div().w_full().font_family(UI).text_size(SIZE.body).line_height(1.55).text_color(t.foreground)
      .child(richText(t, state, id, turn.answer, (key, md) => TextView.markdown(key, md).selectable(true), 10))))
    .when(pending, (el) => el.child(div().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.dim)
      .loop("opacity", { from: 0.45, to: 1, period: 1400 }).child("Thinking…")))
    .when(failed || /cancel/i.test(turn.status ?? ""), (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(failed ? RED : t.dim)
      .child(failed ? "This answer failed." : "Cancelled.")))
    .when(Boolean(turn.answer) && !pending, (el) => el.child(h_flex()
      .child(div().id(`btw-cp-${id}`).h(22).px(6).gap(5).flex().items_center().rounded(6).cursor_pointer().text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Copy the whole answer").on_click((_e, cx) => cx.write_to_clipboard(turn.answer))
        .child(svg(`${IMG}/copy.svg`).size(11).flex_none()).child(div().font_family(UI).text_size(SIZE.meta).child("Copy all")))));
}

function topic(t, state, x, newest) {
  const turns = [x, ...(x.followUps ?? [])];
  return v_flex().w_full().gap(10).pb(14).border_b(1).border_color(newest ? "#00000000" : t.border)
    .children(turns.flatMap((turn, i) => [
      appear(bubble(t, turn.question), `${x.id}-${i}-q`, state, 18),
      appear(answer(t, state, `btw-${x.id}-${i}`, turn), `${x.id}-${i}-a`, state, 10),
    ]));
}

export function btwPanel(t, state, close) {
  const topics = state.topics;
  const newest = topics.at(-1);
  const waiting = state.sending || (state.pendingQ && Date.now() - state.pendingQ.at < 60000
    && !topics.some((x) => [x, ...(x.followUps ?? [])].some((turn) => turn.question === state.pendingQ.question)));
  return v_flex().w(380).flex_none().h_full().bg(t.surface).border_l(1).border_color(t.border)
    .child(h_flex().h(46).flex_none().pl(16).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.foreground).child("Side chat"))
        .child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child("/btw · stays out of the session")))
      .child(iconButton("btw-close", "close", "Close side chat", close)))
    .child(v_flex().id("btw-list").flex_1().min_h(0).overflow_y_scroll().track_scroll(state.scroll).px(14).pt(14).gap(14)
      .when(!topics.length && !waiting, (el) => el.child(div().pt(20).font_family(UI).text_size(SIZE.body - 0.5).line_height(1.5).text_color(t.dim)
        .child("Ask something about this session without interrupting it or adding to its history: a quick explanation, a summary, a check. omp answers from what's in the session right now.")))
      .children(topics.map((x) => topic(t, state, x, x === newest)))
      .when(Boolean(waiting), (el) => el.child(appear(v_flex().gap(10).child(bubble(t, state.pendingQ?.question ?? ""))
        .child(div().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.dim).loop("opacity", { from: 0.45, to: 1, period: 1400 }).child("Asking…")),
        `wait-${state.pendingQ?.at}`, state, 18))))
    .child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
      .when(Boolean(state.error), (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(RED).child(state.error)))
      .when(Boolean(newest), (el) => el.child(h_flex().gap(6)
        .child(followChip(t, state, false, "New question"))
        .child(followChip(t, state, true, "Follow up"))))
      // The send button sets the row's height; the text sits centred against it on one line and grows upward from there.
      .child(h_flex().gap(8).items_end().pl(12).pr(6).py(6).rounded(12).bg(t.background).border(1).border_color(t.border)
        .child(div().flex_1().min_w(0).min_h(28).flex().items_center().font_family(UI).text_size(SIZE.body).text_color(t.foreground)
          .child(Textarea.new(state.input).w_full()))
        .child(div().id("btw-send").size(28).flex_none().flex().items_center().justify_center().rounded(14).cursor_pointer()
          .bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.85))
          .tooltip(state.follow ? "Follow up on the newest side question" : "Ask a new side question")
          .on_click((_e, cx) => state.submit(cx)).child(svg(`${IMG}/arrow-up.svg`).size(13)))));
}

function followChip(t, state, follow, label) {
  const on = state.follow === follow;
  return div().id(`btw-mode-${follow}`).h(22).px(8).flex().items_center().rounded(11).cursor_pointer()
    .font_family(UI).font_weight(on ? 600 : 500).text_size(SIZE.meta).text_color(on ? t.foreground : t.dim)
    .when(on, (el) => el.bg(t.raised)).when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
    .tooltip(follow ? "Continue the newest side question" : "Start a separate side question")
    .on_click((_e, cx) => { state.follow = follow; state.input.focus(); cx.notify(); })
    .child(label);
}
