#!/bin/bash
# Loop-Eng v0 notify hook.
#
# Fires on Claude Code hook events (Notification, Stop, ...) and:
#   1. Logs the full event (for the idle_prompt empirical test) to NOTIFY_LOG.
#   2. Pushes a phone notification via ntfy so you know Claude wants you.
#
# SAFETY: this script ALWAYS exits 0. A Stop hook can block Claude on a
# non-zero exit; a notifier must never do that. It also only ever reads the
# event JSON on stdin — it never touches your env/secrets.
#
# Config: copy notify.config.example -> notify.config and set NTFY_TOPIC.
# Referenced from ~/.claude/settings.json by absolute path.

# --- resolve script dir so config/log paths are stable regardless of cwd ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# defaults (overridable in notify.config)
NTFY_SERVER="https://ntfy.sh"
NTFY_TOPIC=""
NOTIFY_LOG="$SCRIPT_DIR/notify.log"

# load local config if present (gitignored; holds the private topic)
[ -f "$SCRIPT_DIR/notify.config" ] && . "$SCRIPT_DIR/notify.config"

# read the event JSON from stdin (hooks pipe it in)
INPUT="$(cat)"

# everything below is best-effort and must never fail the script
{
  ts="$(date '+%Y-%m-%d %H:%M:%S')"

  event="$(printf '%s' "$INPUT"    | jq -r '.hook_event_name // "?"' 2>/dev/null)"
  ntype="$(printf '%s' "$INPUT"    | jq -r '.notification_type // ""' 2>/dev/null)"
  message="$(printf '%s' "$INPUT"  | jq -r '.message // ""' 2>/dev/null)"
  cwd="$(printf '%s' "$INPUT"      | jq -r '.cwd // ""' 2>/dev/null)"
  transcript="$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)"
  session_id="$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)"

  # --- record session_id -> tmux pane so the app can inject replies ---
  # The hook runs as a child of the Claude process, so it inherits $TMUX_PANE
  # (the stable pane id, e.g. "%29"). This is the ONLY reliable bridge from a
  # session id to its pane: interactive `claude` doesn't carry the id in argv,
  # and cwd is ambiguous when several sessions share one directory.
  # One file per session (no shared-file race between concurrent sessions).
  if [ -n "$session_id" ] && [ -n "$TMUX_PANE" ]; then
    reg_dir="${LOOP_ENG_STATE:-$HOME/.loop-eng}/panes"
    mkdir -p "$reg_dir" 2>/dev/null && \
    jq -n --arg pane "$TMUX_PANE" --arg tmux "$TMUX" --arg cwd "$cwd" \
          --arg sid "$session_id" --arg ts "$ts" \
      '{session_id:$sid, pane:$pane, tmux:$tmux, cwd:$cwd, updated:$ts}' \
      > "$reg_dir/$session_id.json" 2>/dev/null
  fi

  # --- diagnostic log: the whole point of the empirical test phase ---
  {
    echo "===== $ts  event=$event  type=$ntype ====="
    echo "message: $message"
    echo "cwd: $cwd"
    echo "raw: $INPUT"
  } >> "$NOTIFY_LOG" 2>/dev/null

  # --- best-effort: pull Claude's actual last words from the transcript ---
  # so the push says WHAT it's asking, not just "come look".
  last_text=""
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    last_text="$(tail -n 40 "$transcript" 2>/dev/null \
      | jq -rs '
          [ .[]
            | select(.type=="assistant")
            | (.message.content // [])
            | if type=="array" then (map(select(.type=="text").text) | join(" ")) else tostring end
          ] | map(select(. != "")) | last // ""' 2>/dev/null)"
  fi

  # build the push body: prefer Claude's last words, fall back to message
  body="$last_text"
  [ -z "$body" ] && body="$message"
  [ -z "$body" ] && body="Claude wants your attention ($event${ntype:+/$ntype})"

  project="$(basename "$cwd" 2>/dev/null)"
  title="Claude: ${project:-session} [$event${ntype:+/$ntype}]"

  # --- decide whether this event is worth a phone buzz ---
  # Only "come look / decide" signals push. Stop fires on EVERY turn end
  # (and would push the whole last message) — too noisy, so log-only.
  should_push=0
  case "$event" in
    Notification)
      case "$ntype" in
        idle_prompt|permission_prompt|agent_needs_input) should_push=1 ;;
      esac
      ;;
  esac

  # --- push to phone (only for wanted events, only if a topic is configured) ---
  if [ "$should_push" = 1 ] && [ -n "$NTFY_TOPIC" ]; then
    curl -sS --max-time 8 \
      -H "Title: $title" \
      -H "Tags: robot" \
      -d "$body" \
      "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null 2>&1
  fi
} 2>/dev/null

exit 0
