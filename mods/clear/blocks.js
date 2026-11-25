import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { UI, SIZE, IMG } from "./kit.js";

// Quotes and code blocks are what you hand on: a draft to send, a command to run. Each gets its own copy button.
const FENCE = /^ {0,3}(```|~~~)/;
const QUOTE = /^ {0,3}>/;

// Pasted into a chat or a mail, the reader sees text, not markdown syntax.
const plain = (md) => md
  .replace(/^#{1,6}\s+/gm, "")
  .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => a ?? b)
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  .trim();

export function segments(md) {
  const out = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      const mark = lines[i].trim().slice(0, 3);
      const block = [lines[i]];
      while (++i < lines.length) { block.push(lines[i]); if (lines[i].trim().startsWith(mark)) break; }
      const closed = block.length > 1 && block[block.length - 1].trim().startsWith(mark);
      out.push({ kind: "code", md: block.join("\n"), copy: block.slice(1, closed ? -1 : undefined).join("\n") });
      continue;
    }
    const kind = QUOTE.test(lines[i]) ? "quote" : "md";
    const last = out[out.length - 1];
    if (last?.kind === kind) last.md += `\n${lines[i]}`; else out.push({ kind, md: lines[i] });
  }
  return out.filter((s) => s.md.trim()).map((s) => (s.kind === "quote" ? { ...s, copy: plain(s.md.replace(/^ {0,3}> ?/gm, "")) } : s));
}

function copyable(t, holder, id, s, view) {
  const done = holder.copied === id;
  return div().relative().w_full()
    .child(view(id, s.md))
    .child(h_flex().id(`cp-${id}`).absolute().top(s.kind === "code" ? 6 : 0).right(6).h(24).px(8).gap(5).items_center()
      .rounded(6).cursor_pointer().bg(t.surface).border(1).border_color(t.border)
      .text_color(done ? t.done : t.muted).hover((x) => x.text_color(t.foreground))
      .tooltip(s.kind === "code" ? "Copy the code" : "Copy this text, without markdown")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(s.copy);
        holder.copied = id;
        cx.notify();
        cx.timer.after(1500, (cx) => { if (holder.copied === id) { holder.copied = null; cx.notify(); } });
      })
      .child(svg(`${IMG}/${done ? "check" : "copy"}.svg`).size(12).flex_none())
      .child(div().font_family(UI).font_weight(500).text_size(SIZE.meta).child(done ? "Copied" : "Copy")));
}

// A reply's markdown, split so each quote and code block carries its own copy button. `view` draws one piece.
export function richText(t, holder, id, md, view, gap = 12) {
  const parts = segments(md);
  if (parts.every((s) => s.kind === "md")) return view(id, md);
  return v_flex().w_full().gap(gap).children(parts.map((s, i) => (s.kind === "md" ? view(`${id}-${i}`, s.md) : copyable(t, holder, `${id}-${i}`, s, view))));
}
