import datetime as dt
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
# Herdr launched from Finder may lack Homebrew on PATH, where gh lives.
os.environ["PATH"] = "/opt/homebrew/bin:" + os.environ.get("PATH", "")
PROJECTS = os.path.join(HOME, ".claude", "projects")
OMP_DB = os.path.join(HOME, ".omp", "stats.db")
CACHE = os.path.join(HOME, ".config", "herdr-app", "ticket-desk.cache.json")
TICKET = re.compile(r"\bIT-?(\d{3,5})\b", re.I)
GH_EVERY = 60
STUCK_WINDOW, STUCK_ERRORS = 8, 4

# Estimated API list prices, $/M tokens [input, output, cache read]; copied from the claude-usage mod.
PRICES = sorted([
    ("claude-fable-5", 10, 50, 1), ("claude-mythos-5", 10, 50, 1),
    ("claude-opus-5-5", 4, 20, 0.2), ("claude-opus-5", 5, 25, 0.5), ("claude-opus-4", 5, 25, 0.5),
    ("claude-sonnet-5", 2, 10, 0.2), ("claude-sonnet-4", 3, 15, 0.3),
    ("claude-haiku-5-5", 0.1, 0.5, 0.01), ("claude-haiku-4-5", 1, 5, 0.1),
], key=lambda r: -len(r[0]))


def ticket_of(text):
    m = TICKET.search(text or "")
    return f"IT-{m.group(1)}" if m else None


def cost(model, u):
    r = next((r for r in PRICES if (model or "").startswith(r[0])), None)
    if not r:
        return 0.0
    _, pin, pout, pread = r
    cw = u.get("cache_creation") or {}
    w5, w1 = cw.get("ephemeral_5m_input_tokens"), cw.get("ephemeral_1h_input_tokens")
    if w5 is None and w1 is None:
        w5, w1 = u.get("cache_creation_input_tokens", 0) or 0, 0
    usd = ((u.get("input_tokens", 0) or 0) * pin + (u.get("output_tokens", 0) or 0) * pout
           + (u.get("cache_read_input_tokens", 0) or 0) * pread + (w5 or 0) * pin * 1.25 + (w1 or 0) * pin * 2) / 1e6
    return usd * 2 if u.get("speed") == "fast" else usd


def scan_lines(state, lines):
    """Fold transcript lines into a file's state: per-day cost, last model, recent tool errors."""
    seen = state.setdefault("ids", [])
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message")
        if not isinstance(m, dict):
            continue
        if e.get("type") == "assistant" and m.get("usage"):
            mid = m.get("id")
            if mid and mid in seen:
                continue
            if mid:
                seen.append(mid)
                del seen[:-50]
            ts = e.get("timestamp")
            day = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d") if ts else "?"
            state["days"][day] = state["days"].get(day, 0) + cost(m.get("model"), m["usage"])
            if m.get("model") and not m["model"].startswith("<"):
                state["model"] = m["model"]
        elif e.get("type") == "user" and isinstance(m.get("content"), list):
            for c in m["content"]:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    state["recent"] = (state["recent"] + [bool(c.get("is_error"))])[-STUCK_WINDOW:]


def scan_claude(cache):
    files = cache.setdefault("files", {})
    for path in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
        st = files.setdefault(path, {"off": 0, "days": {}, "model": None, "recent": []})
        size = os.path.getsize(path)
        if size < st["off"]:
            st.update(off=0, days={}, recent=[], ids=[])
        if size == st["off"]:
            continue
        with open(path, "rb") as f:
            f.seek(st["off"])
            chunk = f.read()
        end = chunk.rfind(b"\n") + 1
        scan_lines(st, chunk[:end].decode("utf-8", "ignore").splitlines())
        st["off"] += end
        st["mtime"] = os.path.getmtime(path)
    for path in [p for p in files if not os.path.exists(p)]:
        del files[path]
    return files


def project_dir(folder):
    return os.path.join(PROJECTS, re.sub(r"[^A-Za-z0-9]", "-", folder))


def owner(path):
    """(project dir, is a sub-agent transcript) for a transcript path."""
    parts = os.path.relpath(path, PROJECTS).split(os.sep)
    return os.path.join(PROJECTS, parts[0]), len(parts) > 2


def git(folder, *args):
    r = subprocess.run(["git", "-C", folder, *args], capture_output=True, text=True, timeout=10)
    return r.stdout.strip() if r.returncode == 0 else None


def git_info(folder):
    common = git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        return {}
    base = git(folder, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") or "origin/main"
    counts = (git(folder, "rev-list", "--left-right", "--count", f"{base}...HEAD") or "0 0").split()
    mb = git(folder, "merge-base", base, "HEAD")
    stat = git(folder, "diff", "--shortstat", mb) if mb else ""
    nums = [int(n) for n in re.findall(r"(\d+) (?:insertion|deletion)", stat or "")]
    return {
        "repo": os.path.basename(os.path.dirname(common.rstrip("/"))) if common.endswith(".git") else os.path.basename(common),
        "branch": git(folder, "rev-parse", "--abbrev-ref", "HEAD"),
        "behind": int(counts[0]), "ahead": int(counts[1]),
        "files": int((re.search(r"(\d+) files? changed", stat or "") or [0, 0])[1]),
        "added": nums[0] if len(nums) > 0 else 0, "removed": nums[1] if len(nums) > 1 else 0,
    }


def pr_info(folder, cache):
    prs = cache.setdefault("prs", {})
    hit = prs.get(folder)
    if hit and time.time() - hit["at"] < GH_EVERY:
        return hit["pr"]
    pr = None
    try:
        r = subprocess.run(["gh", "pr", "view", "--json", "number,state,isDraft,reviewDecision,statusCheckRollup,url"],
                           cwd=folder, capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            d = json.loads(r.stdout)
            checks = [c.get("conclusion") or c.get("state") for c in d.get("statusCheckRollup") or []]
            failing = any(c in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED") for c in checks)
            pending = any(c in (None, "", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED") for c in checks)
            state = ("merged" if d["state"] == "MERGED" else "closed" if d["state"] == "CLOSED"
                     else "draft" if d.get("isDraft") else "failing" if failing
                     else "approved" if d.get("reviewDecision") == "APPROVED" else "pending" if pending else "open")
            pr = {"number": d["number"], "state": state, "url": d["url"]}
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        pass
    prs[folder] = {"at": time.time(), "pr": pr}
    return pr


def omp_week():
    if not os.path.exists(OMP_DB):
        return None
    try:
        con = sqlite3.connect(f"file:{OMP_DB}?mode=ro", uri=True, timeout=2)
        since = (time.time() - 7 * 86400) * 1000
        week, last = con.execute("select coalesce(sum(case when timestamp>=? then cost_total end),0), max(timestamp) from messages", (since,)).fetchone()
        con.close()
        return {"week": week, "last": dt.datetime.fromtimestamp(last / 1000).strftime("%Y-%m-%d") if last else None}
    except sqlite3.Error:
        return None


def summarize(files, folders, today, week_start):
    def day_sum(days, pred):
        return sum(v for d, v in days.items() if pred(d))

    tickets, out = {}, {}
    total_today = total_week = 0.0
    for path, st in files.items():
        total_today += day_sum(st["days"], lambda d: d == today)
        total_week += day_sum(st["days"], lambda d: d >= week_start)
        t = ticket_of(os.path.basename(owner(path)[0]))
        if t:
            agg = tickets.setdefault(t, {"cost": 0.0, "today": 0.0})
            agg["cost"] += sum(st["days"].values())
            agg["today"] += day_sum(st["days"], lambda d: d == today)
    for folder in folders:
        pdir = project_dir(folder)
        mine = [(owner(p)[1], st) for p, st in files.items() if owner(p)[0] == pdir]
        latest = max((s for sub, s in mine if not sub), key=lambda s: s.get("mtime", 0), default=None)
        mine = [s for _, s in mine]
        recent = latest["recent"] if latest else []
        out[folder] = {
            "cost": sum(sum(s["days"].values()) for s in mine),
            "today": sum(day_sum(s["days"], lambda d: d == today) for s in mine),
            "model": latest and latest.get("model"),
            "stuck": sum(recent) >= STUCK_ERRORS,
        }
    return {"today": total_today, "week": total_week, "tickets": tickets, "folders": out}


def main(folders):
    try:
        cache = json.load(open(CACHE))
    except (OSError, ValueError):
        cache = {}
    files = scan_claude(cache)
    now = dt.datetime.now()
    res = summarize(files, folders, now.strftime("%Y-%m-%d"), (now - dt.timedelta(days=6)).strftime("%Y-%m-%d"))
    for folder in folders:
        res["folders"][folder].update(git_info(folder), pr=pr_info(folder, cache) if os.path.isdir(folder) else None)
    res["omp"] = omp_week()
    tmp = CACHE + ".tmp"
    json.dump(cache, open(tmp, "w"))
    os.replace(tmp, CACHE)
    print(json.dumps(res))


def selfcheck():
    assert ticket_of("/x/.claude/worktrees/IT-4342") == "IT-4342"
    assert ticket_of("2026/11/IT-123/foo") == "IT-123"
    assert ticket_of("it3671-app-p7") == "IT-3671" and ticket_of("feature/it-3671-x") == "IT-3671"
    assert abs(cost("claude-opus-5-5", {"output_tokens": 1_000_000}) - 20) < 1e-9
    st = {"days": {}, "model": None, "recent": []}
    a = json.dumps({"type": "assistant", "timestamp": "2026-11-17T10:00:00Z",
                    "message": {"id": "m1", "model": "claude-opus-5-5", "usage": {"input_tokens": 1_000_000}}})
    err = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True}]}})
    ok = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result"}]}})
    scan_lines(st, [a, a, err, ok, err, err, err, "not json"])
    assert sum(st["days"].values()) == 4 and st["model"] == "claude-opus-5-5"
    folder = "/r/.claude/worktrees/IT-1111"
    files = {os.path.join(project_dir(folder), "s.jsonl"): st}
    day = next(iter(st["days"]))
    r = summarize(files, [folder], day, day)
    assert r["tickets"]["IT-1111"]["cost"] == 4 and r["folders"][folder]["stuck"] and r["today"] == 4
    st["recent"] = [True, False, False, True, False]
    sub = {"days": {day: 1.0}, "model": None, "recent": [True] * 8, "mtime": 9e9}
    files[os.path.join(project_dir(folder), "s", "subagents", "a.jsonl")] = sub
    r = summarize(files, [folder], day, day)
    assert not r["folders"][folder]["stuck"] and r["folders"][folder]["cost"] == 5
    print("selfcheck ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selfcheck"]:
        selfcheck()
    else:
        main(json.loads(sys.argv[1]) if len(sys.argv) > 1 else [])
