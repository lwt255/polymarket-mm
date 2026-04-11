#!/usr/bin/env python3
"""v4 bot health check. Designed to be called two ways:

1.  Without --alert: prints a human-readable status summary (used by the
    local v4-health command via SSH). No state changes, no notifications.

2.  With --alert: same checks, plus writes state to a JSON file and fires
    ntfy.sh pushes on state transitions. Designed to be run by a systemd
    timer every ~2 minutes on the VPS.

Health checks performed:
    - systemd service active/running
    - bot process alive (pid)
    - log file updated recently (zombie detection)
    - no HALT / FATAL in recent log
    - no repeated errors (CLOB/RPC) in recent log
    - trailing stop proximity (if balance is within $5 of trail floor, warn)
    - chainlink connection (looks for recent CL messages in log)

Exit codes:
    0  all green
    1  warnings present
    2  something is broken

Environment (for --alert mode):
    NTFY_TOPIC    ntfy.sh topic to publish alerts to
    NTFY_SERVER   optional, defaults to https://ntfy.sh
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = "/home/polybot/polymarket-mm/logs/v4-bot.log"
STATE_PATH = "/home/polybot/polymarket-mm/state/v4-watchdog-state.json"
SERVICE_NAME = "polymarket-v4-bot"

# Thresholds
LOG_STALE_SECONDS = 300          # 5 min without a log line = zombie
RECENT_LOG_WINDOW_SECONDS = 3600 # look at last hour for error patterns
ERROR_REPEAT_THRESHOLD = 3       # N+ repeated errors in window = alert
TRAIL_PROXIMITY_USD = 5.0        # balance within $5 of trail floor = warn
# (chainlink check removed — CL: snapshots only fire at bootstrap, not per candle.
# If Chainlink actually breaks, log freshness catches it: the bot can't evaluate
# candles without Chainlink, so new log lines stop appearing.)

STATUS_OK = "ok"
STATUS_WARN = "warn"
STATUS_BROKEN = "broken"

# ── Helpers ──────────────────────────────────────────────────────────

def run(cmd: list[str], timeout: int = 10) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:
        return -1, f"error: {e}"

def read_tail(path: str, max_bytes: int = 200_000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            start = max(0, size - max_bytes)
            f.seek(start)
            return f.read().decode("utf-8", errors="replace")
    except Exception:
        return ""

def parse_log_timestamp(line: str) -> datetime | None:
    m = re.match(r"\[(\d{2}):(\d{2}):(\d{2})\]", line)
    if not m: return None
    h, mi, s = map(int, m.groups())
    now = datetime.now(timezone.utc)
    dt = now.replace(hour=h, minute=mi, second=s, microsecond=0)
    # If parsed time is in the future, it's from yesterday
    if dt > now: dt = dt.replace(day=dt.day - 1)
    return dt

def seconds_since(dt: datetime | None) -> int | None:
    if dt is None: return None
    return int((datetime.now(timezone.utc) - dt).total_seconds())

# ── Checks ───────────────────────────────────────────────────────────

def check_service() -> dict:
    rc, out = run(["systemctl", "is-active", SERVICE_NAME])
    active = out.strip() == "active"
    _, substate = run(["systemctl", "show", SERVICE_NAME, "-p", "SubState", "--value"])
    _, enter_ts = run(["systemctl", "show", SERVICE_NAME, "-p", "ActiveEnterTimestamp", "--value"])
    _, n_restarts = run(["systemctl", "show", SERVICE_NAME, "-p", "NRestarts", "--value"])

    status = STATUS_OK if (active and substate == "running") else STATUS_BROKEN
    msg = f"{out.strip()}/{substate}" if active else f"service not running ({out.strip()}/{substate})"

    # uptime parsing
    uptime = None
    if enter_ts:
        try:
            t = datetime.strptime(enter_ts, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
            secs = int((datetime.now(timezone.utc) - t).total_seconds())
            h, rem = divmod(secs, 3600); m, _ = divmod(rem, 60)
            uptime = f"{h}h {m}m"
        except Exception:
            pass

    return {
        "name": "service",
        "status": status,
        "message": msg,
        "detail": {"uptime": uptime, "restarts": n_restarts},
    }

def check_process() -> dict:
    rc, out = run(["pgrep", "-f", "microstructure-bot.ts"])
    if rc != 0 or not out:
        return {"name": "process", "status": STATUS_BROKEN, "message": "no process found"}
    pids = out.split()
    return {"name": "process", "status": STATUS_OK, "message": f"alive ({len(pids)} pids)"}

def check_log_freshness() -> dict:
    if not os.path.exists(LOG_PATH):
        return {"name": "log", "status": STATUS_BROKEN, "message": "log file missing"}

    mtime = os.path.getmtime(LOG_PATH)
    age = int(time.time() - mtime)

    # Also check the last parseable log timestamp inside the file
    # (file mtime can be misleading if filesystem buffered writes)
    tail = read_tail(LOG_PATH, max_bytes=50_000)
    last_ts = None
    for line in reversed(tail.splitlines()):
        ts = parse_log_timestamp(line)
        if ts:
            last_ts = ts
            break
    logical_age = seconds_since(last_ts)

    # Use the smaller of the two (most generous) for the check
    effective_age = age if logical_age is None else min(age, logical_age)

    if effective_age > LOG_STALE_SECONDS:
        return {
            "name": "log",
            "status": STATUS_BROKEN,
            "message": f"log stale ({effective_age}s since last update)",
            "detail": {"age_seconds": effective_age},
        }

    return {
        "name": "log",
        "status": STATUS_OK,
        "message": f"updated {effective_age}s ago",
        "detail": {"age_seconds": effective_age},
    }

def check_recent_halt_or_fatal(tail: str) -> dict:
    # Only alert on halts from the last hour (bot might have been restarted since)
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - RECENT_LOG_WINDOW_SECONDS

    last_halt = None
    last_fatal = None
    for line in tail.splitlines():
        ts = parse_log_timestamp(line)
        if ts is None or ts.timestamp() < cutoff: continue
        if "HALT:" in line or "HALT " in line:
            last_halt = (ts, line.strip())
        if "FATAL" in line:
            last_fatal = (ts, line.strip())

    if last_fatal:
        return {"name": "halt_fatal", "status": STATUS_BROKEN,
                "message": f"FATAL at {last_fatal[0].strftime('%H:%M')}",
                "detail": {"line": last_fatal[1]}}
    if last_halt:
        return {"name": "halt_fatal", "status": STATUS_WARN,
                "message": f"HALT at {last_halt[0].strftime('%H:%M')}",
                "detail": {"line": last_halt[1]}}
    return {"name": "halt_fatal", "status": STATUS_OK, "message": "no HALT / FATAL in last 60 min"}

def check_repeated_errors(tail: str) -> dict:
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - RECENT_LOG_WINDOW_SECONDS

    # Patterns that indicate real trouble (not normal variance)
    patterns = {
        "clob_auth": re.compile(r"Could not create api key|CLOB authentication failed", re.I),
        "rpc_error": re.compile(r"RPC.*(failed|error|timeout)|On-chain balance read FAILED", re.I),
        "network": re.compile(r"ECONNRESET|ETIMEDOUT|network error", re.I),
    }
    counts = {k: 0 for k in patterns}

    for line in tail.splitlines():
        ts = parse_log_timestamp(line)
        if ts is None or ts.timestamp() < cutoff:
            # Unparseable lines (e.g., raw exception dumps) — don't skip them entirely
            # but treat them as current
            pass
        for k, p in patterns.items():
            if p.search(line):
                counts[k] += 1

    repeated = {k: v for k, v in counts.items() if v >= ERROR_REPEAT_THRESHOLD}
    if repeated:
        summary = ", ".join(f"{k}={v}" for k, v in repeated.items())
        return {"name": "errors", "status": STATUS_WARN,
                "message": f"repeated errors: {summary}",
                "detail": repeated}
    return {"name": "errors", "status": STATUS_OK, "message": "no repeated errors"}

def check_trail_proximity(tail: str) -> dict:
    # Only look at lines since the most recent bot startup. Previous-session
    # trail floor lines are stale and misleading.
    lines = tail.splitlines()
    start_idx = 0
    for i, line in enumerate(lines):
        if "MICROSTRUCTURE BOT v4" in line:
            start_idx = i
    session_lines = lines[start_idx:]

    # Look for most recent "Balance: $X | ... | trail floor $Y" — only fires
    # when peak > starting balance (i.e., trail is armed).
    pat = re.compile(r"Balance: \$([0-9.]+).*trail floor \$([0-9.]+)")
    last_bal = None
    last_floor = None
    for line in reversed(session_lines):
        m = pat.search(line)
        if m:
            last_bal = float(m.group(1))
            last_floor = float(m.group(2))
            break

    if last_bal is None:
        return {"name": "trail", "status": STATUS_OK, "message": "inactive (trail not armed yet)"}

    cushion = last_bal - last_floor
    if cushion < TRAIL_PROXIMITY_USD:
        return {"name": "trail", "status": STATUS_WARN,
                "message": f"cushion ${cushion:.2f} (< ${TRAIL_PROXIMITY_USD})",
                "detail": {"balance": last_bal, "floor": last_floor, "cushion": cushion}}
    return {"name": "trail", "status": STATUS_OK, "message": f"armed, ${cushion:.2f} cushion"}

# ── Orchestration ────────────────────────────────────────────────────

def run_all_checks() -> dict:
    tail = read_tail(LOG_PATH, max_bytes=200_000)
    checks = [
        check_service(),
        check_process(),
        check_log_freshness(),
        check_recent_halt_or_fatal(tail),
        check_repeated_errors(tail),
        check_trail_proximity(tail),
    ]
    worst = STATUS_OK
    for c in checks:
        if c["status"] == STATUS_BROKEN:
            worst = STATUS_BROKEN
        elif c["status"] == STATUS_WARN and worst == STATUS_OK:
            worst = STATUS_WARN
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "worst": worst,
        "checks": checks,
    }

def format_human(report: dict) -> str:
    icons = {STATUS_OK: "✅", STATUS_WARN: "⚠️ ", STATUS_BROKEN: "❌"}
    labels = {
        "service": "service   ",
        "process": "process   ",
        "log": "log       ",
        "halt_fatal": "halts     ",
        "errors": "errors    ",
        "trail": "trail     ",
    }
    lines = []
    lines.append("─" * 45)
    lines.append(f" v4 Bot Health — {report['timestamp'][:16]} UTC")
    lines.append("─" * 45)
    for c in report["checks"]:
        icon = icons.get(c["status"], "?")
        label = labels.get(c["name"], c["name"])
        lines.append(f" {icon} {label} {c['message']}")
    lines.append("─" * 45)
    # service uptime (last line, info-only)
    svc = next((c for c in report["checks"] if c["name"] == "service"), None)
    if svc and svc.get("detail", {}).get("uptime"):
        lines.append(f" Uptime since last restart: {svc['detail']['uptime']}")
    # Overall status
    overall = {STATUS_OK: "ALL GREEN", STATUS_WARN: "WARNINGS", STATUS_BROKEN: "BROKEN"}
    lines.append(f" Overall: {icons[report['worst']]} {overall[report['worst']]}")
    lines.append("─" * 45)
    return "\n".join(lines)

# ── Alert state ──────────────────────────────────────────────────────

def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state: dict) -> None:
    Path(STATE_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)

def send_ntfy(title: str, body: str, priority: str = "default") -> None:
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh")
    url = f"{server}/{topic}"
    headers = {
        "Title": title,
        "Priority": priority,
        "Tags": "warning,robot",
    }
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"ntfy push failed: {e}", file=sys.stderr)

def maybe_alert(report: dict) -> None:
    state = load_state()
    last_status = state.get("last_status", {})
    new_status = {c["name"]: c["status"] for c in report["checks"]}

    for c in report["checks"]:
        prev = last_status.get(c["name"], STATUS_OK)
        curr = c["status"]
        # Only alert on transitions INTO a non-OK state
        if curr != STATUS_OK and curr != prev:
            priority = "high" if curr == STATUS_BROKEN else "default"
            title = f"v4 Bot: {c['name']} {curr.upper()}"
            body = c["message"]
            if c.get("detail"):
                body += "\n" + json.dumps(c["detail"], indent=2)
            send_ntfy(title, body, priority=priority)

    state["last_status"] = new_status
    state["last_check"] = report["timestamp"]
    save_state(state)

# ── Main ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--alert", action="store_true", help="write state and send ntfy pushes on transitions")
    ap.add_argument("--json", action="store_true", help="output JSON instead of human-readable")
    args = ap.parse_args()

    report = run_all_checks()

    if args.alert:
        maybe_alert(report)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(format_human(report))

    sys.exit({STATUS_OK: 0, STATUS_WARN: 1, STATUS_BROKEN: 2}[report["worst"]])

if __name__ == "__main__":
    main()
