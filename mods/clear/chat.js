import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { agents, panes, spaces, terminals, theme, run, hc, exec, focused, layout, openOverlay, watchFolder, shared, setShared, checking, nextCommand, window, notify } from "herdr";
import { UI, MONO, SIZE, RED, IMG, EFFORT, button, segmented, hue, dot, short, find, elapsed, statusMark } from "./kit.js";
import { Session, TAIL } from "./session.js";
import { parseTitle } from "./names.js";
import { openDrawer } from "./openin.js";
import { Composer, suggestions, tokenView } from "./composer.js";
import { adopt, pasteImage, chooseFiles, splitMentions, thumbnails, attachmentRow } from "./attach.js";
import { modelList, cachedModel, defaultModel, cachedDefault, checkModels, provider } from "./catalog.js";
import { openContext, tokens } from "./context.js";
import { LIVE, countAgents, showAgents } from "./subagents.js";
import { AskState, askCard, parseForm } from "./ask.js";
import { PromptState, promptCard } from "./prompt.js";
import { BtwState, btwPanel } from "./btw.js";
import { appear, flash } from "./motion.js";
import { deliver, draftIn, holds, sendDraft, discardDraft } from "./delivery.js";
import { richText } from "./blocks.js";
import { screen } from "./btw.js";
import { refreshCatalog, needsInput } from "./cmds.js";
import { runCommand, openSheet, parseModes, SHEET } from "./cmdrun.js";
import { commandNote, modeChips, optionBar, commandButton, interleave } from "./cmdui.js";

const PAGE = 60;
const WIDTH = 760;
const CALL_ROW = 28;
const SESSION = /\/\.omp\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/;

// The work area is a stack: the chat for the shown tab's omp agent, or the tab's panes ("main").
export const STACK = "main-view";
const VIEWS = "clear.views";
const PICKS = "clear.chat.picks";
export const NOW = "clear.chat.now";
const REFOCUS = "clear.chat.refocus";

// Dialogs that change the agent hand the keyboard back to the composer when they close.
export const refocus = () => setShared(REFOCUS, Date.now());
const TAB_ACTION = "clear::AcceptSuggestion";
export const VIEW_ITEMS = [["chat", "Chat"], ["main", "Terminal"]];

// omp's status report can lag or blink after a restart; the foreground process is the steadier signal.
export const isOmp = (p) => Boolean(p?.terminal) &&
  (p.app === "omp" || terminals().find((t) => t.address === p.terminal)?.foreground?.name === "omp");

const tabAgents = (tab) => panes().filter((p) => p.tab === tab && isOmp(p));

// The omp pane the chat shows for the focused tab: the one picked there, else the focused one, else the first.
export function chatTarget() {
  const tab = focused()?.tab;
  const list = tabAgents(tab);
  const pick = (shared(PICKS) ?? {})[tab];
  return list.find((p) => p.terminal === pick) ?? list.find((p) => p.focused) ?? list[0] ?? null;
}

// Chat is the default wherever the tab has an omp agent; tabs without one always show their panes.
export function wantedView() {
  const tab = focused()?.tab;
  if (!tab || !tabAgents(tab).length) return "main";
  return (shared(VIEWS) ?? {})[tab] ?? "chat";
}

export function setView(view, terminal) {
  const tab = focused()?.tab;
  if (tab) setViewFor(tab, view, terminal);
}

export function setViewFor(tab, view, terminal) {
  setShared(VIEWS, { ...(shared(VIEWS) ?? {}), [tab]: view });
  if (terminal) setShared(PICKS, { ...(shared(PICKS) ?? {}), [tab]: terminal });
}

// Called from an always-mounted block so the stack follows the tab even while the chat is hidden.
export function syncView(cx) {
  const want = wantedView();
  if ((find(layout(), STACK)?.active ?? "chat") !== want) cx.timer.after(0, () => run("layout.select", { stack: STACK, child: want }));
}

export const viewSwitch = (id, active, terminal) => div().w(150).flex_none()
  .child(segmented(id, VIEW_ITEMS, active, (view) => setView(view, terminal)));

// Slash commands only land at omp's prompt; typed mid-turn they'd become a message, so refuse while the agent is busy.
// Plain commands are typed as keystrokes: `hc send` waits ~5s for a turn that a slash command never starts.
export async function slash(terminal, text) {
  const status = agents().find((a) => a.address === terminal)?.status;
  if (status === "working" || status === "blocked") return "The agent is busy. Try again when it's idle.";
  const args = /^[a-z0-9 ./:_@-]+$/.test(text) ? ["keys", terminal, ...[...text].map((c) => (c === " " ? "space" : c)), "enter"]
    : ["send", terminal, text];
  const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
  return r.code === 0 ? null : (r.stderr || r.stdout || `hc exited with ${r.code}`).trim();
}

// One agent's conversation. Kept per terminal, so switching tabs and back shows it at once instead of rereading it.
class Feed {
  constructor(terminal) {
    this.terminal = terminal;
    this.file = null;
    this.offset = 0;
    this.session = new Session();
    this.blocks = [];
    this.pending = [];
    this.notes = [];
    this.loaded = false;
    this.loading = false;
    this.again = false;
  }
}

export class ChatState {
  constructor() {
    this.terminal = null;
    this.feeds = new Map();
    this.drafts = new Map();
    this.limit = PAGE;
    this.open = new Set();
    this.fresh = new Set();
    this.delay = new Map();
    this.hover = null;
    this.entering = false;
    this.gen = 0;
    this.cwd = null;
    this.vocab = { key: null, words: new Set() };
    this.attached = new Map();
    this.ask = new AskState();
    this.btw = new BtwState();
    this.prompt = new PromptState();
  }

  get feed() {
    return this.feeds.get(this.terminal) ?? null;
  }

  get files() {
    return this.attached.get(this.terminal) ?? [];
  }

  attach(cx, load) {
    const terminal = this.terminal;
    cx.spawn(async (cx) => {
      const added = (await load()).filter(Boolean);
      if (!added.length || !terminal) return;
      this.attached.set(terminal, [...(this.attached.get(terminal) ?? []), ...added]);
      cx.notify();
    });
  }

  detach(i, cx) {
    this.attached.set(this.terminal, this.files.filter((_a, j) => j !== i));
    cx.notify();
  }

  start(cx) {
    this.scroll = ScrollHandle.new();
    this.btw.start();
    this.prompt.start();
    this.input = TextareaState.new({ placeholder: "Message omp…  / for commands, @ for files" });
    this.input.set_auto_grow(1, 8);
    this.composer = new Composer(this.input);
    // A picked command that takes nothing runs at once; one that takes options waits in the box with its option bar.
    this.composer.onPick = (cx, c) => { if (!needsInput(c) && !c.hint) this.send(cx); };
    this.input.on("change", (_e, cx) => this.composer.typed(cx, { cwd: this.cwd, words: () => this.words() }));
    this.input.on("submit", (e, cx) => {
      this.composer.clearGhost();
      if (this.composer.accept(cx)) return;
      if (!e.shift) this.send(cx);
    });
    this.input.on("paste_other", (_e, cx) => this.attach(cx, async () => [await pasteImage()]));
    if (checking()) return;
    // The textarea binds Tab to indent; a binding scoped to it inside the composer, added later, wins that tie.
    try {
      cx.bind_keys([{ keystroke: "tab", action: TAB_ACTION, context: "ClearComposer > Input" }]);
    } catch (e) {
      console.log(`clear: Tab binding refused (${e}); Tab falls back to undoing the indent`);
    }
    cx.timer.every(3000, (cx) => this.locate(cx));
    cx.timer.every(3000, (cx) => this.checkEditor(cx));
    // omp may be showing a dialog in its terminal (a question, an approval, a command's input box); the chat mirrors it.
    // Only the box at the bottom of omp's screen counts, so finished ones in its history don't come back.
    cx.timer.every(1500, (cx) => { if (this.terminal) this.prompt.refresh(cx, this.terminal); });
    cx.timer.every(1200, (cx) => { if (this.btw.open) { this.btw.tick(cx, shared(NOW)?.file, this.terminal); cx.notify(); } });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.input.focus();
        if (c === "btw") { this.btw.tick(cx, shared(NOW)?.file, this.terminal); this.btw.toggle(cx); }
        if (c === "commands") this.openCommands(cx);
      }
    });
    cx.timer.every(4000, (cx) => cx.spawn(async () => {
      const live = await countAgents(shared(NOW)?.file);
      if (live && JSON.stringify(live) !== JSON.stringify(shared(LIVE))) setShared(LIVE, live);
    }));
    // Herdr sends "focus" when a popup over the chat closes; the keyboard goes back to the composer.
    cx.spawn(async (cx) => {
      await defaultModel().catch(() => null);
      this.publish();
      const list = await modelList().catch(() => null);
      cx.notify();
      if (list) await checkModels(list);
    });
    cx.timer.every(10000, (cx) => { if (agents().some((a) => a.address === this.terminal && a.status === "working")) cx.notify(); });
  }

  // Words the conversation already uses (names, tools, jargon) are never autocorrected.
  words() {
    const f = this.feed;
    const key = `${f?.terminal}:${f?.blocks.length}`;
    if (this.vocab.key !== key) {
      const all = (f?.blocks ?? []).map((b) => b.text ?? b.calls?.map((c) => c.intent).join(" ") ?? "").join(" ");
      this.vocab = { key, words: new Set(all.toLowerCase().match(/[\p{L}']+/gu) ?? []) };
    }
    return this.vocab.words;
  }

  // The next chat fades and rises in. Each switch draws a new scroll element (new id), so it starts hidden
  // instead of transitioning out of the old chat's fully visible state.
  enter(cx) {
    this.gen++;
    this.entering = true;
    cx.timer.after(32, (cx) => { this.entering = false; cx.notify(); });
  }

  // Each agent keeps its own unsent draft.
  retarget(terminal, cx) {
    if (terminal === this.terminal) return;
    this.composer.clearGhost();
    if (this.terminal) this.drafts.set(this.terminal, this.input.value());
    this.terminal = terminal;
    this.composer.quiet = true;
    this.input.set_value(this.drafts.get(terminal) ?? "");
    this.composer.quiet = false;
    this.composer.close(cx);
    this.limit = PAGE;
    this.hover = null;
    this.enter(cx);
    if (!terminal) return cx.notify();
    if (!this.feeds.has(terminal)) this.feeds.set(terminal, new Feed(terminal));
    this.publish();
    cx.notify();
    this.toBottom(cx);
    this.locate(cx);
    if (wantedView() === "chat") this.input.focus();
  }

  publish() {
    const f = this.feed;
    if (!f) return;
    const prev = shared(NOW)?.terminal === f.terminal ? shared(NOW) : {};
    const def = cachedDefault() ?? {};
    const now = { terminal: f.terminal, file: f.file, title: f.session.title,
      model: f.session.model ?? prev.model ?? def.model ?? null, effort: f.session.effort ?? prev.effort ?? def.effort ?? null };
    if (JSON.stringify(now) !== JSON.stringify(shared(NOW))) setShared(NOW, now);
  }

  // The session file is whatever .jsonl the agent's process holds open; /new or a restart moves it.
  locate(cx) {
    const feed = this.feed;
    const pid = terminals().find((t) => t.address === feed?.terminal)?.foreground?.pid;
    if (!pid) return;
    cx.spawn(async (cx) => {
      const r = await exec("lsof", ["-p", String(pid), "-Fn"], { timeout: 4000 }).catch(() => null);
      const file = r?.stdout.split("\n").map((l) => l.slice(1)).find((l) => SESSION.test(l)) ?? null;
      if (!file) {
        if (r?.code === 0 && !feed.searched) { feed.searched = true; cx.notify(); }
        return;
      }
      if (file === feed.file) return this.load(cx, feed);
      Object.assign(feed, { file, offset: 0, session: new Session(), blocks: [], loaded: false });
      await this.load(cx, feed);
      this.follow(cx, feed, file);
    });
  }

  follow(cx, feed, file) {
    cx.spawn(async (cx) => {
      while (feed.file === file && this.feeds.get(feed.terminal) === feed) {
        const changed = await watchFolder(file.slice(0, file.lastIndexOf("/"))).catch(() => []);
        if (feed.file === file && changed.length) await this.load(cx, feed);
      }
    });
  }

  // Reads only what was appended since the last read. A change that lands mid-read triggers one more read,
  // so the last step is never left waiting for the next write.
  async load(cx, feed) {
    if (feed.loading) { feed.again = true; return; }
    feed.loading = true;
    do {
      feed.again = false;
      const file = feed.file;
      const r = await exec("sh", [...TAIL, file, String(feed.offset)], { timeout: 20000 }).catch(() => null);
      if (r?.code !== 0 || file !== feed.file) continue;
      const [offset, ...lines] = r.stdout.split("\n");
      if (Number(offset) === feed.offset && feed.loaded) continue;
      feed.offset = Number(offset);
      for (const line of lines) if (line) feed.session.take(JSON.parse(line));
      this.absorb(cx, feed);
    } while (feed.again);
    feed.loading = false;
  }

  absorb(cx, feed) {
    const calls = (blocks) => blocks.flatMap((b) => b.calls ?? []);
    const known = new Set([...feed.blocks.map((b) => b.id), ...calls(feed.blocks).flatMap((c) => [c.id, ...(c.result ? [`r-${c.id}`] : [])])]);
    const before = feed.blocks.length + feed.blocks.reduce((n, b) => n + (b.calls?.length ?? 0), 0);
    // Only a reader following the end gets carried along; scrolling up stops that until they're back at the bottom.
    const stick = !feed.loaded || this.following !== false;
    feed.blocks = feed.session.blocks();
    const users = feed.blocks.filter((b) => b.kind === "user");
    // omp may rewrite whitespace in a pasted message (blank lines come back as " "), so compare the words, not the bytes.
    const words = (s) => s.replace(/\s+/g, " ").trim().slice(0, 2000);
    const sent = (p, u) => words(u.text) === words(p.text) && (u.ts ?? 0) >= p.at - 10000;
    // A sent message takes its pending bubble's place, so it doesn't fade in a second time.
    const replaced = new Set(users.filter((u) => feed.pending.some((p) => sent(p, u))).map((u) => u.id));
    feed.pending = feed.pending.filter((p) => !users.some((u) => sent(p, u)));
    const isCurrent = feed === this.feed;
    if (feed.loaded && isCurrent) {
      const fresh = feed.blocks.flatMap((b) => [b, ...(b.kind === "tools" && known.has(b.id) ? b.calls : [])])
        .filter((x) => !known.has(x.id) && !replaced.has(x.id)).map((x) => x.id);
      this.flash(cx, fresh);
      this.flash(cx, calls(feed.blocks).filter((c) => c.result && known.has(c.id) && !known.has(`r-${c.id}`)).map((c) => `r-${c.id}`));
    }
    feed.loaded = true;
    if (!isCurrent) return;
    this.publish();
    cx.notify();
    const after = feed.blocks.length + feed.blocks.reduce((n, b) => n + (b.calls?.length ?? 0), 0);
    if (after === before) return;
    if (stick) this.toBottom(cx);
    else { this.unseen = true; cx.notify(); }
  }

  flash(cx, ids) {
    flash(this, cx, ids);
  }

  toBottom(cx) {
    const f = this.feed;
    const last = Math.min(f?.blocks.length ?? 0, this.limit) + (f?.pending.length ?? 0) + 1;
    this.unseen = false;
    this.following = true;
    cx.timer.after(30, () => this.scroll.scroll_to_item(last));
  }

  atBottom() {
    const content = this.scroll.content_size().height;
    return content === 0 || this.scroll.offset().y + this.scroll.viewport_size().height >= content - 80;
  }

  // Read after the wheel's scroll has laid out, so the position is the one the reader sees.
  scrolled(cx) {
    cx.timer.after(60, (cx) => {
      this.following = this.atBottom();
      if (this.following && this.unseen) { this.unseen = false; cx.notify(); }
    });
  }

  toggle(id, cx) {
    if (this.open.has(id)) this.open.delete(id);
    else { this.open.add(id); this.flash(cx, [`open-${id}`]); }
    cx.notify();
  }

  hovered(id, on, cx) {
    if (on) this.hover = id;
    else if (this.hover === id) this.hover = null;
    else return;
    cx.notify();
  }

  // The bubble shows at once; it stays marked Sending/Queued until omp writes it to the session.
  // Attachments go first as @-mentions; a mention last would leave omp's file picker open and swallow the Enter.
  send(cx, typed = null, retry = null) {
    this.composer.clearGhost();
    typed ??= this.input.value().trim();
    // /btw goes to the side chat: a side question that never enters the session.
    const btw = !retry && /^\/btw(\s|$)/.exec(typed);
    if (btw) {
      this.input.set_value("");
      this.btw.tick(cx, shared(NOW)?.file, this.terminal);
      return this.btw.ask(cx, typed.slice(4).trim());
    }
    // Commands and shell lines run in omp but never become a user message; each leaves a result line instead.
    if (!retry && /^[/!]/.test(typed) && !this.files.length) {
      this.input.set_value("");
      this.composer.close(cx);
      return this.runCmd(cx, typed);
    }
    const feed = this.feed;
    const files = retry ? [] : this.files;
    const text = retry?.text ?? [...files.map((a) => `@${a.path}`), typed].filter(Boolean).join(" ");
    if (!text || !feed) return;
    const item = retry ?? { id: `p${Date.now()}`, text, at: Date.now() };
    item.failed = null;
    item.stuck = false;
    item.lost = false;
    item.at = Date.now();
    item.queued = agents().find((a) => a.address === feed.terminal)?.status === "working";
    if (!retry) {
      feed.pending.push(item);
      this.flash(cx, [`pend-${item.id}`]);
      this.input.set_value("");
      this.attached.delete(feed.terminal);
    }
    this.composer.close(cx);
    this.drafts.delete(feed.terminal);
    cx.notify();
    this.toBottom(cx);
    cx.spawn(async (cx) => {
      const r = await deliver(feed.terminal, text);
      if (r.error) item.failed = r.error;
      else if (r.stuck) item.stuck = true;
      cx.notify();
    });
  }

  // The command picker: "/" in an empty composer, with the full list open.
  openCommands(cx) {
    this.input.set_value("/");
    this.input.set_selected_range({ start: 1, end: 1 });
    this.input.focus();
    this.composer.typed(cx, { cwd: this.cwd, words: () => this.words() });
  }

  runCmd(cx, text) {
    const feed = this.feed;
    const terminal = this.terminal;
    if (!feed || !terminal) return;
    const note = { id: `n${Date.now()}`, at: Date.now(), cmd: text, running: true };
    feed.notes.push(note);
    this.flash(cx, [`note-${note.id}`]);
    cx.notify();
    this.toBottom(cx);
    cx.spawn(async (cx) => {
      const r = await runCommand(terminal, text);
      note.running = false;
      if (r.error) note.error = r.error;
      else if (r.panel) { note.panel = true; note.lines = ["Opened its panel over the chat."]; openSheet(terminal, text.split(/\s/)[0]); }
      else if (r.dialog) note.lines = ["It's asking something: answer below."];
      else if (r.started) note.lines = ["Started. The agent's work shows below."];
      else note.lines = r.lines.length ? r.lines : ["Done."];
      cx.notify();
      this.checkEditor(cx);
    });
  }

  // What sits in omp's editor right now, and which pending messages it means: stuck there, or never arrived.
  checkEditor(cx) {
    const feed = this.feed;
    if (!feed || checking()) return;
    cx.spawn(async (cx) => {
      const text = await screen(feed.terminal);
      const draft = draftIn(text);
      const modes = parseModes(text);
      if (modes && modes.join() !== (this.modes ?? []).join()) { this.modes = modes; cx.notify(); }
      refreshCatalog(this.cwd).then(() => {});
      if (feed !== this.feed) return;
      const status = agents().find((a) => a.address === feed.terminal)?.status;
      let changed = false;
      for (const p of feed.pending) {
        if (p.failed) continue;
        const stuck = Boolean(draft && holds(draft, p.text));
        const lost = !stuck && Date.now() - p.at > 45000 && status !== "working" && status !== "blocked";
        if (stuck !== p.stuck || lost !== p.lost) { Object.assign(p, { stuck, lost }); changed = true; }
      }
      if (changed) cx.notify();
    });
  }

  // Drops a pending message; if it's stuck in omp's editor, clears it there too so it can't go out later.
  removePending(cx, p) {
    const feed = this.feed;
    if (!feed) return;
    feed.pending = feed.pending.filter((x) => x !== p);
    cx.notify();
    if (p.stuck) cx.spawn(async (cx) => { await discardDraft(feed.terminal, p.text); this.checkEditor(cx); });
  }

  sendNow(cx, p) {
    const terminal = this.terminal;
    Object.assign(p, { stuck: false, lost: false, at: Date.now() });
    cx.notify();
    cx.spawn(async (cx) => { await sendDraft(terminal); this.checkEditor(cx); });
  }
}

const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function centered(el) {
  return h_flex().w_full().justify_center().px(28).child(v_flex().w_full().max_w(WIDTH).child(el));
}

function ghost(t, id, icon, label, go) {
  return stop(h_flex().id(id).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer()
    .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); go(cx); })
    .child(svg(`${IMG}/${icon}.svg`).size(12).flex_none())
    .child(div().font_family(UI).text_size(SIZE.meta).child(label)));
}

function actions(t, state, b, align) {
  const shown = state.hover === b.id;
  return h_flex().h(24).gap(4).items_center().when(align === "end", (el) => el.justify_end())
    .opacity(shown ? 1 : 0).transition("opacity", { duration: 140 })
    .child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).px(4).child(clock(b.ts)))
    .child(ghost(t, `cp-${b.id}`, "copy", "Copy", (cx) => cx.write_to_clipboard(b.text)));
}

// Selectable chat text. While some of it is selected, a click in the chat leaves the keyboard alone so ⌘C copies it.
function prose(state, id, text) {
  return TextView.markdown(id, text).selectable(true)
    .on_selection_change((s) => { if (s?.text) state.selected = id; else if (state.selected === id) state.selected = null; });
}

// A message's @-mentioned files show as thumbnails and chips above its text, as they were attached.
function bubble(t, state, id, text, extra) {
  const { attachments, text: rest } = splitMentions(text);
  // The column bounds the bubble's width, so long text wraps inside it instead of growing it past the chat's edge.
  return v_flex().w_full().max_w(560).items_end().gap(6)
    .when(attachments.length > 0, (el) => el.child(thumbnails(t, attachments, 120)))
    .when(Boolean(rest), (el) => el.child(extra(div().max_w_full().px(14).py(9).rounded(18).bg(t.raised).text_size(SIZE.body + 1).text_color(t.foreground)
      .child(prose(state, id, rest)))));
}

function userBubble(t, b, state) {
  return v_flex().id(`u-${b.id}`).w_full().items_end().gap(2)
    .on_hover((on, cx) => state.hovered(b.id, on, cx))
    .child(bubble(t, state, `chat-${b.id}`, b.text, (el) => el))
    .child(actions(t, state, b, "end"));
}

// "Queued" only for a message sent while omp was busy with an earlier one; that's when it waits its turn.
function pendingBubble(t, p, state) {
  const queued = p.queued && !p.failed && !p.stuck && !p.lost;
  const problem = p.failed || p.stuck || p.lost;
  const label = p.failed ? `Not sent · ${p.failed}`
    : p.stuck ? "Stuck in omp's editor: it was never sent"
    : p.lost ? "omp is idle and this never showed up in the session"
    : queued ? "Queued · omp reads it after the current step" : "Sending…";
  const old = Date.now() - (p.at ?? 0) > 10000;
  return v_flex().w_full().items_end().gap(4)
    .child(bubble(t, state, `pend-${p.id}`, p.text, (el) => el.border(1).border_color(problem ? (p.failed ? RED : t.blocked) : "#00000000")
      .when(!problem, (el) => el.loop("opacity", { from: 0.55, to: 0.85, period: 1600 }))))
    .child(h_flex().gap(6).items_center().px(4).max_w(560)
      .child(queued ? svg(`${IMG}/list.svg`).size(11).text_color(t.blocked) : div())
      .child(div().min_w(0).truncate().font_family(UI).text_size(SIZE.meta).text_color(p.failed ? RED : problem || queued ? t.blocked : t.dim).child(label))
      .when(Boolean(p.stuck), (el) => el.child(ghost(t, `now-${p.id}`, "arrow-up", "Send now", (cx) => state.sendNow(cx, p))))
      .when(Boolean(p.failed || p.lost), (el) => el.child(ghost(t, `retry-${p.id}`, "arrow-up", "Retry", (cx) => state.send(cx, null, p))))
      .when(problem || old, (el) => el.child(ghost(t, `rm-${p.id}`, "xmark", "Remove", (cx) => state.removePending(cx, p)))));
}

function reply(t, b, state) {
  return v_flex().id(`a-${b.id}`).w_full().gap(2)
    .on_hover((on, cx) => state.hovered(b.id, on, cx))
    .child(div().w_full().font_family(UI).text_size(SIZE.body + 1).line_height(1.6).text_color(t.foreground)
      .child(richText(t, state, `chat-${b.id}`, b.text, (id, md) => prose(state, id, md))))
    .child(actions(t, state, b, "start"));
}

function disclosure(t, id, open, label, state) {
  return h_flex().id(`chat-tg-${id}`).gap(6).items_center().cursor_pointer()
    .text_color(t.dim).hover((s) => s.text_color(t.muted))
    .on_click((_e, cx) => state.toggle(id, cx))
    .child(svg(`${IMG}/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none())
    .child(div().font_family(UI).font_weight(500).text_size(SIZE.meta + 1).child(label));
}

function thinking(t, b, state) {
  const open = state.open.has(b.id);
  return v_flex().gap(6)
    .child(disclosure(t, b.id, open, "Thought", state))
    .when(open, (el) => el.child(appear(div().pl(16).border_l(2).border_color(t.border).text_size(SIZE.body).text_color(t.muted)
      .child(prose(state, `chat-${b.id}`, b.text)), `open-${b.id}`, state, 4)));
}

const TOOL_ICON = [
  [/^(bash|eval|exec|shell|ps)/, "terminal"], [/^(read|view)/, "file"], [/edit|write|patch/, "pencil"],
  [/grep|glob|find|search|lsp|ast/, "search"], [/web|fetch|browser/, "globe"], [/task|agent/, "sparkle"], [/todo/, "list"],
];
const toolIcon = (name) => TOOL_ICON.find(([re]) => re.test(name ?? ""))?.[1] ?? "chevron-right";

// Spinner and check are separate elements, so the finished mark fades in where the spinner was.
function callMark(t, c, live, state) {
  if (!c.result) return live ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
    : div().size(12).flex_none();
  return appear(svg(`${IMG}/${c.result.error ? "xmark" : "check"}.svg`).size(12).text_color(c.result.error ? RED : t.done),
    `r-${c.id}`, state, 0).w(12).flex_none();
}

function call(t, c, state, live) {
  const open = state.open.has(c.id);
  return appear(v_flex()
    .child(h_flex().id(`chat-call-${c.id}`).h(CALL_ROW).px(10).gap(8).items_center().cursor_pointer().rounded(6).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => state.toggle(c.id, cx))
      .child(svg(`${IMG}/${toolIcon(c.name)}.svg`).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.body - 0.5).text_color(t.muted).child(c.intent || c.detail.split("\n")[0]))
      .child(div().flex_none().font_family(MONO).text_size(SIZE.meta - 0.5).text_color(t.dim).child(c.name))
      .child(callMark(t, c, live, state)))
    .when(open, (el) => el.child(appear(v_flex().mx(10).mb(8).p(10).gap(8).rounded(8).bg(t.background)
      .font_family(MONO).text_size(SIZE.meta).text_color(t.muted)
      .child(div().child(c.detail))
      .when(Boolean(c.result?.text), (el) => el.child(div().pt(8).border_t(1).border_color(t.border)
        .text_color(c.result.error ? RED : t.dim).child(c.result.text))), `open-${c.id}`, state, 4))), c.id, state, 6);
}

// A run of tool calls reads as one "Worked for …" line once it's done; while it runs, its latest steps show.
function tools(t, b, state, live) {
  const open = state.open.has(b.id) || live;
  const failed = b.calls.filter((c) => c.result?.error).length;
  const steps = `${b.calls.length} step${b.calls.length === 1 ? "" : "s"}`;
  const head = live ? `Working · ${steps}` : `Worked for ${duration((b.end ?? b.start) - b.start)} · ${steps}`;
  const shown = state.open.has(b.id) ? b.calls : b.calls.slice(-6);
  return v_flex().w_full().gap(2)
    .child(h_flex().id(`grp-${b.id}`).h(26).gap(8).items_center().cursor_pointer()
      .text_color(t.dim).hover((s) => s.text_color(t.muted))
      .on_click((_e, cx) => state.toggle(b.id, cx))
      .child(svg(`${IMG}/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none())
      .child(div().font_family(UI).font_weight(500).text_size(SIZE.meta + 1).child(head))
      .when(failed > 0, (el) => el.child(div().font_family(UI).text_size(SIZE.meta).text_color(RED).child(`${failed} failed`))))
    .child(callList(t, b, state, live, open, shown));
}

// The list keeps a fixed height while every row is one line, so opening and closing it slides instead of jumping.
function callList(t, b, state, live, open, shown) {
  const more = shown.length < b.calls.length;
  const fixed = !shown.some((c) => state.open.has(c.id));
  const height = 10 + shown.length * CALL_ROW + (more ? 26 : 0);
  return v_flex().id(`calls-${b.id}`).w_full().p(4).rounded(12).border(1).bg(t.surface).overflow_hidden()
    .border_color(open ? t.border : "#00000000")
    .when(fixed || !open, (el) => el.h(open ? height : 0).transition("height", { duration: 260, easing: "ease-out" }))
    .opacity(open ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
    .when(more, (el) => el.child(h_flex().h(26).px(10).items_center()
      .child(disclosure(t, b.id, false, `${b.calls.length - shown.length} earlier`, state))))
    .children(shown.map((c) => call(t, c, state, live)));
}

function note(t, b) {
  return h_flex().w_full().gap(10).items_center()
    .child(div().flex_1().h(1).bg(t.border))
    .child(div().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(b.text))
    .child(div().flex_1().h(1).bg(t.border));
}

function block(t, b, state, live) {
  switch (b.kind) {
    case "user": return userBubble(t, b, state);
    case "text": return reply(t, b, state);
    case "thinking": return thinking(t, b, state);
    case "tools": return tools(t, b, state, live);
    default: return note(t, b);
  }
}

// The shown chat's agent, so key commands (`clear.models`, `clear.handoff`, `clear.effort`) and buttons open the same dialogs.
export function openModels(mode) {
  const now = shared(NOW);
  if (!now?.terminal || now.terminal !== chatTarget()?.terminal) return;
  openOverlay({ mod: "clear", kind: "dialog", width: 460, height: 540, props: { role: "models", mode, ...now } });
}

export function openEffort() {
  const now = shared(NOW);
  if (!now?.terminal || now.terminal !== chatTarget()?.terminal) return;
  openOverlay({ mod: "clear", kind: "popup", width: 190, height: 220, props: { role: "effort", ...now } });
}

function pillButton(t, id, label, tip, go, icon) {
  return stop(h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(13).cursor_pointer()
    .font_family(UI).font_weight(500).text_size(SIZE.meta + 0.5).text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); go(cx); })
    .when(Boolean(icon), (el) => el.child(svg(`${IMG}/${icon}.svg`).size(13).flex_none()))
    .when(Boolean(label), (el) => el.child(label)));
}

function effortPill(t, effort) {
  const color = EFFORT[effort] ?? t.muted;
  return stop(h_flex().id("chat-effort").h(24).px(10).gap(6).items_center().rounded(12).cursor_pointer()
    .bg(color + "1f").hover((s) => s.bg(color + "33")).tooltip("Reasoning effort")
    .font_family(UI).font_weight(600).text_size(SIZE.meta + 0.5).text_color(color)
    .on_click((_e, cx) => { cx.stop_propagation(); openEffort(); })
    .child(dot(color, 7)).child(`${effort ?? "effort"}  ▾`));
}

function modelPill(t, selector) {
  const p = provider(selector?.split("/")[0]);
  const color = p.color ?? t.muted;
  const name = cachedModel(selector)?.name ?? selector?.split("/").pop() ?? "Model";
  return stop(h_flex().id("chat-model").h(26).px(10).gap(6).items_center().rounded(13).cursor_pointer()
    .font_family(UI).font_weight(500).text_size(SIZE.meta + 0.5).text_color(t.foreground)
    .hover((s) => s.bg(color + "26")).tooltip(`${p.name || "Model"} · change model or provider`)
    .on_click((_e, cx) => { cx.stop_propagation(); openModels("switch"); })
    .when(Boolean(p.icon), (el) => el.child(svg(`${IMG}/${p.icon}.svg`).size(13).flex_none().text_color(color)))
    .child(`${name}  ▾`));
}

// Something arrived while you were reading further up; the chat stays where you are until you ask for it.
function latestPill(t, state) {
  return stop(h_flex().id("chat-latest").h(28).px(12).gap(6).items_center().rounded(14).cursor_pointer()
    .bg(t.surface).border(1).border_color(t.border).shadow_md().hover((s) => s.bg(t.raised))
    .font_family(UI).font_weight(500).text_size(SIZE.meta + 0.5).text_color(t.foreground)
    .on_click((_e, cx) => { cx.stop_propagation(); state.toBottom(cx); cx.notify(); })
    .child(svg(`${IMG}/chevron-down.svg`).size(11).flex_none().text_color(t.working))
    .child("New activity below"));
}

// Shown while this session's subagents run; it opens the Agents panel, where they are listed with what they're doing.
function agentsPill(t) {
  const live = shared(LIVE);
  const running = live?.file && live.file === shared(NOW)?.file ? live.running : 0;
  if (!running) return div();
  return stop(h_flex().id("chat-agents-live").h(26).px(10).gap(6).items_center().rounded(13).cursor_pointer()
    .bg(t.working + "1f").hover((s) => s.bg(t.working + "33")).tooltip("See what they're doing")
    .font_family(UI).font_weight(600).text_size(SIZE.meta + 0.5).text_color(t.working)
    .on_click((_e, cx) => { cx.stop_propagation(); showAgents(cx); })
    .child(statusMark("working"))
    .child(`${running} agent${running === 1 ? "" : "s"} running`));
}

function topBar(t, state, target, title) {
  const space = spaces().find((s) => s.tabs.some((tab) => tab.id === target.tab));
  const all = tabAgents(target.tab);
  const { emoji, tag, text } = parseTitle(title || target.title);
  const openIn = () => openOverlay({ mod: "clear", kind: "popup", width: 240, height: 260,
    props: { role: "openin", agent: target.terminal, folder: target.cwd } });
  const drawer = (cx) => cx.spawn(async () => { await openDrawer(target.terminal, target.cwd); });
  return h_flex().h(46).flex_none().pl(16).pr(8).gap(10).items_center().border_b(1).border_color(t.border)
    .child(div().size(26).flex_none().flex().items_center().justify_center().rounded(7).bg(t.raised).text_size(14)
      .child(emoji ?? "π"))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().min_w(0).truncate().font_family(UI).font_weight(600).text_size(SIZE.body).text_color(t.foreground).child(text || "New session"))
        .when(Boolean(tag), (el) => el.child(div().flex_none().h(18).px(6).flex().items_center().rounded(5).bg(t.hover)
          .font_family(MONO).font_weight(600).text_size(SIZE.meta - 1.5).text_color(t.muted).child(tag))))
      .child(h_flex().gap(6).items_center().min_w(0).font_family(UI).text_size(SIZE.meta).text_color(t.dim)
        .child(dot(space ? hue(space.id) : t.dim, 6))
        .child(div().flex_none().child(space?.name ?? ""))
        .when(Boolean(target.branch), (el) => el.child(div().child("·")).child(div().min_w(0).truncate().font_family(MONO).child(target.branch)))))
    .when(all.length > 1, (el) => el.child(div().flex_none().child(segmented("chat-agents",
      all.map((p, i) => [p.terminal, parseTitle(p.title).text.slice(0, 16) || `Agent ${i + 1}`]), target.terminal,
      (terminal) => setView("chat", terminal)))))
    .child(pillButton(t, "chat-drawer", null, "Terminal in this folder", drawer, "terminal"))
    .child(pillButton(t, "chat-openin", "Open in  ▾", short(target.cwd), openIn, "external"))
    .child(agentsPill(t))
    .child(pillButton(t, "chat-btw", state.btw.open ? "Close side chat" : "Side chat", "Ask a side question (/btw) without adding it to the session",
      (cx) => { state.btw.tick(cx, shared(NOW)?.file, state.terminal); state.btw.toggle(cx); }, "wave"))
    .child(pillButton(t, "chat-handoff", "Hand off", "Summarize this session and continue it on another model", () => openModels("handoff")))
    .child(viewSwitch("chat-view", "chat", target.terminal));
}

// How full the model's context window is after the last reply, like omp's status line; green, then orange, then red.
function contextMeter(t, session, selector, terminal) {
  const used = session?.context;
  if (!used) return div();
  const size = cachedModel(selector)?.contextWindow;
  const pct = size ? Math.min(100, Math.round((used / size) * 100)) : null;
  const color = pct == null ? t.muted : pct >= 80 ? RED : pct >= 50 ? t.blocked : t.done;
  return stop(h_flex().id("chat-context").h(24).px(10).gap(7).items_center().rounded(12).bg(t.hover).cursor_pointer()
    .hover((s) => s.bg(t.selected)).tooltip("What's in the context")
    .on_mouse_up("left", (e, cx) => { cx.stop_propagation(); openContext(e, session, size, terminal); })
    .child(div().w(36).h(4).flex_none().rounded(2).bg(t.input).overflow_hidden()
      .child(div().h_full().w(pct == null ? 0 : Math.max(2, (36 * pct) / 100)).rounded(2).bg(color).transition("width", { duration: 400, easing: "ease-out" })))
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta + 0.5).text_color(color).child(pct == null ? tokens(used) : `${pct}%`))
    .when(Boolean(size), (el) => el.child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(`${tokens(used)} / ${tokens(size)}`))));
}

function composer(t, state, agent) {
  const working = agent?.status === "working";
  const round = (id, icon, bg, fg, tip, go) => stop(div().id(id).size(30).flex_none().flex().items_center().justify_center()
    .rounded(15).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.85)).tooltip(tip)
    .on_click((_e, cx) => go(cx)).child(svg(`${IMG}/${icon}.svg`).size(14)));
  const feed = state.feed;
  const now = shared(NOW)?.terminal === state.terminal ? shared(NOW) : {};
  const selector = now.model || feed?.session.model;
  const keys = { up: -1, down: 1 };
  const options = optionBar(t, state.cwd, state.input.value(), (cx, v) => { state.input.set_value(v); state.input.focus(); cx.notify(); },
    (cx, cmd) => { state.input.set_value(""); state.runCmd(cx, cmd); });
  return v_flex().id("chat-composer").w_full().p(10).gap(8).rounded(18).bg(t.surface).border(1).border_color(t.border).shadow_md()
    .key_context("ClearComposer")
    .on_action(TAB_ACTION, (_e, cx) => { const c = state.composer; if (c.accept(cx) || c.acceptGhost(cx)) cx.stop_propagation(); })
    .on_drop((e, cx) => state.attach(cx, () => Promise.all(e.paths.map(adopt))))
    .on_key_down((e, cx) => {
      const c = state.composer;
      const handled = e.key in keys ? c.move(keys[e.key], cx)
        : e.key === "tab" ? c.accept(cx) || c.acceptGhost(cx)
        : e.key === "escape" ? c.close(cx) || c.clearGhost() : false;
      if (handled) return cx.stop_propagation();
      c.keyDown(e);
    })
    .when(state.files.length > 0, (el) => el.child(div().px(4).pt(4).child(attachmentRow(t, state.files, (i, cx) => state.detach(i, cx)))))
    .when(Boolean(options), (el) => el.child(options))
    .child(div().px(4).font_family(UI).text_size(SIZE.body + 1).text_color(t.foreground).child(Textarea.new(state.input).w_full()
      .token((ctx) => tokenView(t, ctx))
      .on_token_click((span, cx) => state.composer.pickFix(cx, span))))
    .child(h_flex().gap(6).items_center()
      .child(round("chat-attach", "plus", t.raised, t.foreground, "Attach files or images (or paste / drop them)",
        (cx) => state.attach(cx, async () => Promise.all((await chooseFiles()).map(adopt)))))
      .child(commandButton(t, (cx) => state.openCommands(cx)))
      .child(modelPill(t, selector))
      .child(effortPill(t, now.effort || feed?.session.effort))
      .child(contextMeter(t, feed?.session, selector, state.terminal))
      .child(modeChips(t, state.modes ?? [], (cx, cmd) => state.runCmd(cx, cmd)))
      .child(div().flex_1())
      .when(working, (el) => el.child(div().pr(4).font_family(UI).text_size(SIZE.meta).text_color(t.dim).child("↩ queues a message")))
      .when(working, (el) => el.child(round("chat-stop", "stop", t.raised, t.foreground, "Stop", () => hc(["interrupt", state.terminal]))))
      .child(round("chat-send", "arrow-up", t.accent, t.accent_foreground, "Send (↩) · newline ⇧↩", (cx) => state.send(cx))));
}

function banner(t) {
  return h_flex().w_full().px(14).py(10).gap(10).items_center().rounded(12).bg(t.blocked + "1f")
    .child(div().flex_1().font_family(UI).font_weight(500).text_size(SIZE.body).text_color(t.blocked)
      .child("omp is asking something only the terminal can answer."))
    .child(button("chat-answer", "Open terminal", "Answer it in the terminal", () => setView("main"), "primary"));
}

function hero(t, target, loading) {
  const space = spaces().find((s) => s.tabs.some((tab) => tab.id === target.tab));
  return v_flex().w_full().pt(96).gap(10).items_center()
    .child(div().size(52).flex().items_center().justify_center().rounded(14).bg(t.raised).text_size(26).child("π")
      .loop("opacity", { from: 0.7, to: 1, period: 2400 }))
    .child(div().font_family(UI).font_weight(600).text_size(22).text_color(t.foreground)
      .child(loading ? "Loading conversation…" : `What should we build in ${space?.name ?? "this project"}?`))
    .child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(short(target.cwd)));
}

function workingRow(t, since) {
  return h_flex().gap(8).items_center().h(24)
    .child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900))
    .child(div().font_family(UI).font_weight(500).text_size(SIZE.body).text_color(t.muted).loop("opacity", { from: 0.45, to: 1, period: 1400 })
      .child("Thinking"))
    .when(Boolean(since), (el) => el.child(div().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(elapsed(since))));
}

export function chatView(state, cx) {
  const t = theme();
  const target = chatTarget();
  // A tab that briefly reports no agent keeps its chat; only a real change of agent retargets.
  if (target && target.terminal !== state.terminal) cx.timer.after(0, (cx) => state.retarget(target.terminal, cx));
  if (!target) return v_flex().size_full().bg(t.background).items_center().justify_center()
    .child(div().font_family(UI).text_size(SIZE.body).text_color(t.dim).child("No omp agent in this tab."));
  const switching = target.terminal !== state.terminal;
  const entering = switching || state.entering;
  const feed = state.feeds.get(target.terminal) ?? null;
  const agent = agents().find((a) => a.address === target.terminal);
  const tab = spaces().flatMap((s) => s.tabs).find((x) => x.id === target.tab);
  const blocks = feed?.blocks ?? [];
  const shown = blocks.slice(-state.limit);
  const earlier = blocks.length - shown.length;
  const live = agent?.status === "working";
  const last = shown[shown.length - 1];
  const pending = feed?.pending ?? [];
  state.cwd = target.cwd;
  const working = live && !(last?.kind === "tools" && last.calls.some((c) => !c.result));
  // omp is waiting on its ask form: the newest call is an ask with no answer yet.
  const lastCall = last?.kind === "tools" ? last.calls[last.calls.length - 1] : null;
  const asking = lastCall?.name === "ask" && !lastCall.result && lastCall.form ? lastCall : null;
  const askable = asking && !parseForm(asking.form).unsupported ? asking : null;
  // A dialog omp has open is mirrored, except while its panel is open in the sheet: that's the same screen.
  const sheet = shared(SHEET)?.terminal === state.terminal;
  const mirrored = !sheet && state.prompt.prompt ? state.prompt.prompt : null;
  if (working && !state.wasWorking && !checking()) state.flash(cx, ["working"]);
  state.wasWorking = working;
  // The composer takes the keyboard whenever the chat comes (back) into view, so typing always lands there.
  const view = wantedView();
  const active = window()?.active ?? false;
  const token = shared(REFOCUS) ?? null;
  if (!checking() && view === "chat" && ((active && !state.wasActive) || state.lastView !== "chat" || token !== state.token)) {
    cx.timer.after(0, () => state.input.focus());
  }
  Object.assign(state, { wasActive: active, lastView: view, token });
  return v_flex().size_full().bg(t.background).rounded(14).border(1).border_color(t.border).shadow_lg().overflow_hidden()
    .child(topBar(t, state, target, feed?.session.title))
    .child(h_flex().flex_1().min_h(0).child(v_flex().flex_1().min_w(0).h_full()
    .child(v_flex().id(`chat-scroll-${switching ? state.gen + 1 : state.gen}`).flex_1().min_h(0).overflow_y_scrollbar()
      .track_scroll(state.scroll).pt(20).pb(16).gap(16)
      .on_mouse_up("left", (_e, cx) => cx.timer.after(80, () => { if (!state.selected) state.input.focus(); }))
      .on_scroll_wheel((_e, cx) => state.scrolled(cx))
      .relative().top(entering ? 22 : 0).opacity(entering ? 0 : 1)
      .transition("opacity", { duration: 320, easing: "ease-out" }).transition("top", { duration: 420, easing: "ease-out" })
      .child(centered(earlier > 0
        ? h_flex().justify_center().child(button("chat-more", `Show ${Math.min(PAGE, earlier)} earlier`, `${earlier} more above`,
          (cx) => { state.limit += PAGE; cx.notify(); }))
        : !shown.length && !pending.length ? hero(t, target, !feed?.loaded && !feed?.searched) : div()))
      // Your own messages rise further, as if sent up from the composer. Command results sit where they ran.
      .children(interleave(shown, feed?.notes ?? []).map((r) => (r.note
        ? centered(appear(commandNote(t, r.note, (cx, cmd) => state.runCmd(cx, cmd)), `note-${r.note.id}`, state, 12))
        : centered(appear(block(t, r.block, state, live && r.block === last), r.block.id, state, r.block.kind === "user" ? 22 : 12)))))
      .children(pending.map((p) => centered(appear(pendingBubble(t, p, state), `pend-${p.id}`, state, 22))))
      .child(centered(working ? appear(workingRow(t, tab?.working_since), "working", state, 6) : div())))
    .child(v_flex().flex_none().pb(16).pt(4).gap(8)
      // omp's ask forms get the native card; any other dialog it shows (approvals, choices, console input) is mirrored.
      .when(Boolean(askable), (el) => el.child(centered(askCard(t, state.ask, asking, state.terminal, () => setView("main"), refocus))))
      .when(!askable && Boolean(mirrored), (el) => el.child(centered(promptCard(t, state.prompt, state.terminal, () => setView("main")))))
      .when(!askable && !mirrored && agent?.status === "blocked", (el) => el.child(centered(banner(t))))
      .when(Boolean(state.unseen), (el) => el.child(centered(h_flex().justify_center().child(latestPill(t, state)))))
      .child(centered(suggestions(t, state.composer)))
      .child(centered(composer(t, state, agent)))))
      .when(state.btw.open, (el) => el.child(btwPanel(t, state.btw, (cx) => state.btw.toggle(cx, false)))));
}
