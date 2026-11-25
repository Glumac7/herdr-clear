import { div, svg } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { exec, appHome, shared, setShared } from "herdr";
import { UI, MONO, SIZE, RED, IMG } from "./kit.js";
import { catalog, ORDER } from "./cmds.js";
import { model } from "./predict.js";

const IGNORE = "clear.spell.ignore";
const GHOST = "ghost";
const LIMIT = 8;
const FILES_TTL = 60000;

// Slash commands and @file mentions while typing, next-word ghost text after the cursor (Tab takes it), and finished
// words macOS thinks are misspelled turn into underlined tokens; nothing is changed unless the person picks a suggestion.
export class Composer {
  constructor(input) {
    this.input = input;
    this.items = [];
    this.index = 0;
    this.range = null;
    this.files = new Map();
    this.quiet = false;
    this.typos = 0;
    this.guesses = new Map();
    this.scroll = ScrollHandle.new();
    this.onPick = null;
  }

  get open() {
    return this.items.length > 0;
  }

  // ctx: { cwd, words: () => Set of words already in this conversation }
  typed(cx, ctx) {
    if (this.quiet || this.unchanged()) return;
    model.warm();
    if (this.tabbed(cx)) return;
    if (this.repair()) return this.snapshot();
    const { text } = this.plain();
    const cursor = this.input.selected_range().end;
    this.suggest(cx, text, cursor, ctx);
    this.flag(cx, text, cursor, ctx);
    this.snapshot();
    this.syncGhost();
  }

  // Taken without the ghost, so the ghost coming, going or changing never looks like an edit.
  snapshot() {
    this.prev = this.plain();
  }

  // `change` arrives after our own edits return, so `quiet` misses it; one that changed nothing the person wrote is ours.
  unchanged() {
    if (!this.prev) return false;
    const now = this.plain();
    const ids = (spans) => spans.map((s) => s.token.id).join();
    return now.text === this.prev.text && ids(now.tokens) === ids(this.prev.tokens);
  }

  // What the person wrote: the text and tokens without the ghost.
  plain() {
    const { text, tokens } = this.input.content();
    const g = tokens.find((s) => s.token.id === GHOST);
    return {
      text: g ? text.slice(0, g.range.start) + text.slice(g.range.end) : text,
      tokens: tokens.filter((s) => s !== g),
    };
  }

  ghost() {
    return this.input.content().tokens.find((s) => s.token.id === GHOST) ?? null;
  }

  // The ghost is a dim token right after the cursor. It's only touched when the suggestion actually changes:
  // every removal and re-insert re-lays the text, which is what made wrapped messages flicker.
  syncGhost() {
    const sel = this.input.selected_range();
    const { text } = this.plain();
    const atEnd = sel.start === sel.end && (text[sel.end] ?? "\n") === "\n";
    const want = !this.open && atEnd ? model.predict(text.slice(0, sel.end)) : null;
    const g = this.ghost();
    if (g && g.token.text === want && g.range.start === sel.end) return;
    this.clearGhost();
    if (!want || /[\u0000-\u001f]/.test(want)) return;
    this.quiet = true;
    this.input.replace_range_with_token({ start: sel.end, end: sel.end }, { id: GHOST, text: want, label: want });
    this.input.set_selected_range(sel);
    this.quiet = false;
  }

  clearGhost() {
    const g = this.ghost();
    if (!g) return false;
    const sel = this.input.selected_range();
    const len = g.range.end - g.range.start;
    const shift = (p) => (p > g.range.start ? Math.max(g.range.start, p - len) : p);
    this.quiet = true;
    this.input.set_selected_range(g.range);
    this.input.replace("");
    this.input.set_selected_range({ start: shift(sel.start), end: shift(sel.end) });
    this.quiet = false;
    return true;
  }

  // Runs before the textarea handles the key. `change` only arrives after the next frame is drawn, so without this
  // that frame shows the new letter in front of the old ghost ("pull r" + "request"). A letter that continues the
  // ghost trims it instead; any other key drops it first.
  keyDown(e) {
    const g = this.ghost();
    if (!g || ["tab", "up", "down", "escape", "shift", "control", "alt", "platform", "function"].includes(e.key)) return;
    const ch = e.key_char;
    const plainKey = ch && ch.length === 1 && !e.modifiers?.platform && !e.modifiers?.control;
    if (plainKey && g.token.text[0]?.toLowerCase() === ch.toLowerCase() && g.token.text.length > 1) {
      const sel = this.input.selected_range();
      const rest = g.token.text.slice(1);
      this.quiet = true;
      this.input.set_selected_range(g.range);
      this.input.replace("");
      this.input.replace_range_with_token({ start: g.range.start, end: g.range.start }, { id: GHOST, text: rest, label: rest });
      this.input.set_selected_range(sel);
      this.quiet = false;
      return;
    }
    this.clearGhost();
  }

  // Tab takes the ghost word plus a space, and the next word is offered right away.
  acceptGhost(cx) {
    const g = this.ghost();
    if (!g) return false;
    const word = `${g.token.text} `;
    this.edit(g.range, word, g.range.start + word.length);
    this.syncGhost();
    cx.notify();
    return true;
  }

  // The textarea turns Tab into indentation (a tab or a run of spaces) right before the ghost. If that's all that
  // changed since the last edit, undo it and take the ghost instead. A single space is a typed space, not Tab.
  tabbed(cx) {
    const g = this.ghost();
    const prev = this.prev?.text;
    if (!g || prev == null) return false;
    const { text: clean } = this.plain();
    const at = g.range.start - (clean.length - prev.length);
    const indent = clean.slice(at, g.range.start);
    if (!(indent === "\t" || /^ {2,}$/.test(indent)) || clean.slice(0, at) + clean.slice(g.range.start) !== prev) return false;
    this.edit({ start: at, end: g.range.start }, "", at);
    return this.acceptGhost(cx);
  }

  // The underline is only a mark, but the textarea treats a token as one character, so Backspace takes the
  // whole word. When a flagged word vanished in one step, put it back minus its last letter, as plain text.
  repair() {
    const prev = this.prev;
    if (!prev) return false;
    const now = this.plain();
    const gone = prev.tokens.find((s) => !now.tokens.some((n) => n.token.id === s.token.id));
    if (!gone) return false;
    const { start, end } = gone.range;
    if (now.text !== prev.text.slice(0, start) + prev.text.slice(end)) return false;
    const kept = gone.token.text.slice(0, -1);
    this.edit({ start, end: start }, kept, start + kept.length);
    return true;
  }

  suggest(cx, text, cursor, ctx) {
    const before = text.slice(0, cursor);
    const token = /(^|\s)([/@][^\s]*)$/.exec(before);
    let items = [];
    if (token?.[2].startsWith("/") && token.index === 0 && !token[1]) {
      // A bare "/" lists every command by group; typing narrows it and brings in skills and plugin commands.
      const q = token[2].slice(1).toLowerCase();
      const all = catalog(ctx.cwd);
      const rank = (c) => c.rank ?? ORDER.indexOf(c.group) * 1000 + 999;
      const hits = q ? [...all.filter((c) => c.name.startsWith(q)), ...all.filter((c) => !c.name.startsWith(q)
        && (c.name.includes(q) || c.desc.toLowerCase().includes(q)))].slice(0, 40)
        : all.filter((c) => c.group !== "Skills").sort((a, b) => rank(a) - rank(b));
      items = hits.map((c) => ({ kind: "cmd", key: c.name, insert: `/${c.name} `, label: `/${c.name}`,
        hint: c.hint, desc: c.desc, tui: c.panel, group: q ? null : c.group, cmd: c }));
    } else if (token?.[2].startsWith("@")) {
      const list = this.fileList(cx, ctx.cwd);
      items = rankFiles(list, token[2].slice(1).toLowerCase()).slice(0, LIMIT)
        .map((path) => ({ kind: "file", key: path, insert: `@${path} `, label: path.split("/").pop(), desc: path }));
    }
    this.range = items.length ? { start: cursor - token[2].length, end: cursor } : null;
    const changed = items.map((i) => i.key).join() !== this.items.map((i) => i.key).join();
    this.items = items;
    if (changed) { this.index = 0; cx.notify(); }
  }

  fileList(cx, cwd) {
    const cached = this.files.get(cwd);
    if (cached && (cached.loading || Date.now() - cached.at < FILES_TTL)) return cached.list;
    const entry = { at: Date.now(), list: cached?.list ?? [], loading: true };
    this.files.set(cwd, entry);
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'git ls-files -co --exclude-standard 2>/dev/null || find . -maxdepth 6 -type f -not -path "*/node_modules/*" -not -path "*/.git/*" | sed "s|^\\./||"', "sh"],
        { cwd, timeout: 8000 }).catch(() => null);
      entry.list = (r?.stdout ?? "").split("\n").filter(Boolean).slice(0, 50000);
      entry.loading = false;
      entry.at = Date.now();
      this.suggest(cx, this.input.value(), this.input.selected_range().end, { cwd });
    });
    return entry.list;
  }

  move(by, cx) {
    if (!this.open) return false;
    this.index = (this.index + by + this.items.length) % this.items.length;
    // Group headers sit between rows in the list, so the selected row's position counts the headers above it.
    const heads = this.items.slice(0, this.index + 1).filter((it, i, a) => it.group && it.group !== a[i - 1]?.group).length;
    this.scroll.scroll_to_item(this.index + heads);
    cx.notify();
    return true;
  }

  close(cx) {
    if (!this.open) return false;
    this.items = [];
    cx.notify();
    return true;
  }

  // Enter can reach the textarea as a newline before submit fires; that newline belongs to the pick, not the message.
  accept(cx, item = this.items[this.index]) {
    if (item?.kind === "fix" || item?.kind === "ignore") return this.resolve(cx, item);
    if (!item || !this.range) return false;
    const text = this.input.value();
    const cursor = this.input.selected_range().end;
    const end = text[cursor - 1] === "\n" && cursor - 1 >= this.range.end ? cursor : this.range.end;
    this.edit({ start: this.range.start, end }, item.insert);
    this.items = [];
    cx.notify();
    if (item.kind === "cmd") this.onPick?.(cx, item.cmd);
    return true;
  }

  edit(range, replacement, cursor = null) {
    this.quiet = true;
    this.input.set_selected_range(range);
    this.input.replace(replacement);
    if (cursor != null) this.input.set_selected_range({ start: cursor, end: cursor });
    this.quiet = false;
    this.snapshot();
  }

  flag(cx, text, cursor, ctx) {
    if (cursor < 4 || !/[\s.,!?;:]/.test(text[cursor - 1])) return;
    const head = text.slice(0, cursor - 1);
    const m = /(^|[\s(“"'])([\p{L}][\p{Ll}']{2,})$/u.exec(head);
    if (!m) return;
    const word = m[2];
    const start = head.length - word.length;
    const lower = word.toLowerCase();
    if (!/[aeiouyäöü]/.test(lower) || (head.match(/`/g) ?? []).length % 2 || /^\s*\//.test(text)) return;
    if ((shared(IGNORE) ?? []).includes(lower) || ctx.words().has(lower)) return;
    cx.spawn(async (cx) => {
      // The word alone: an unknown word earlier in the sentence (a tool name, say) throws off macOS's language guess.
      const r = await exec(`${appHome()}/mods/clear/bin/spell`, [word], { timeout: 3000 }).catch(() => null);
      if (r?.code !== 0 || !r.stdout) return;
      if (this.input.value().slice(start, start + word.length) !== word) return;
      const id = `typo-${++this.typos}`;
      this.guesses.set(id, r.stdout.trim().split("\t").filter(Boolean));
      const cursor = this.input.selected_range();
      this.quiet = true;
      this.input.replace_range_with_token({ start, end: start + word.length }, { id, text: word, label: word });
      this.input.set_selected_range(cursor);
      this.quiet = false;
      this.snapshot();
      cx.notify();
    });
  }

  // A click on an underlined word turns it back into plain, editable text and offers macOS's suggestions
  // and "Ignore", in the same list as commands and files.
  pickFix(cx, clicked) {
    if (clicked.token.id === GHOST) return this.acceptGhost(cx);
    this.clearGhost();
    const span = this.input.content().tokens.find((s) => s.token.id === clicked.token.id);
    if (!span) return;
    const guesses = this.guesses.get(span.token.id) ?? [];
    const cursor = this.input.selected_range();
    this.edit(span.range, span.token.text, cursor.end);
    this.range = { start: span.range.start, end: span.range.end };
    this.items = [
      ...guesses.map((g) => ({ kind: "fix", key: `fix-${g}`, label: g, insert: g, desc: "" })),
      { kind: "ignore", key: "ignore", label: `Ignore “${span.token.text}”`, insert: span.token.text, desc: "Never flag this word again" },
    ];
    this.index = 0;
    cx.notify();
  }

  resolve(cx, item) {
    this.edit(this.range, item.insert);
    if (item.kind === "ignore") setShared(IGNORE, [...new Set([...(shared(IGNORE) ?? []), item.insert.toLowerCase()])].slice(-500));
    this.items = [];
    cx.notify();
    return true;
  }
}

function rankFiles(list, q) {
  if (!q) return list.slice(0, LIMIT);
  const scored = [];
  for (const path of list) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const score = base.startsWith(q) ? 0 : base.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score, path.length, path]);
    if (scored.length > 400) break;
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((s) => s[2]);
}

export function suggestions(t, composer) {
  if (!composer.open) return div();
  const cmds = composer.items[0]?.kind === "cmd";
  const head = (g) => div().id(`sug-h-${g}`).px(10).pt(8).pb(3).font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.dim).child(g);
  return v_flex().id("sug-list").w_full().max_h(cmds ? 340 : 280).overflow_y_scroll().track_scroll(composer.scroll)
    .p(4).gap(1).rounded(12).bg(t.popover).border(1).border_color(t.border).shadow_lg()
    .children(composer.items.flatMap((item, i) => {
      const on = i === composer.index;
      const row = h_flex().id(`sug-${item.key}`).h(30).px(10).gap(10).items_center().rounded(8).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { composer.accept(cx, item); composer.input.focus(); })
        .child(item.kind === "file" ? svg(`${IMG}/file.svg`).size(13).flex_none().text_color(t.dim) : div())
        .child(div().flex_none().font_family(item.kind === "cmd" ? MONO : UI).font_weight(600).text_size(SIZE.body - 0.5)
          .text_color(t.foreground).child(item.label))
        .when(Boolean(item.hint), (el) => el.child(div().flex_none().max_w(180).truncate().font_family(MONO).text_size(SIZE.meta).text_color(t.dim).child(item.hint)))
        .child(div().flex_1().min_w(0).truncate().font_family(item.kind === "file" ? MONO : UI).text_size(SIZE.meta + 0.5)
          .text_color(t.muted).child(item.desc))
        .when(Boolean(item.tui), (el) => el.child(div().flex_none().h(18).px(6).flex().items_center().rounded(5).bg(t.hover)
          .font_family(UI).font_weight(500).text_size(SIZE.meta - 1).text_color(t.muted).child("opens panel")));
      const group = item.group && item.group !== composer.items[i - 1]?.group;
      return group ? [head(item.group), row] : [row];
    }));
}

// A flagged word keeps its normal look with a red wavy line, drawn from small tiles, under it; the ghost word is dim.
export function tokenView(t, ctx) {
  const base = div().relative().h(ctx.line_height).flex().items_center().cursor_pointer().font_family(UI).text_size(SIZE.body + 1);
  if (ctx.token.id === GHOST) return base.text_color(t.dim).child(ctx.token.text);
  return base.text_color(t.foreground)
    .child(ctx.token.text)
    .child(h_flex().absolute().left(0).right(0).bottom(0).h(3).overflow_hidden().text_color(RED)
      .children(Array.from({ length: ctx.token.text.length * 2 }, () => svg(`${IMG}/wave.svg`).w(6).h(3).flex_none())));
}
