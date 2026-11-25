// An omp session file (.jsonl, a tree of entries linked by parentId) turned into chat blocks.

// Prints the new byte offset, then each complete line after `offset`, slimmed by jq
// (images dropped, long text cut) so multi-megabyte sessions stay cheap to follow.
export const TAIL = [
  "-c",
  `/usr/bin/perl -e 'open(F,"<",$ARGV[0]) or exit 1; seek(F,$ARGV[1],0); local $/; my $d=<F> // ""; my $i=rindex($d,"\\n"); print $ARGV[1]+($i<0?0:$i+1),"\\n"; print substr($d,0,$i+1) if $i>=0;' "$1" "$2" | /usr/bin/jq -c '
    def cut($n): (. // "") | .[0:$n];
    if type == "number" then . else
    if .type == "message" then {type, id, parentId, timestamp, message: (.message | {role, toolCallId, isError,
      usage: (.usage | if . then {totalTokens, cost: .cost.total, prompt: ((.input // 0) + (.cacheRead // 0) + (.cacheWrite // 0))} else null end),
      size: (if (.content | type) == "string" then {text: (.content | length)} else reduce (.content[]?) as $c ({};
        if $c.type == "text" then .text += ($c.text | length)
        elif $c.type == "thinking" then .thinking += ($c.thinking | length)
        elif $c.type == "toolCall" then .tools += (($c.arguments // {}) | tojson | length)
        else . end) end),
      content: (if (.content | type) == "string" then [{type: "text", text: (.content | cut(6000))}] else [.content[]? |
        if .type == "text" then {type, text: (.text | cut(6000))}
        elif .type == "thinking" then {type, thinking: (.thinking | cut(6000))}
        elif .type == "toolCall" then {type, id, name, intent, arguments: ((.arguments // {}) | with_entries(select(.value | type == "string") | .value |= .[0:1500])),
          form: (if .name == "ask" then ((.arguments.html // "") | .[0:20000]) else null end)}
        else empty end] end)})}
    elif .type == "custom_message" then {type, id, parentId, display, chars: (.content | tostring | length),
      content: (if (.content | type) == "string" then .content else ([.content[]? | select(.type == "text") | .text] | join("\\n")) end | cut(300))}
    else {type, id, parentId, timestamp, model, thinkingLevel, title, firstKeptEntryId, tokensAfter, summaryChars: (.summary | length)} end end'`,
  "tail",
];

function text(content) {
  return (Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }])
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
}

function detail(name, args = {}) {
  if (args.command) return `$ ${args.command}`;
  if (args.path) return [args.path, args.pattern].filter(Boolean).join("  ");
  if (args.pattern) return args.pattern;
  if (typeof args.input === "string") return args.input;
  const json = JSON.stringify(args, null, 2);
  return json === "{}" ? name : json;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "\n…" : s);

// System notices arrive wrapped in tags; the first plain line says what happened.
const firstLine = (s) => (s.split("\n").map((l) => l.trim()).find((l) => l && !/^<[^>]+>$/.test(l)) ?? "").slice(0, 90);

const CHARS_PER_TOKEN = 4;
const charsOf = (path) => path.reduce((n, p) => n + Object.values(p.size ?? {}).reduce((a, b) => a + b, 0), 0);

export class Session {
  constructor() {
    this.byId = new Map();
    this.leaf = null;
    this.model = null;
    this.effort = null;
    this.title = null;
    this.context = null;
    this.cost = 0;
    this.base = null;
  }

  take(e) {
    if (e.type === "model_change" && e.model) this.model = e.model;
    if (e.type === "thinking_level_change" && e.thinkingLevel) this.effort = e.thinkingLevel;
    if ((e.type === "title" || e.type === "title_change") && e.title) this.title = e.title;
    if (!e.id) return;
    this.leaf = e.id;
    const m = e.type === "message" ? e.message : null;
    const keep = { id: e.id, parentId: e.parentId ?? null, ts: Date.parse(e.timestamp) || null };
    const s = m?.size ?? {};
    if (m?.role === "user") keep.size = { user: s.text ?? 0 };
    else if (m?.role === "assistant") keep.size = { text: s.text ?? 0, thinking: s.thinking ?? 0, tools: s.tools ?? 0 };
    else if (m?.role === "toolResult") keep.size = { results: s.text ?? 0 };
    else if (m?.role === "developer") keep.size = { notes: s.text ?? 0 };
    else if (e.type === "custom_message") keep.size = { notes: e.chars ?? 0 };
    else if (e.type === "compaction") {
      Object.assign(keep, { size: { summary: e.summaryChars ?? 0 }, compaction: true, kept: e.firstKeptEntryId });
      this.context = e.tokensAfter ?? this.context;
    }
    // Each reply's total is the whole prompt it was given plus its output: how full the context window is now.
    if (m?.role === "assistant" && m.usage) {
      this.context = m.usage.totalTokens ?? this.context;
      this.cost += m.usage.cost ?? 0;
      // The first prompt is the system prompt and tool schemas plus the messages before it; those we can size.
      if (this.base == null && m.usage.prompt) this.base = Math.max(0, m.usage.prompt - charsOf(this.pathTo(e.parentId)) / CHARS_PER_TOKEN);
    }
    if (m?.role === "user") keep.user = text(m.content);
    else if (m?.role === "assistant") keep.parts = (m.content ?? []).map((c) => c.type === "toolCall"
      ? { type: "tool", id: c.id, name: c.name, intent: c.intent || c.arguments?.i || "", detail: clip(detail(c.name, c.arguments), 1200), form: c.form ?? null }
      : c.type === "text" ? { type: "text", text: c.text ?? "" }
      : c.type === "thinking" ? { type: "thinking", text: c.thinking ?? "" } : null).filter(Boolean);
    else if (m?.role === "toolResult") keep.result = { id: m.toolCallId, error: Boolean(m.isError), text: clip(text(m.content), 3000) };
    else if (e.type === "custom_message" && e.display) keep.note = firstLine(String(e.content ?? ""));
    else if (e.type === "compaction") keep.note = "Earlier conversation was compacted.";
    this.byId.set(e.id, keep);
  }

  pathTo(leaf) {
    const path = [];
    for (let id = leaf; id && this.byId.has(id); id = this.byId.get(id).parentId) path.push(this.byId.get(id));
    return path.reverse();
  }

  // Tokens per kind in the context now. Only the total is measured; the split is estimated from each kind's size.
  breakdown() {
    const path = this.pathTo(this.leaf);
    let from = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      if (!path[i].compaction) continue;
      const k = path.findIndex((p) => p.id === path[i].kept);
      from = k >= 0 && k < i ? k : i;
      break;
    }
    const chars = {};
    for (const p of path.slice(from)) for (const [k, v] of Object.entries(p.size ?? {})) chars[k] = (chars[k] ?? 0) + v;
    const total = this.context ?? 0;
    const system = this.base == null ? null : Math.min(total, Math.round(this.base));
    const rest = total - (system ?? 0);
    const sum = Object.values(chars).reduce((a, b) => a + b, 0);
    const parts = Object.fromEntries(Object.entries(chars).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round((rest * v) / sum)]));
    return { total, system, parts };
  }

  // The visible conversation is the branch ending at the newest entry; thinking shows only before a reply.
  blocks() {
    const path = this.pathTo(this.leaf);
    const blocks = [];
    const calls = new Map();
    for (const e of path) {
      if (e.user) blocks.push({ kind: "user", id: e.id, text: e.user, ts: e.ts });
      else if (e.note) blocks.push({ kind: "note", id: e.id, text: e.note });
      else if (e.result) {
        const c = calls.get(e.result.id);
        if (c) { c.result = e.result; c.group.end = e.ts ?? c.group.end; }
      }
      else if (e.parts) {
        const said = e.parts.some((p) => p.type === "text" && p.text.trim());
        e.parts.forEach((p, i) => {
          const id = `${e.id}-${i}`;
          if (p.type === "thinking" && said && p.text.trim()) blocks.push({ kind: "thinking", id, text: p.text });
          else if (p.type === "text" && p.text.trim()) blocks.push({ kind: "text", id, text: p.text, ts: e.ts });
          else if (p.type === "tool") {
            const last = blocks[blocks.length - 1];
            const group = last?.kind === "tools" ? last : { kind: "tools", id, calls: [], start: e.ts, end: e.ts };
            if (group !== last) blocks.push(group);
            const call = { ...p, result: null, group };
            calls.set(p.id, call);
            group.calls.push(call);
          }
        });
      }
    }
    return blocks;
  }
}
