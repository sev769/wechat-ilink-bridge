#!/usr/bin/env bash
# wxb-inbox: poll the local WeChat iLink bridge for new messages.
# New messages are appended to a pending file; the worker agent replies
# to them and removes handled lines.
#
# Robustness rules (patched 2026-11-08):
# - Dedupe is persistent: every queued message id is recorded in a seen
#   list (last 500), so a redelivered old message is never queued twice,
#   even after the worker removed its pending line.
# - Re-wake cooldown: if pending is non-empty but nothing new arrived,
#   wake at most once per 600s instead of every poll (~20s).
# - One-shot fault alerts: wxb missing from PATH, or 5 consecutive
#   non-SESSION_EXPIRED fetch errors, wake once with reason
#   wechat_bridge_broken until a successful fetch clears the alert.
# - Self-heal (added 2026-11-08): before alerting on a missing wxb, run
#   ~/workspace/reinstall-wechat-bridge.sh once per missing episode
#   (VM replacements wipe /usr but keep $HOME, so this restores the
#   global install unattended); alert only if wxb is still missing.
# - SESSION_EXPIRED wakes only once until a fetch succeeds again.
# Everything else stays silent.
set -uo pipefail
source "$HATCH_HOOK_RUNTIME"

STATE_DIR="$HOME/hooks/state"
# Self-heal target: a script that reinstalls wxb globally (see reinstall-wechat-bridge.sh example).
REINSTALL_SCRIPT="${WXB_REINSTALL_SCRIPT:-$HOME/workspace/reinstall-wechat-bridge.sh}"
PENDING="$STATE_DIR/wxb-pending.jsonl"
EXPIRED_FLAG="$STATE_DIR/wxb-expired.flag"
MISSING_FLAG="$STATE_DIR/wxb-missing.flag"
HEAL_FLAG="$STATE_DIR/wxb-heal-attempted.flag"
HEALFAIL_FLAG="$STATE_DIR/wxb-heal-failed.flag"
HEAL_LOG="$STATE_DIR/wxb-heal.log"
mkdir -p "$STATE_DIR"
touch "$PENDING"

# Self-heal: a VM replacement wipes the global install under /usr but
# leaves $HOME intact, so the durable reinstall script can restore wxb
# unattended. Attempt it once per missing episode, bounded well under
# the hook's script timeout; only if wxb is still missing afterwards do
# we fall through to the one-shot alert below.
if ! command -v wxb >/dev/null 2>&1; then
  if [ ! -f "$HEAL_FLAG" ]; then
    touch "$HEAL_FLAG"
    log "wxb_missing" '{"note":"wxb not on PATH; attempting one-shot self-heal via reinstall script"}'
    timeout 240 "$REINSTALL_SCRIPT" >"$HEAL_LOG" 2>&1 || true
    hash -r
    if command -v wxb >/dev/null 2>&1; then
      log "wxb_healed" '{"note":"self-heal succeeded; wxb restored by reinstall script"}'
    else
      touch "$HEALFAIL_FLAG"
      log "wxb_heal_failed" '{"note":"self-heal attempted but wxb still missing; see wxb-heal.log"}'
    fi
  fi
fi

if ! command -v wxb >/dev/null 2>&1; then
  if [ -f "$HEALFAIL_FLAG" ] && [ ! -f "$MISSING_FLAG" ]; then
    touch "$MISSING_FLAG"
    log "wxb_missing" '{"note":"wxb not on PATH and self-heal did not restore it (VM rebuilt? run ~/workspace/reinstall-wechat-bridge.sh)"}'
    wake "wechat_bridge_broken" '{"detail":"wxb 程序不在 PATH 上（这台机器可能重建过），hook 已自动尝试运行重装脚本（WXB_REINSTALL_SCRIPT，默认 ~/workspace/reinstall-wechat-bridge.sh）自愈但未成功（日志 ~/hooks/state/wxb-heal.log），微信自动回复已暂停，需要人工恢复。"}'
  elif [ -f "$HEALFAIL_FLAG" ]; then
    log "wxb_missing" '{"note":"wxb still missing, alert already sent"}'
    silent "wxb not installed" '{}'
  else
    log "wxb_missing" '{"note":"wxb missing; self-heal in progress in another poll, staying silent"}'
    silent "wxb heal in progress" '{}'
  fi
  exit 0
fi
rm -f "$MISSING_FLAG" "$HEAL_FLAG" "$HEALFAIL_FLAG"

# Long timeout so one attempt can ride out the iLink long-poll (~20-35s);
# the 15s default aborts idle polls and reports NETWORK_ERROR.
OUT="$(wxb fetch --timeout 40000 --download-media --json 2>/dev/null || true)"

DECISION_FILE="$STATE_DIR/wxb-decision.txt"
PAYLOAD_FILE="$STATE_DIR/wxb-payload.json"
WXB_OUT="$OUT" PENDING="$PENDING" EXPIRED_FLAG="$EXPIRED_FLAG" \
  STATE_DIR="$STATE_DIR" \
  DECISION_FILE="$DECISION_FILE" PAYLOAD_FILE="$PAYLOAD_FILE" \
  python3 - << 'PYEOF'
import json, os, time

state = os.environ["STATE_DIR"]
pending = os.environ["PENDING"]
flag = os.environ["EXPIRED_FLAG"]
seen_path = os.path.join(state, "wxb-seen.txt")
lastwake_path = os.path.join(state, "wxb-lastwake.txt")
errcount_path = os.path.join(state, "wxb-errcount.txt")
fetchalert_path = os.path.join(state, "wxb-fetchalert.flag")
raw = os.environ.get("WXB_OUT", "").strip()
now = int(time.time())
COOLDOWN = 600
ERR_THRESHOLD = 5
SEEN_CAP = 500

def read_int(path, default=0):
    try:
        return int(open(path).read().strip())
    except Exception:
        return default

def write_int(path, val):
    with open(path, "w") as f:
        f.write(str(val))

new_msgs = []
expired_now = False
broken_detail = None
fetch_note = ""
err_code = None

if not raw:
    err_code = "EMPTY_OUTPUT"
else:
    try:
        data = json.loads(raw)
    except Exception:
        data = None
        err_code = "UNPARSEABLE_OUTPUT"
    if data is not None:
        if data.get("ok"):
            if os.path.exists(flag):
                os.remove(flag)
            for m in data.get("data", {}).get("messages", []):
                atts = []
                for a in m.get("attachments", []) or []:
                    atts.append({
                        "kind": a.get("kind"),
                        "path": a.get("path"),
                        "mimeType": a.get("mimeType"),
                        "fileName": a.get("fileName"),
                    })
                text = m.get("text") or ""
                entry = {
                    "id": m.get("id"),
                    "fromUserId": m.get("fromUserId"),
                    "timestamp": m.get("timestamp"),
                    "type": m.get("type"),
                    "text": text[:3800],
                    "attachments": atts,
                }
                if m.get("quote") is not None:
                    entry["quote"] = m.get("quote")
                if m.get("quotedMessage") is not None:
                    entry["quotedMessage"] = m.get("quotedMessage")
                new_msgs.append(entry)
            fetch_note = f"fetch ok, {len(new_msgs)} new"
            # Recovery: clear the fetch-error streak and its alert flag.
            write_int(errcount_path, 0)
            if os.path.exists(fetchalert_path):
                os.remove(fetchalert_path)
        else:
            code = (data.get("error") or {}).get("code", "UNKNOWN")
            if code == "SESSION_EXPIRED":
                fetch_note = "fetch error SESSION_EXPIRED"
                if not os.path.exists(flag):
                    with open(flag, "w") as f:
                        f.write("1")
                    expired_now = True
            else:
                err_code = code

if err_code is not None:
    streak = read_int(errcount_path, 0) + 1
    write_int(errcount_path, streak)
    fetch_note = f"fetch error {err_code} (streak {streak})"
    if streak >= ERR_THRESHOLD and not os.path.exists(fetchalert_path):
        with open(fetchalert_path, "w") as f:
            f.write("1")
        broken_detail = (
            f"wxb fetch 连续失败 {streak} 次，最近错误码 {err_code}，"
            "微信自动回复可能已暂停，请检查桥和网络。"
        )

# Load persistent seen ids (ids ever queued; guards against redelivery).
seen_list = []
if os.path.exists(seen_path):
    with open(seen_path) as f:
        seen_list = [ln.strip() for ln in f if ln.strip()]
seen_set = set(seen_list)

# Append new messages to pending, skipping ids already pending or seen.
existing_ids = set()
lines = []
if os.path.exists(pending):
    with open(pending) as f:
        lines = [ln for ln in f.read().splitlines() if ln.strip()]
    for ln in lines:
        try:
            existing_ids.add(json.loads(ln).get("id"))
        except Exception:
            pass
added = 0
with open(pending, "a") as f:
    for m in new_msgs:
        mid = m.get("id")
        if mid is not None and (mid in existing_ids or mid in seen_set):
            continue
        f.write(json.dumps(m, ensure_ascii=False) + "\n")
        added += 1
        if mid is not None:
            seen_list.append(str(mid))
            seen_set.add(mid)
if added:
    with open(seen_path, "w") as f:
        f.write("\n".join(seen_list[-SEEN_CAP:]) + "\n")

total = len(lines) + added
preview = []
if total:
    with open(pending) as f:
        for ln in f.read().splitlines()[:3]:
            try:
                pm = json.loads(ln)
                preview.append((pm.get("text") or f"[{pm.get('type')}]")[:80])
            except Exception:
                pass

if expired_now:
    decision, reason = "wake", "wechat_session_expired"
    payload = {"pending_file": pending, "pending_count": total, "fetch": fetch_note}
elif broken_detail is not None:
    decision, reason = "wake", "wechat_bridge_broken"
    payload = {"detail": broken_detail, "fetch": fetch_note}
elif total > 0:
    lastwake = read_int(lastwake_path, 0)
    if added > 0 or now - lastwake >= COOLDOWN:
        decision, reason = "wake", "new_wechat_messages"
        payload = {"pending_file": pending, "pending_count": total, "added": added, "preview": preview, "fetch": fetch_note}
        write_int(lastwake_path, now)
    else:
        decision, reason = "silent", "re-wake cooldown"
        payload = {"fetch": fetch_note, "pending_count": total, "note": f"pending unchanged, next re-wake in {COOLDOWN - (now - lastwake)}s"}
else:
    decision, reason = "silent", "no new messages"
    payload = {"fetch": fetch_note}

with open(os.environ["DECISION_FILE"], "w") as f:
    f.write(f"{decision}\n{reason}\n")
with open(os.environ["PAYLOAD_FILE"], "w") as f:
    json.dump(payload, f, ensure_ascii=False)
print(fetch_note)
PYEOF

DECISION="$(sed -n '1p' "$DECISION_FILE")"
REASON="$(sed -n '2p' "$DECISION_FILE")"
PAYLOAD="$(cat "$PAYLOAD_FILE")"

log "poll" "$PAYLOAD"

if [ "$DECISION" = "wake" ]; then
  wake "$REASON" "$PAYLOAD"
else
  silent "$REASON" "$PAYLOAD"
fi
