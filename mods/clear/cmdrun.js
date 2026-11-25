import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { hc, exec, agents, theme, props, openOverlay, closeOverlay, shared, setShared, checking } from "herdr";
import { UI, MONO, SIZE, IMG, button } from "./kit.js";
import { screen } from "./btw.js";
import { readPrompt } from "./prompt.js";

// Running an omp command from the chat and showing what it did. omp prints a command's result as a line on its
// screen and saves nothing to the session, so the result is read off the screen. A command that opens a panel
// gets omp's live terminal in a sheet over the chat.

const pause = (s) => exec("sleep", [String(s)]);
const STATUS = /▶/;

// The rows above omp's status bar: where its notices and results land. Lines pushed far right are the session
// title omp shows above its status bar, not output.
function tail(text) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const bar = lines.findLastIndex((l) => STATUS.test(l) && l.includes(" > "));
  return lines.slice(0, bar < 0 ? lines.length : bar)
    .filter((l) => l.trim() && !/^[╰╭│├]/.test(l) && !/^\s*⎋ /.test(l) && l.search(/\S/) < 40)
    .slice(-14).map((l) => l.trim());
}

// A panel is a tall box with an Esc footer: /usage, /model, /tools, /context. Short boxes are questions for the card.
export function isPanel(text) {
  const lines = text.split("\n");
  for (let end = lines.length - 1; end >= 0; end--) {
    if (!/^[╰└]──/.test(lines[end])) continue;
    let start = end - 1;
    while (start >= 0 && /^[│┃├]/.test(lines[start])) start--;
    if (start < 0 || !/^[╭┌]/.test(lines[start])) return false;
    return end - start >= 12 && lines.slice(start, end).some((l) => /⎋/.test(l));
  }
  return false;
}

// Which modes omp's status line shows on: ⚡ fast, 👁 advisor, 🗺 Plan (⏸ paused), 👥 Vibe, 🎯 Goal.
export function parseModes(text) {
  // A panel covers the status line; then nothing is known and the caller keeps what it had.
  const bar = text.split("\n").findLast((l) => STATUS.test(l) && l.includes(" > "));
  if (!bar) return null;
  const line = bar.split("▶")[0];
  const modes = [];
  if (/🗺\s*Plan/.test(line)) modes.push(/🗺\s*Plan\s*⏸/.test(line) ? "plan-paused" : "plan");
  if (/👥\s*Vibe/.test(line)) modes.push("vibe");
  if (/🎯\s*Goal/.test(line)) modes.push("goal");
  if (/⚡/.test(line)) modes.push("fast");
  if (/👁/.test(line)) modes.push("advisor");
  return modes;
}

async function send(terminal, text) {
  const args = /^[a-z0-9 ./:_@-]+$/.test(text) ? ["keys", terminal, ...[...text].map((c) => (c === " " ? "space" : c)), "enter"]
    : ["send", terminal, text];
  const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
  return r.code === 0 ? null : (r.stderr || r.stdout || `hc exited with ${r.code}`).trim();
}

// Returns { panel } | { dialog } | { started } | { lines } | { error }.
export async function runCommand(terminal, text) {
  const status = () => agents().find((a) => a.address === terminal)?.status;
  if (status() === "blocked") return { error: "omp is waiting on a question; answer it first." };
  const before = await screen(terminal);
  const seen = new Set(tail(before));
  const error = await send(terminal, text);
  if (error) return { error };
  let lines = [];
  let same = 0;
  for (let i = 0; i < 14; i++) {
    await pause(0.35);
    const now = await screen(terminal);
    if (isPanel(now)) return { panel: true };
    if (status() === "blocked" || readPrompt(now)?.kind === "dialog") return { dialog: true };
    const fresh = tail(now).filter((l) => !seen.has(l) && !l.includes(text));
    if (fresh.length && fresh.join("\n") === lines.join("\n")) same++;
    else same = 0;
    lines = fresh;
    if (lines.length && same >= 2) break;
    if (!lines.length && status() === "working" && i >= 3) return { started: true };
  }
  return { lines };
}

// --- The sheet: omp's live terminal over the chat while a panel is open. ---

export const SHEET = "clear.sheet";

export function openSheet(terminal, title) {
  const now = shared(SHEET);
  if (now?.terminal === terminal) return;
  setShared(SHEET, { terminal, title, at: Date.now() });
  openOverlay({ kind: "window", key: "clear-sheet", width: 980, height: 640,
    layout: { type: "column", children: [
      { type: "block", size: { px: 44 }, content: { mod: "clear", props: { role: "sheet", terminal, title } } },
      { type: "block", content: { terminal } },
    ] } });
}

// The sheet's title bar. It closes itself once omp's panel is gone (closed with Esc, or a pick made in it).
export class SheetState {
  start(cx) {
    if (checking()) return;
    const { terminal } = props();
    const opened = Date.now();
    cx.timer.every(700, (cx) => cx.spawn(async () => {
      if (Date.now() - opened < 1500 || this.closing) return;
      if (!isPanel(await screen(terminal))) this.close();
    }));
  }

  close() {
    this.closing = true;
    setShared(SHEET, null);
    closeOverlay(props().overlay);
  }

  done(cx) {
    const { terminal } = props();
    cx.spawn(async () => { await hc(["keys", terminal, "esc"]).catch(() => null); await pause(0.3); this.close(); });
  }
}

export function sheetBar(state) {
  const t = theme();
  const { title } = props() ?? {};
  return h_flex().size_full().px(14).gap(10).items_center().bg(t.surface).border_b(1).border_color(t.border)
    .child(svg(`${IMG}/terminal.svg`).size(14).flex_none().text_color(t.muted))
    .child(div().flex_none().font_family(MONO).font_weight(600).text_size(SIZE.body).text_color(t.foreground).child(title ?? "omp"))
    .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.meta).text_color(t.dim)
      .child("omp's panel, live. Click into it to use the keyboard; it closes when the panel does."))
    .child(button("sheet-done", "Done", "Close the panel (Esc)", (cx) => state.done(cx)));
}
