import { exec, home } from "herdr";
import { youtrack } from "./youtrack.js";

const FIELDS = "idReadable,summary,description,resolved,customFields(name,value(name)),"
  + "comments(text,created,author(fullName)),links(direction,linkType(name,sourceToTarget,targetToSource),issues(idReadable,summary,resolved))";
const MAX_DEPTH = 3;

const field = (issue, name) => {
  const v = issue.customFields?.find((f) => f.name === name)?.value;
  return Array.isArray(v) ? v.map((x) => x?.name).filter(Boolean).join(", ") : v?.name ?? null;
};
const isSubtask = (l) => l.linkType?.name === "Subtask" && l.direction === "OUTWARD";

async function load(id, depth, seen) {
  seen.add(id);
  const issue = await youtrack(`issues/${id}?fields=${encodeURIComponent(FIELDS)}`);
  const subs = (issue.links ?? []).filter(isSubtask).flatMap((l) => l.issues ?? [])
    .filter((s) => !s.resolved && !seen.has(s.idReadable));
  issue.subtasks = depth < MAX_DEPTH
    ? await Promise.all(subs.map((s) => load(s.idReadable, depth + 1, seen)))
    : subs;
  return issue;
}

export const ticketTree = (id) => load(id, 0, new Set());

export function flatten(issue) {
  return [issue, ...(issue.subtasks ?? []).flatMap(flatten)];
}

function nest(markdown, by) {
  return markdown?.replace(/^(#{1,6}) /gm, (_m, h) => `${"#".repeat(Math.min(h.length + by, 6))} `);
}

function section(issue, level) {
  const h = "#".repeat(Math.min(level + 1, 6));
  const meta = ["State", "Type", "Priority"].map((n) => field(issue, n) && `${n}: ${field(issue, n)}`).filter(Boolean).join(" · ");
  const related = (issue.links ?? []).filter((l) => !isSubtask(l) && l.issues?.length)
    .map((l) => `- ${l.direction === "INWARD" ? l.linkType.targetToSource || l.linkType.sourceToTarget : l.linkType.sourceToTarget}: `
      + l.issues.map((i) => `${i.idReadable} ${i.summary}`).join("; "));
  const comments = (issue.comments ?? []).slice(-10)
    .map((c) => `- **${c.author?.fullName ?? "?"}** (${new Date(c.created).toISOString().slice(0, 10)}): ${c.text?.trim() ?? ""}`);
  return [
    `${h} ${issue.idReadable}: ${issue.summary}`,
    meta,
    nest(issue.description?.trim(), level + 1) || "_No description._",
    related.length ? `**Related**\n${related.join("\n")}` : "",
    comments.length ? `**Comments**\n${comments.join("\n")}` : "",
    ...(issue.subtasks ?? []).map((s) => (s.customFields ? section(s, level + 1) : `${"#".repeat(Math.min(level + 2, 6))} ${s.idReadable}: ${s.summary}\n_Deeper subtask, not loaded._`)),
  ].filter(Boolean).join("\n\n");
}

export function briefText(tree, repo, branch) {
  const where = branch ? `Main repo: ${repo} · branch: ${branch}` : "Repos: not chosen yet; find out which ones this needs.";
  return `${where}\n\n${section(tree, 0)}\n`;
}

export async function writeBrief(ticket, text) {
  const path = `${home()}/.cache/herdr-clear/briefs/${ticket}-brief.md`;
  const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', "sh", path, text]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "could not write the brief");
  return path;
}

export async function moveInProgress(issues) {
  const open = issues.filter((i) => !["In Progress", "Refactoring"].includes(field(i, "State")));
  if (open.length) await youtrack("commands", { query: "State In Progress", issues: open.map((i) => ({ idReadable: i.idReadable })) });
  return open.length;
}

export function firstMessage(ticket, path, count, repo) {
  const helper = `~/.local/bin/wt-ticket start <repo> ${ticket} "<short summary>"`;
  return `You are on ${ticket}${count > 1 ? ` and its ${count - 1} subtask${count > 2 ? "s" : ""}` : ""}. `
    + `Read ${path}: the ticket, subtasks, comments and links from YouTrack. `
    + (repo
      ? `This worktree is ${repo}, the main repo, but the work may also need other repos in ~/durchblicker. `
      : "No repo is chosen yet: this folder holds all company repos in ~/durchblicker; find out which ones the work needs. ")
    + `Never edit the main clones in ~/durchblicker; for each other repo you will change, run \`${helper}\`, `
    + "which prints the worktree path as JSON, and work there. "
    + "Explore as needed, then reply with: a short summary, the repos involved, a proposed plan per subtask, "
    + "and every open question or unclear requirement. Do not change any code yet; wait for my answer.";
}
