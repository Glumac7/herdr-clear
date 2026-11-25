import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, shared, setShared, checking, run } from "herdr";
import { UI, MONO, SIZE, RED, PURPLE, statusMark, button, narrow, toggleSide } from "./kit.js";

// Running and total subagents of the session on screen, published by the chat for the tab and the header pill.
export const LIVE = "clear.subagents.live";
export const STACK = "right-body";
const STALE_MIN = 30;

// A subagent's transcript is <session>/<id>.jsonl; its own subagents and advisor sit in <session>/<id>/.
const dirOf = (file) => file?.replace(/\.jsonl$/, "") ?? null;

// Subagent transcripts open with their parentSession; other files there (changes.jsonl) aren't agents.
// Running: one omp hasn't reported back on, without a session_exit, written to in the last half hour.
const COUNT = `ended=$(grep '"customType":"async-result"' "$1" | grep -o '"agentId":"[^"]*"' | cut -d'"' -f4 | sort -u);
  n=0; r=0; for f in "$2"/*.jsonl; do head -c 3000 "$f" 2>/dev/null | grep -q '"parentSession"' || continue; n=$((n+1));
  printf '%s\\n' "$ended" | grep -qxF "$(basename "$f" .jsonl)" && continue;
  if ! tail -c 4000 "$f" | grep -q '"session_exit"' && [ -n "$(find "$f" -mmin -${STALE_MIN})" ]; then r=$((r+1)); fi; done; echo "$n $r"`;

export async function countAgents(file) {
  const dir = dirOf(file);
  if (!dir) return null;
  const r = await exec("sh", ["-c", COUNT, "sh", file, dir], { timeout: 8000 }).catch(() => null);
  const [total, running] = (r?.stdout.trim() ?? "").split(" ").map(Number);
  return Number.isFinite(total) ? { file, total, running } : null;
}

// Each task call: its intent, the agents it started (ids in order) and, from the async results, how each ended.
const BATCHES = `if .type == "message" and .message.role == "assistant" then
    (.timestamp as $ts | .message.content[]? | select(.type == "toolCall" and .name == "task") | {k: "call", id, i: (.arguments.i // ""), ts: $ts})
  elif .type == "message" and .message.role == "toolResult" and .message.toolName == "task" then
    {k: "res", id: .message.toolCallId, agents: [.message.details.progress[]? | {id, agent, assignment: ((.assignment // .task // "") | .[0:800])}]}
  elif .type == "custom_message" and .customType == "async-result" then
    {k: "job", jobs: [.details.jobs[]? | select(.type == "task") | {id: .agentId, status, durationMs,
      verdict: (.schema.data.verdict? // null), summary: ((.schema.data.summary? // null) | if type == "string" then .[0:800] else null end)}]}
  else empty end`;

// One summary per transcript: model, spend, tool calls, what it did last and its last words.
const SUMMARY = `find "$1" -name '*.jsonl' -print0 | xargs -0 /usr/bin/jq -c -n '
  reduce inputs as $e ({}; input_filename as $f | .[$f] |= ((. // {fresh: 0, cached: 0, cost: 0, tools: 0, requests: 0}) as $a |
    if $e.type == "session" then $a + {start: $e.timestamp}
    elif $e.type == "model_change" then $a + {model: $e.model}
    elif $e.type == "message" and $e.message.role == "assistant" then
      ($e.message.usage // {}) as $u | [$e.message.content[]? | select(.type == "toolCall")] as $calls |
      ([$e.message.content[]? | select(.type == "text") | .text] | join("\\n")) as $text |
      $a + {fresh: ($a.fresh + ($u.input // 0) + ($u.output // 0) + ($u.cacheWrite // 0)), cached: ($a.cached + ($u.cacheRead // 0)),
        cost: ($a.cost + ($u.cost.total // 0)), requests: ($a.requests + 1), tools: ($a.tools + ($calls | length)),
        last: (($calls | map(.intent // .arguments.i // .name) | last) // $a.last), end: $e.timestamp,
        text: (if ($text | length) > 0 then $text[0:600] else $a.text end)}
    elif $e.type == "custom" and $e.customType == "session_exit" then $a + {exit: ($e.data.kind // "normal"), end: $e.timestamp}
    else $a end))'`;

function assemble(file, batchLines, summaries) {
  const dir = dirOf(file);
  const calls = [];
  const byCall = new Map();
  const jobs = {};
  for (const line of batchLines) {
    if (line.k === "call") { const c = { id: line.id, intent: line.i, ts: Date.parse(line.ts) || null, agents: [] }; calls.push(c); byCall.set(line.id, c); }
    if (line.k === "res") byCall.get(line.id)?.agents.push(...line.agents);
    if (line.k === "job") for (const j of line.jobs) jobs[j.id] = j;
  }
  const info = (path) => summaries[path] ?? null;
  const advisorCost = (id) => Object.entries(summaries)
    .filter(([p]) => p.startsWith(`${dir}/${id}/__advisor`)).reduce((n, [, s]) => n + s.cost, 0);
  const children = (id) => Object.keys(summaries)
    .filter((p) => p.startsWith(`${dir}/${id}/`) && !p.includes("/__advisor") && p.split("/").length === `${dir}/${id}/x`.split("/").length)
    .map((p) => ({ id: p.slice(p.lastIndexOf("/") + 1, -6), agent: null, assignment: "", path: p }));
  const agent = (a, path = `${dir}/${a.id}.jsonl`) => {
    const s = info(path);
    const job = jobs[a.id];
    const ended = job?.status ?? (s?.exit ? "completed" : null);
    const stale = s?.end && Date.now() - Date.parse(s.end) > STALE_MIN * 60000;
    const status = ended === "completed" ? "done" : ended ? "failed" : !s ? "queued" : stale ? "stopped" : "running";
    return {
      ...a, ...s, status, verdict: job?.verdict ?? null, summary: job?.summary ?? s?.text ?? null,
      durationMs: job?.durationMs ?? (s?.start && s?.end ? Date.parse(s.end) - Date.parse(s.start) : null),
      advisor: advisorCost(a.id), report: /^[\w.-]+$/.test(a.id) ? `${dir}/${a.id}.md` : null,
      children: children(a.id).map((c) => agent(c, c.path)),
    };
  };
  return calls.filter((c) => c.agents.length).map((c) => ({ ...c, agents: c.agents.map((a) => agent(a)) })).reverse();
}

export class SubagentsState {
  constructor() {
    this.file = null;
    this.batches = null;
    this.error = null;
    this.open = null;
    this.loading = false;
    this.at = 0;
  }

  start(cx) {
    if (checking()) return;
    this.tick(cx);
    cx.timer.every(3000, (cx) => this.tick(cx));
  }

  // Reloads at once for a new session, every few seconds while agents run, else twice a minute.
  tick(cx) {
    const file = shared("clear.chat.now")?.file ?? null;
    const live = shared(LIVE);
    const running = live?.file === file && live.running > 0;
    if (file !== this.file) { this.file = file; this.batches = null; this.open = null; }
    if (!file || this.loading) return cx.notify();
    if (this.batches && !running && Date.now() - this.at < 30000) return;
    this.load(cx, file);
  }

  load(cx, file) {
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [b, s] = await Promise.all([
          exec("/usr/bin/jq", ["-c", BATCHES, file], { timeout: 20000 }),
          exec("sh", ["-c", SUMMARY, "sh", dirOf(file)], { timeout: 20000 }),
        ]);
        const lines = b.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const summaries = Object.assign({}, ...s.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
        if (file === this.file) { this.batches = assemble(file, lines, summaries); this.error = null; }
      } catch (e) {
        this.error = String(e?.message ?? e).slice(0, 160);
      }
      this.at = Date.now();
      this.loading = false;
      cx.notify();
    });
  }
}

export function showAgents(cx) {
  if (narrow("right")) toggleSide(cx, "right");
  run("layout.select", { stack: STACK, child: "subagents" });
}

const money = (n) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const count = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));
function span(ms) {
  if (ms == null) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function verdictChip(t, v) {
  if (!v) return null;
  const color = v === "PASS" ? t.done : v === "FIX_REQUIRED" ? RED : t.blocked;
  const label = v === "PASS" ? "Pass" : v === "FIX_REQUIRED" ? "Fix required" : v === "HUMAN_REVIEW_REQUIRED" ? "Human review" : v;
  return div().flex_none().h(18).px(6).flex().items_center().rounded(5).bg(color + "22")
    .font_family(UI).font_weight(600).text_size(SIZE.meta - 1).text_color(color).child(label);
}

function mark(t, status) {
  if (status === "running") return statusMark("working");
  if (status === "done") return statusMark("done");
  if (status === "failed") return div().size(8).flex_none().rounded(4).bg(RED);
  return statusMark("idle");
}

const model = (m) => (m ?? "").split("/").pop();

function meta(a) {
  if (a.status === "running") return [a.last ?? "Starting…", span(Date.now() - Date.parse(a.start))].filter(Boolean).join(" · ");
  if (a.status === "queued") return "Waiting to start";
  return [model(a.model), span(a.durationMs), a.cost ? money(a.cost + a.advisor) : null, a.tools ? `${a.tools} tools` : null,
    a.status === "stopped" ? "stopped without finishing" : a.status === "failed" ? "failed" : null].filter(Boolean).join(" · ");
}

function agentRow(t, state, a, depth = 0) {
  const open = state.open === a.id;
  const running = a.status === "running";
  return v_flex().id(`sa-${a.id}`).ml(depth * 14).px(10).py(8).gap(3).rounded(8).cursor_pointer()
    .when(open, (el) => el.bg(t.selected)).when(!open, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => { state.open = open ? null : a.id; cx.notify(); })
    .child(h_flex().gap(8).items_center()
      .child(div().w(12).flex_none().flex().justify_center().child(mark(t, a.status)))
      .child(div().min_w(0).truncate().font_family(UI).font_weight(500).text_size(SIZE.body - 0.5).text_color(t.foreground).child(a.id))
      .when(Boolean(a.agent), (el) => el.child(div().flex_none().font_family(MONO).text_size(SIZE.meta - 0.5).text_color(t.dim).child(a.agent)))
      .child(div().flex_1())
      .when(Boolean(a.verdict), (el) => el.child(verdictChip(t, a.verdict))))
    .child(div().pl(20).min_w(0).font_family(UI).text_size(SIZE.meta).text_color(running ? t.working : t.dim)
      .when(!open, (el) => el.truncate()).child(meta(a)))
    .when(open, (el) => el.child(details(t, state, a)));
}

function block(t, label, text) {
  return v_flex().gap(3)
    .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted).child(label))
    .child(div().font_family(UI).text_size(SIZE.meta + 0.5).line_height(1.45).text_color(t.foreground).child(text));
}

function details(t, state, a) {
  const spend = a.requests ? `${count(a.fresh)} tokens · ${count(a.cached)} cached · ${a.requests} requests` : null;
  return v_flex().pl(20).pt(6).gap(10).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .when(Boolean(a.assignment), (el) => el.child(block(t, "Assignment", a.assignment.replace(/^Complete assignment thoroughly:\s*/i, ""))))
    .when(Boolean(a.summary), (el) => el.child(block(t, a.status === "running" ? "Latest" : "Result", a.summary)))
    .when(Boolean(spend), (el) => el.child(div().font_family(MONO).text_size(SIZE.meta - 0.5).text_color(t.dim)
      .child(`${spend}${a.advisor ? ` · advisor ${money(a.advisor)}` : ""}`)))
    .when(a.children.length > 0, (el) => el.child(v_flex().gap(1).children(a.children.map((c) => agentRow(t, state, c, 0)))))
    .child(h_flex().gap(6)
      .when(Boolean(a.report) && a.status !== "running" && a.status !== "queued", (el) => el.child(button(`sa-md-${a.id}`, "Open report", "The agent's final output",
        () => exec("open", [a.report]))))
      .child(button(`sa-id-${a.id}`, "Copy ID", "For agent:// links or follow-up instructions", (cx) => cx.write_to_clipboard(a.id))));
}

function batch(t, state, b) {
  const cost = b.agents.reduce((n, a) => n + (a.cost ?? 0) + a.advisor, 0);
  return v_flex().gap(1)
    .child(h_flex().px(10).pt(12).pb(2).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(600).text_size(SIZE.meta + 0.5).text_color(t.muted).child(b.intent || "Delegated work"))
      .child(div().flex_none().font_family(UI).text_size(SIZE.meta).text_color(t.dim)
        .child([cost ? money(cost) : null, b.ts ? ago(b.ts) : null].filter(Boolean).join(" · "))))
    .children(b.agents.map((a) => agentRow(t, state, a)));
}

function totals(t, batches) {
  const all = batches.flatMap((b) => b.agents);
  const running = all.filter((a) => a.status === "running").length;
  const cost = all.reduce((n, a) => n + (a.cost ?? 0) + a.advisor, 0);
  const fresh = all.reduce((n, a) => n + (a.fresh ?? 0), 0);
  const time = all.reduce((n, a) => n + (a.durationMs ?? 0), 0);
  return v_flex().px(20).pt(14).pb(6).gap(3)
    .child(h_flex().gap(8).items_center()
      .child(div().font_family(UI).font_weight(600).text_size(SIZE.heading).text_color(t.foreground)
        .child(`${all.length} subagent${all.length === 1 ? "" : "s"}`))
      .when(running > 0, (el) => el.child(h_flex().h(20).px(8).gap(6).items_center().rounded(10).bg(t.working + "22")
        .child(statusMark("working"))
        .child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.working).child(`${running} running`)))))
    .child(div().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.muted)
      .child(`${money(cost)} · ${count(fresh)} tokens · ${span(time)} of agent time`));
}

const note = (t, text) => div().px(20).py(14).font_family(UI).text_size(SIZE.body - 0.5).line_height(1.45).text_color(t.dim).child(text);

export function subagentsView(state) {
  const t = theme();
  const batches = state.batches;
  if (!state.file) return v_flex().size_full().bg(t.chrome).child(note(t, "Open an omp chat to see the subagents it started."));
  return v_flex().size_full().bg(t.chrome)
    .when(Boolean(state.error), (el) => el.child(note(t, `Couldn't read this session's agents: ${state.error}`)))
    .when(!batches && !state.error, (el) => el.child(note(t, "Reading this session's agents…")))
    .when(Boolean(batches) && !batches.length, (el) => el.child(note(t, "No subagents in this session yet. When omp delegates work, each agent shows up here with what it's doing and what it costs.")))
    .when(Boolean(batches?.length), (el) => el.child(totals(t, batches))
      .child(v_flex().id("sa-list").flex_1().min_h(0).overflow_y_scroll().px(4).pb(12)
        .children(batches.map((b) => batch(t, state, b)))));
}
