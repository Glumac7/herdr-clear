import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, run, panes, agents, theme, checking, notify, openOverlay, shared, setShared, focused } from "herdr";
import { UI, MONO, SIZE, RED, PURPLE, IMG, hue, dot, avatar, button, segmented, statusMark, iconButton } from "./kit.js";
import { Media } from "./media.js";
import { parseTitle, sessionName } from "./names.js";

const HOST = "https://dbyt01.myjetbrains.com";
const ORG = "durchblicker";
const FIELDS = "idReadable,summary,updated,customFields(name,value(name)),parent(issues(idReadable,summary))";
const QUERY = "for: me #Unresolved sort by: updated desc";
const VIEWS = [
  { id: "doing", label: "In progress", states: ["In Progress", "Refactoring"], tone: "working", state: "In Progress" },
  { id: "verify", label: "To verify", states: ["To Verify"], tone: "done", state: "To Verify" },
  { id: "todo", label: "To do", states: ["Open", "Inbox"], tone: "muted", state: "Open" },
];
const MOVES = [...VIEWS.map((v) => v.state), "Done"];
const VIEW = "clear.tickets.view";
const LOUD = ["Blocked", "Critical", "Show-stopper", "Major"];
export const STARTED = "clear.started";
const TICKET = /\b([A-Z][A-Z0-9]+-\d+)\b/i;
const ID = /^[A-Z][A-Z0-9]+-\d+$/;
const TAG = /^\[([^\]]+)\]\s*/;

function field(issue, name) {
  const v = issue.customFields?.find((f) => f.name === name)?.value;
  return Array.isArray(v) ? v.map((x) => x?.name).filter(Boolean) : v?.name ?? null;
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The token stays in the shell: zsh -i loads it from ~/.zshrc for curl only. URL and body go in as $1/$2, never into the script.
export async function youtrack(path, body) {
  const script = '[ -n "$YOUTRACK_PERMANENT_TOKEN" ] || { echo NO_TOKEN; exit 3; }; '
    + 'url=$1; data=$2; set -- -H "Authorization: Bearer $YOUTRACK_PERMANENT_TOKEN" -H "Accept: application/json"; '
    + '[ -n "$data" ] && set -- "$@" -X POST -H "Content-Type: application/json" --data "$data"; '
    + 'curl -sS --max-time 20 "$@" "$url"';
  const r = await exec("/bin/zsh", ["-ic", script, "zsh", `${HOST}/api/${path}`, body ? JSON.stringify(body) : ""], { timeout: 30000 });
  if (r.stdout.includes("NO_TOKEN")) throw new Error("YOUTRACK_PERMANENT_TOKEN is not set in ~/.zshrc");
  const start = r.stdout.search(/[[{]/);
  const data = start < 0 ? {} : JSON.parse(r.stdout.slice(start));
  if (data?.error) throw new Error(data.error_description ?? data.error);
  return data;
}

// A search per ticket, a few per GraphQL call (one big call times out); kept only where the title or branch names it.
async function pullRequests(ids) {
  const pr = "... on PullRequest { number title url state isDraft headRefName repository { name } author { login avatarUrl(size: 48) } reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }";
  const out = {};
  for (let at = 0; at < ids.length; at += 4) {
    const chunk = ids.slice(at, at + 4);
    const query = `{ ${chunk.map((id, i) => `t${i}: search(query: "org:${ORG} is:pr ${id}", type: ISSUE, first: 10) { nodes { ${pr} } }`).join(" ")} }`;
    const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: 30000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "gh failed");
    const data = JSON.parse(r.stdout).data ?? {};
    chunk.forEach((id, i) => {
      const re = new RegExp(`\\b${id.replace("-", "-?")}\\b`, "i");
      out[id] = (data[`t${i}`]?.nodes ?? []).filter((p) => p?.url && (re.test(p.title) || re.test(p.headRefName)));
    });
  }
  return out;
}

const viewOf = (issue) => VIEWS.find((v) => v.states.includes(field(issue, "State"))) ?? null;
const parentOf = (issue) => issue.parent?.issues?.[0] ?? null;

const untag = (s) => {
  const m = TAG.exec(s ?? "");
  return { tag: m?.[1] ?? null, text: m ? s.slice(m[0].length) : s ?? "" };
};

// "[App] Push: Tap Routing" under parent "[App] Push" reads as an "App" chip and "Tap Routing": the parent says the rest.
function title(issue) {
  const { tag, text } = untag(issue.summary);
  const lead = untag(parentOf(issue)?.summary).text;
  return { tag, text: lead && text.startsWith(`${lead}:`) ? text.slice(lead.length + 1).trim() : text };
}

// A session's ticket: its branch or folder names it, else its title's tag ("IT4604: …").
function ticketOf(a, pane) {
  const hit = TICKET.exec(pane?.branch ?? "") ?? TICKET.exec(pane?.cwd ?? "");
  if (hit) return hit[1].toUpperCase();
  const tag = /^([A-Z][A-Z0-9]*?)-?(\d+)$/.exec(parseTitle(a.title).tag ?? "");
  return tag ? `${tag[1]}-${tag[2]}` : null;
}

// Sessions working on each ticket, by ticket id.
function deployed() {
  const byPane = new Map(panes().map((p) => [p.pane, p]));
  const out = new Map();
  for (const a of agents()) {
    const id = ticketOf(a, byPane.get(a.pane));
    if (id) out.set(id, [...(out.get(id) ?? []), a]);
  }
  return out;
}

// The ticket of the session on screen, if it has one.
function shownTicket() {
  const tab = focused()?.tab;
  const byPane = new Map(panes().map((p) => [p.pane, p]));
  for (const a of agents().filter((x) => x.tab === tab)) {
    const id = ticketOf(a, byPane.get(a.pane));
    if (id) return id;
  }
  return null;
}

export class TrackerState {
  constructor() {
    this.issues = null;
    this.extra = {};
    this.prs = {};
    this.prError = null;
    this.error = null;
    this.busy = false;
    this.at = null;
    this.selected = null;
    this.armed = null;
    this.moving = new Set();
    this.started = shared(STARTED);
    this.media = new Media();
  }

  start(cx) {
    this.search = InputState.new({ placeholder: "Filter tickets" });
    this.search.on("change", (_e, cx) => cx.notify());
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(120000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const data = await youtrack(`issues?$top=200&fields=${encodeURIComponent(FIELDS)}&query=${encodeURIComponent(QUERY)}`);
        if (!Array.isArray(data)) throw new Error("unexpected reply");
        this.issues = data;
        this.extra = {};
        this.error = null;
        this.at = Date.now();
      } catch (e) {
        this.error = String(e?.message ?? e).slice(0, 140);
      }
      cx.notify();
      if (this.issues) {
        try {
          this.prs = await pullRequests(this.issues.map((i) => i.idReadable).filter((id) => ID.test(id)));
          this.prError = null;
        } catch (e) {
          this.prError = String(e?.message ?? e).slice(0, 140);
        }
      }
      this.busy = false;
      cx.notify();
    });
  }

  issue(id) {
    return this.issues?.find((i) => i.idReadable === id) ?? this.extra[id] ?? null;
  }

  // The shown session's ticket may not be assigned to me; it's fetched on its own, once.
  ensure(cx, id) {
    if (!ID.test(id) || !this.issues || this.issue(id) || id in this.extra) return;
    this.extra[id] = null;
    cx.spawn(async (cx) => {
      try {
        this.extra[id] = await youtrack(`issues/${id}?fields=${encodeURIComponent(FIELDS)}`);
        Object.assign(this.prs, await pullRequests([id]));
      } catch {}
      cx.notify();
    });
  }

  move(cx, issue, state) {
    const id = issue.idReadable;
    if (!ID.test(id) || !MOVES.includes(state)) return;
    this.armed = null;
    this.moving.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await youtrack("commands", { query: `State ${state}`, issues: [{ idReadable: id }] });
        const f = issue.customFields?.find((x) => x.name === "State");
        if (f) f.value = { name: state };
        if (state === "Done") { this.issues = this.issues.filter((i) => i.idReadable !== id); this.selected = null; }
        notify({ title: `${id} → ${state}`, body: issue.summary, level: "success", timeout: 4000 });
      } catch (e) {
        notify({ title: `${id} did not move`, body: String(e?.message ?? e), level: "error" });
      }
      this.moving.delete(id);
      cx.notify();
      this.refresh(cx);
    });
  }
}

// One word per PR: the thing you would act on next. Lower rank is more urgent.
function prTone(t, p) {
  if (p.state === "MERGED") return ["Merged", PURPLE, 5];
  if (p.state === "CLOSED") return ["Closed", t.dim, 6];
  if (p.isDraft) return ["Draft", t.dim, 4];
  const ci = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (ci === "FAILURE" || ci === "ERROR") return ["Checks failing", t.blocked, 0];
  if (p.reviewDecision === "CHANGES_REQUESTED") return ["Changes requested", t.blocked, 0];
  if (p.reviewDecision === "APPROVED") return ["Approved", t.done, 2];
  if (ci === "PENDING" || ci === "EXPECTED") return ["Checks running", t.muted, 1];
  return ["In review", t.muted, 1];
}

// "3 PRs · 2 Draft · 1 Approved", coloured by the most urgent one.
function prSummary(t, prs) {
  const tones = prs.map((p) => prTone(t, p)).sort((a, b) => a[2] - b[2]);
  const counts = new Map();
  for (const [word] of tones) counts.set(word, (counts.get(word) ?? 0) + 1);
  const words = [...counts].map(([w, n]) => (prs.length === 1 ? w : `${n} ${w.toLowerCase()}`));
  return h_flex().gap(6).items_center().min_w(0)
    .child(dot(tones[0][1], 6))
    .child(div().min_w(0).truncate().font_family(UI).text_size(SIZE.meta).text_color(t.muted)
      .child(`${prs.length} PR${prs.length === 1 ? "" : "s"} · ${words.join(" · ")}`));
}

function prLine(t, p, media, cx) {
  const [word, color] = prTone(t, p);
  const who = p.author?.login;
  const face = media.get(cx, p.author?.avatarUrl, who ? `gh-${who}.png` : "");
  return h_flex().id(`pr-${p.url}`).h(26).px(6).gap(8).items_center().cursor_pointer().rounded(6)
    .hover((s) => s.bg(t.hover))
    .tooltip(`${p.title}\n${p.headRefName}${who ? `\nby ${who}` : ""}\nOpens on GitHub`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [p.url]); })
    .child(avatar(face, 16, who))
    .child(div().min_w(0).truncate().font_family(MONO).text_size(SIZE.meta).text_color(t.foreground).child(`${p.repository.name}#${p.number}`))
    .child(div().flex_1())
    .child(dot(color, 6))
    .child(div().flex_none().font_family(UI).font_weight(500).text_size(SIZE.meta).text_color(color).child(word));
}

function chip(text, color) {
  return div().flex_none().h(18).px(6).flex().items_center().rounded(5).bg(color + "22")
    .font_family(UI).font_weight(600).text_size(SIZE.meta - 1).text_color(color).child(text);
}

function priority(t, issue) {
  const prio = field(issue, "Priority");
  return LOUD.includes(prio) ? chip(prio, prio === "Major" ? t.muted : RED) : null;
}

// Where the ticket stands, and the control that moves it: one tap per state, Done asks twice.
function stateControl(t, state, issue) {
  const id = issue.idReadable;
  const busy = state.moving.has(id);
  const armed = state.armed === id;
  return h_flex().gap(6).items_center().when(busy, (el) => el.opacity(0.5))
    .child(div().flex_1().child(segmented(`mv-${id}`, VIEWS.map((v) => [v.id, v.label, null, t[v.tone]]), viewOf(issue)?.id,
      (v, cx) => { if (!busy && v !== viewOf(issue)?.id) state.move(cx, issue, VIEWS.find((x) => x.id === v).state); })))
    .child(button(`done-${id}`, armed ? "Confirm" : "Done", armed ? "Click again to resolve it" : "Resolve the ticket",
      (cx) => {
        if (busy) return;
        if (!armed) {
          state.armed = id;
          cx.timer.after(4000, (cx) => { if (state.armed === id) { state.armed = null; cx.notify(); } });
          return cx.notify();
        }
        state.move(cx, issue, "Done");
      }, "danger", armed));
}

function sessionRow(t, a) {
  return h_flex().id(`yt-s-${a.address}`).h(26).px(6).gap(8).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover)).tooltip(`Go to this session in ${a.space_name}`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: a.pane }); })
    .child(div().w(16).flex().justify_center().child(statusMark(a.status ?? "idle")))
    .child(div().flex_1().min_w(0).truncate().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.foreground).child(sessionName(a.title) || a.space_name))
    .child(div().size(6).rounded(3).flex_none().bg(hue(a.space)))
    .child(div().flex_none().max_w(110).truncate().font_family(UI).text_size(SIZE.meta).text_color(t.dim).child(a.space_name));
}

const links = (t, id) => h_flex().gap(2)
  .child(iconButton(`yt-copy-${id}`, "copy", "Copy ticket ID", (cx) => cx.write_to_clipboard(id)))
  .child(iconButton(`yt-open-${id}`, "external", "Open in YouTrack", () => exec("open", [`${HOST}/youtrack/issue/${id}`])));

// Everything about one ticket: its PRs, the sessions on it, where it stands and what to do next.
function details(t, state, issue, crew, cx) {
  const id = issue.idReadable;
  const prs = state.prs[id] ?? [];
  const others = crew.filter((a) => a.tab !== focused()?.tab);
  return v_flex().gap(8)
    .when(prs.length > 0, (el) => el.child(v_flex().gap(1).children(prs.map((p) => prLine(t, p, state.media, cx)))))
    .when(others.length > 0, (el) => el.child(v_flex().gap(1).children(others.map((a) => sessionRow(t, a)))))
    .child(stateControl(t, state, issue))
    .when(!crew.length, (el) => el.child(button(`start-${id}`, "Start a session",
      "Worktree + omp briefed on this ticket and its subtasks; all go In Progress",
      () => openOverlay({ mod: "clear", kind: "dialog", width: 460, height: 440, props: { role: "start", ticket: id, summary: issue.summary } }), "primary")));
}

// The ticket the session on screen works on, opened up at the top.
function current(t, state, id, crew, subtasks, cx) {
  const issue = state.issue(id);
  if (!issue) {
    if (cx && !checking()) cx.timer.after(0, (cx) => state.ensure(cx, id));
    return div();
  }
  const view = viewOf(issue);
  const { tag, text } = title(issue);
  const tone = t[view?.tone ?? "muted"];
  return v_flex().mx(10).mb(10).p(12).gap(10).rounded(10).bg(t.surface).border(1).border_color(t.border).shadow_sm()
    .child(h_flex().gap(8).items_center()
      .child(div().font_family(MONO).font_weight(600).text_size(SIZE.meta).text_color(tone).child(id))
      .child(chip(field(issue, "State") ?? "Unknown", tone))
      .when(Boolean(priority(t, issue)), (el) => el.child(priority(t, issue)))
      .child(div().flex_1())
      .child(links(t, id)))
    .child(v_flex().gap(4)
      .when(Boolean(tag), (el) => el.child(div().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.dim).child(tag)))
      .child(div().font_family(UI).font_weight(600).text_size(SIZE.body).line_height(1.35).text_color(t.foreground).child(text)))
    .child(details(t, state, issue, crew, cx))
    .when(subtasks.length > 0, (el) => el.child(v_flex().mx(-8).pt(8).gap(1).border_t(1).border_color(t.border)
      .child(div().px(10).pb(2).font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted)
        .child(`${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}`))
      .children(subtasks.map((s) => row(t, state, s.issue, s.crew, cx, { parentState: field(issue, "State") })))));
}

function row(t, state, issue, crew, cx, { parentState = null, depth = 0 } = {}) {
  const id = issue.idReadable;
  const open = state.selected === id;
  const prs = state.prs[id] ?? [];
  const { tag, text } = title(issue);
  const lead = crew.find((a) => a.status === "working" || a.status === "blocked") ?? crew[0];
  return v_flex().id(`yt-${id}`).ml(depth * 14).px(10).py(8).gap(4).rounded(8).cursor_pointer()
    .when(open, (el) => el.bg(t.selected))
    .when(!open, (el) => el.hover((s) => s.bg(t.hover)))
    .tooltip(open ? "Click to close" : "Click for PRs, sessions and actions")
    .on_click((_e, cx) => { state.selected = open ? null : id; state.armed = null; cx.notify(); })
    .child(h_flex().gap(8).items_center()
      .child(div().w(12).flex_none().flex().justify_center().child(lead ? statusMark(lead.status ?? "idle") : div()))
      .child(div().flex_none().font_family(MONO).font_weight(600).text_size(SIZE.meta).text_color(open ? t.foreground : t.muted).child(id))
      .when(Boolean(parentState) && field(issue, "State") !== parentState,
        (el) => el.child(chip(field(issue, "State") ?? "?", t[viewOf(issue)?.tone ?? "muted"])))
      .when(Boolean(tag), (el) => el.child(chip(tag, t.muted)))
      .when(Boolean(priority(t, issue)), (el) => el.child(priority(t, issue)))
      .child(div().flex_1())
      .child(div().id(`yt-age-${id}`).flex_none().font_family(MONO).text_size(SIZE.meta).text_color(t.dim)
        .tooltip(`Updated ${ago(issue.updated)} ago`).child(ago(issue.updated))))
    .child(div().pl(20).font_family(UI).text_size(SIZE.body - 0.5).line_height(1.35)
      .text_color(open || lead ? t.foreground : t.muted).when(!open, (el) => el.truncate()).child(text))
    .when(!open && prs.length > 0, (el) => el.child(div().pl(20).child(prSummary(t, prs))))
    .when(open, (el) => el.child(div().pl(14).pt(4).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().justify_end().child(links(t, id)))
      .child(details(t, state, issue, crew, cx))));
}

function toolbar(t, state) {
  const status = state.error ? `Offline: ${state.error}` : state.at ? `Synced ${ago(state.at)} ago` : "Connecting…";
  const prNote = state.prError ? `\nGitHub PRs unavailable: ${state.prError}` : "";
  return h_flex().h(48).flex_none().px(10).gap(6).items_center()
    .child(h_flex().flex_1().h(30).px(8).gap(6).items_center().rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(svg(`${IMG}/search.svg`).size(13).flex_none().text_color(t.dim))
      .child(Input.new(state.search).w_full().text_size(SIZE.body).text_color(t.foreground)))
    .child(div().id("yt-refresh").size(30).flex_none().flex().items_center().justify_center().rounded(8).cursor_pointer()
      .text_color(state.error ? t.blocked : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`${status}${prNote}\nClick to refresh`)
      .on_click((_e, cx) => state.refresh(cx))
      .child(svg(`${IMG}/refresh.svg`).size(14).when(state.busy, (el) => el.spin(900))));
}

const note = (t, text, color) => div().mx(10).px(10).py(8).font_family(UI).text_size(SIZE.body - 0.5).text_color(color ?? t.dim).child(text);

// A parent shows above its subtasks; one that isn't in this list still heads them, as a plain label.
function grouped(list) {
  const ids = new Set(list.map((i) => i.idReadable));
  const out = [];
  const under = new Map();
  for (const issue of list) {
    const p = parentOf(issue);
    if (p && ids.has(p.idReadable)) { under.set(p.idReadable, [...(under.get(p.idReadable) ?? []), issue]); continue; }
    if (p) {
      const group = out.find((x) => x.parent?.idReadable === p.idReadable);
      if (group) group.kids.push(issue); else out.push({ parent: p, kids: [issue] });
      continue;
    }
    out.push({ issue, kids: [] });
  }
  for (const x of out) if (x.issue) x.kids = under.get(x.issue.idReadable) ?? [];
  return out;
}

function parentLabel(t, p) {
  return h_flex().id(`yt-p-${p.idReadable}`).px(10).pt(10).pb(2).gap(8).items_center().cursor_pointer()
    .tooltip("Open the parent in YouTrack")
    .on_click(() => { if (ID.test(p.idReadable)) exec("open", [`${HOST}/youtrack/issue/${p.idReadable}`]); })
    .child(div().flex_none().font_family(MONO).font_weight(600).text_size(SIZE.meta).text_color(t.dim).child(p.idReadable))
    .child(div().flex_1().min_w(0).truncate().font_family(UI).font_weight(600).text_size(SIZE.meta).text_color(t.muted).child(p.summary));
}

export function tracker(state, cx) {
  const t = theme();
  if (cx && !checking() && shared(STARTED) !== state.started) { state.started = shared(STARTED); state.refresh(cx); }
  const crew = deployed();
  const shown = shownTicket();
  const q = state.search?.value().trim().toLowerCase() ?? "";
  const issues = (state.issues ?? []).filter((i) => !q || `${i.idReadable} ${i.summary}`.toLowerCase().includes(q));
  const view = shared(VIEW) ?? "doing";
  const of = (v) => issues.filter((i) => viewOf(i)?.id === v);
  const kidsOfShown = (state.issues ?? []).filter((i) => parentOf(i)?.idReadable === shown);
  const inCard = new Set([shown, ...kidsOfShown.map((i) => i.idReadable)]);
  // Tickets someone is working on come first; the rest stay newest first.
  const list = of(view).filter((i) => !inCard.has(i.idReadable))
    .sort((a, b) => Number(crew.has(b.idReadable)) - Number(crew.has(a.idReadable)));
  const label = VIEWS.find((v) => v.id === view).label.toLowerCase();
  const rowOf = (i, depth) => row(t, state, i, crew.get(i.idReadable) ?? [], cx, { depth });
  return v_flex().size_full().bg(t.chrome)
    .child(toolbar(t, state))
    .when(Boolean(state.error), (el) => el.child(div().mx(10).mb(8).p(10).rounded(8).bg(t.blocked + "14")
      .font_family(UI).text_size(SIZE.body - 0.5).text_color(t.blocked).child(`Can't reach YouTrack: ${state.error}`)))
    .child(v_flex().id("yt-list").flex_1().min_h(0).overflow_y_scroll().pb(12)
      .when(Boolean(shown), (el) => el.child(current(t, state, shown, crew.get(shown) ?? [],
        kidsOfShown.map((i) => ({ issue: i, crew: crew.get(i.idReadable) ?? [] })), cx)))
      .child(div().px(10).pb(6).child(segmented("yt-view",
        VIEWS.map((v) => [v.id, v.label, state.issues ? of(v.id).filter((i) => !inCard.has(i.idReadable)).length : null, t[v.tone]]),
        view, (v) => setShared(VIEW, v))))
      .child(v_flex().px(4).gap(1)
        .when(!state.issues && !state.error, (el) => el.child(note(t, "Loading tickets…")))
        .when(Boolean(state.issues) && !list.length, (el) => el.child(note(t, q ? `No ${label} tickets match “${q}”.` : `Nothing ${label}.`)))
        .children(grouped(list).flatMap((g) => [
          g.issue ? rowOf(g.issue, 0) : parentLabel(t, g.parent),
          ...g.kids.map((k) => rowOf(k, g.issue ? 1 : 0)),
        ]))));
}
