import { hc, exec } from "herdr";
import { screen, closePanels } from "./btw.js";

// Getting a chat message into omp reliably. The chat pastes it into omp's terminal editor and presses Enter;
// that can leave it sitting in the editor (a queued message handed back by Stop, a box that took the keys),
// and hc holds the next send behind such a draft and then pastes on top of it.

const pause = (s) => exec("sleep", [String(s)]);
export const words = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// omp's editor is its bottom line: "╰─ <draft>". A long draft wraps, so this is its last line.
export function draftIn(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("╰─")) continue;
    const m = /^╰─ (.*\S)\s*$/.exec(lines[i]);
    return m && !/^─+/.test(m[1]) ? m[1].trim() : null;
  }
  return null;
}

export const draftOf = async (terminal) => draftIn(await screen(terminal));

// Whether the editor's text is (the end of) this message.
export function holds(draft, text) {
  const d = words(draft).replace(/…$/, "");
  const x = words(text);
  return d.length >= 3 && (x.includes(d) || d.includes(x));
}

export async function sendDraft(terminal) {
  if (await draftOf(terminal)) await hc(["keys", terminal, "enter"]);
}

// Ctrl+C clears omp's draft, but on an empty editor it starts quitting, and omp's dimmed reply prediction reads
// like a draft: only press it while this exact message is there.
export async function discardDraft(terminal, text) {
  const d = await draftOf(terminal);
  if (d && holds(d, text)) await hc(["keys", terminal, "ctrl+c"]);
}

// Returns { ok }, { stuck } or { error }.
export async function deliver(terminal, text) {
  await closePanels(terminal);
  const r = await hc(["send", terminal, /@\S+$/.test(text) ? `${text} ` : text]).catch((e) => ({ code: 1, stderr: String(e) }));
  if (r.code !== 0) return { error: (r.stderr || r.stdout || `hc send exited with ${r.code}`).trim() };
  // A message omp took has left the editor (sent or queued). Still there: Enter once more, then report it stuck.
  for (let i = 0; i < 3; i++) {
    await pause(0.8);
    const d = await draftOf(terminal);
    if (!d || !holds(d, text)) return { ok: true };
    if (i === 0) await hc(["keys", terminal, "enter"]);
  }
  return { stuck: true };
}
