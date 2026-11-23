// React hook driving the live session view. Opens the WS stream, seeds from the
// history frame, appends live turns, and exposes connection status. Falls back
// to a one-shot HTTP history fetch if the socket can't establish.

import { useEffect, useRef, useState } from "react";

import { getHistory, getPending, openStream } from "./api";
import type { PendingQuestion, Turn } from "./types";

export type StreamStatus = "connecting" | "open" | "closed";

export function useSessionStream(baseUrl: string | null, sessionId: string | null) {
  const [turns, setTurns] = useState<Turn[]>([]);
  // A decision Claude is waiting on RIGHT NOW (read from the live pane, not the
  // transcript). Rendered as tappable options; cleared when the menu closes.
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  // In-flight text (docs/architecture.md). Deliberately separate from `turns`: the
  // completed turn is the record, this is only what to show while waiting for it.
  const [partial, setPartial] = useState<{ kind: "text" | "thinking"; text: string } | null>(null);
  // Is the agent busy right now? Tracked separately from `partial` because a long tool
  // call emits no text at all, and a Stop control that disappears during the slowest part
  // of a run is a Stop control that isn't there when you want it.
  const [working, setWorking] = useState(false);
  // When the current turn began, per the daemon — so the elapsed time is the same on every
  // client and survives a reconnect. Null when idle, or when the daemon predates `busy`.
  const [busySince, setBusySince] = useState<string | null>(null);
  // When the stream last showed a sign of life (a turn or a delta). "Working · 3m" alone
  // can't tell a long build from a hang; "no output for 3m" can (PROBLEM 23).
  const [lastActivity, setLastActivity] = useState<number | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const total = useRef(0);

  useEffect(() => {
    if (!baseUrl || !sessionId) return;
    setTurns([]);
    setPending(null);
    setPartial(null);
    setWorking(false);
    setBusySince(null);
    setLastActivity(null);
    setError(null);
    total.current = 0;
    // Once the daemon has spoken about `busy`, it alone decides. Before that (an older
    // daemon), the event-shaped guesses below are all there is.
    let authoritative = false;
    const guessWorking = (w: boolean) => { if (!authoritative) setWorking(w); };
    let httpFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let gotAnything = false;
    let wsOpen = false;

    const close = openStream(
      baseUrl,
      sessionId,
      {
        onHistory: (hist, t) => {
          gotAnything = true;
          total.current = t;
          setTurns(hist);
        },
        onTurn: (turn) => {
          gotAnything = true;
          setTurns((prev) => [...prev, turn]);
          setLastActivity(Date.now());
          guessWorking(true);
        },
        // A parked question means the agent is waiting on YOU, not working — so there is
        // nothing to stop.
        onPending: (q) => {
          setPending(q);
          if (q) guessWorking(false);
        },
        onPartial: (p) => {
          setPartial(p);
          if (p) {
            setLastActivity(Date.now());
            guessWorking(true);
          }
        },
        onQuiet: () => guessWorking(false),
        onBusy: (b, since, activityAt) => {
          authoritative = true;
          setWorking(b);
          setBusySince(since);
          // The daemon's own last-activity time, so a page opened mid-silence sees the real
          // silence rather than one that started when it connected. A busy frame also clears
          // a stale error: the agent is evidently working again.
          if (b) {
            setLastActivity(activityAt ? Date.parse(activityAt) : Date.now());
            setError(null);
          }
        },
        onError: (e) => setError(e),
        onStatus: (s) => {
          setStatus(s);
          wsOpen = s === "open";
        },
      },
      {}
    );

    // If the socket hasn't delivered anything shortly, pull history over HTTP so
    // the view isn't blank (e.g. WS blocked but HTTP fine).
    httpFallbackTimer = setTimeout(async () => {
      if (gotAnything) return;
      try {
        const hist = await getHistory(baseUrl, sessionId);
        if (!gotAnything) setTurns(hist);
      } catch (e: unknown) {
        if (!gotAnything) setError(e instanceof Error ? e.message : String(e));
      }
    }, 2500);

    // Pending-question fallback: while the socket ISN'T open, poll the pane over
    // HTTP so a WS-blocked phone still sees decisions. When WS is open its
    // `pending` frames are the source of truth and this poll stands down.
    const pendingPoll = setInterval(async () => {
      if (wsOpen) return;
      try {
        setPending(await getPending(baseUrl, sessionId));
      } catch {
        /* best-effort; leave last known pending in place */
      }
    }, 3000);

    return () => {
      if (httpFallbackTimer) clearTimeout(httpFallbackTimer);
      clearInterval(pendingPoll);
      close();
    };
  }, [baseUrl, sessionId]);

  return { turns, pending, partial, working, busySince, lastActivity, status, error };
}
