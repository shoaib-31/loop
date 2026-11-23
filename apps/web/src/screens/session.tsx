// The live session view: streamed transcript + the decision UI + a composer.
// This is the screen a notification tap lands on, so it must work from a cold
// start with nothing but the id in the URL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { ArrowRightLeft, ArrowUp, Download, Square, TriangleAlert } from 'lucide-react';

import { Body, Centered, Header, Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/input';
import {
  buildQuestionState,
  PendingQuestionView,
  TurnView,
  type QuestionCtx,
} from '@/components/turn-view';
import { declineQuestion, handoffSession, interruptSession, listSessions, sendReply } from '@/lib/api';
import { toolUseCard } from '@/lib/tool-cards';
import { cn } from '@/lib/cn';
import { useBaseUrl } from '@/lib/config';
import type { AdoptedFrom, HandoffFrom, Turn } from '@/lib/types';
import { useSessionStream, type StreamStatus } from '@/lib/use-session-stream';

export function SessionScreen() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { baseUrl } = useBaseUrl();
  const { turns, pending, partial, working, busySince, lastActivity, status, error } = useSessionStream(
    baseUrl ?? null,
    id ?? null
  );

  const scrollRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * Where this session came from, if it was imported (docs/architecture.md).
   *
   * Fetched separately because the stream carries turns, not metadata, and there is no
   * single-session meta route — one list call is the same thing the home screen does. It is
   * worth the request: replies to an imported session are written into the conversation it
   * came from, and this is the screen where you type them.
   */
  const [meta, setMeta] = useState<{
    adoptedFrom: AdoptedFrom | null;
    handoffFrom: HandoffFrom | null;
    engine: string | null;
  }>({
    adoptedFrom: null,
    handoffFrom: null,
    engine: null,
  });
  useEffect(() => {
    if (!baseUrl || !id) return;
    let cancelled = false;
    setMeta({ adoptedFrom: null, handoffFrom: null, engine: null });
    listSessions(baseUrl, 200)
      .then((all) => {
        const s = all.find((x) => x.id === id);
        if (!cancelled)
          setMeta({
            adoptedFrom: s?.adoptedFrom ?? null,
            handoffFrom: s?.handoffFrom ?? null,
            engine: s?.engine ?? null,
          });
      })
      // A missing badge is not worth an error state — the transcript is what matters here.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl, id]);
  const { adoptedFrom, handoffFrom } = meta;
  // Name the agent you are actually talking to. Hard-coding "Claude" was wrong for every
  // Codex session, and an imported one makes it obvious — the transcript above says Codex
  // while the box invites you to reply to Claude.
  const agentName = meta.engine === 'codex' ? 'Codex' : 'Claude';
  const targetEngine = meta.engine === 'claude-code' ? 'codex' : meta.engine === 'codex' ? 'claude-code' : null;
  const targetName = targetEngine === 'codex' ? 'Codex' : targetEngine === 'claude-code' ? 'Claude' : null;

  const handoff = useCallback(async () => {
    if (!baseUrl || !id || !targetEngine || !targetName) return;
    const confirmed = window.confirm(
      `Continue this work in ${targetName}?\n\n${targetName} will start a new conversation in the same directory with this session's context. The current session stays available.`
    );
    if (!confirmed) return;
    setHandoffBusy(true);
    setSendError(null);
    try {
      const result = await handoffSession(baseUrl, id, targetEngine);
      // Do not replace: browser Back is the simplest, most honest link to the source side.
      navigate(`/session/${result.id}`);
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setHandoffBusy(false);
    }
  }, [baseUrl, id, navigate, targetEngine, targetName]);

  // Follow the stream, but only while the user is already at the bottom —
  // yanking the view down while they're reading history is worse than not
  // following at all. Kept in a ref so scrolling never triggers a re-render.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - (el.scrollTop + el.clientHeight) < 80;
  }, []);

  // Follow streaming text too, or the live sentence writes itself just below the fold.
  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, pending, partial?.text, working, error]);

  const stop = useCallback(async () => {
    if (!baseUrl || !id) return;
    setSendError(null);
    try {
      const r = await interruptSession(baseUrl, id);
      // A refusal is a fact about state, not a failure — say it plainly rather than
      // leaving a tapped button looking broken.
      if (!r.ok) setSendError(r.reason ?? 'nothing was running');
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, id]);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body || !baseUrl || !id) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await sendReply(baseUrl, id, body, true);
      setText('');
      if (res.warning) setSendError(res.warning); // soft advisory, not a failure
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [text, baseUrl, id]);

  // Answering a question = sending its option number down the same reply path a
  // typed message uses; the daemon maps the number to the option.
  const answerQuestion = useCallback(
    async (optionNumber: number) => {
      if (!baseUrl || !id) return;
      setSendError(null);
      try {
        const res = await sendReply(baseUrl, id, String(optionNumber), true);
        if (res.warning) setSendError(res.warning);
      } catch (e: unknown) {
        setSendError(e instanceof Error ? e.message : String(e));
      }
    },
    [baseUrl, id]
  );

  // DECLINE (docs/architecture.md): refuse the question and stop the turn, then hand
  // the human the composer — declining is only ever step one of "do this instead".
  const declineQ = useCallback(async () => {
    if (!baseUrl || !id) return;
    setSendError(null);
    try {
      const r = await declineQuestion(baseUrl, id);
      if (!r.ok) setSendError(r.warning ?? 'that question was already answered');
      composerRef.current?.focus();
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, id]);

  // Which questions exist and which are already answered (matched tool_use.id ↔
  // tool_result.tool_use_id). Rebuilt as turns stream in.
  const qState = useMemo(() => buildQuestionState(turns), [turns]);
  const ctx: QuestionCtx = useMemo(
    () => ({
      askIds: qState.askIds,
      answered: qState.answered,
      declined: qState.declined,
      onAnswer: answerQuestion,
    }),
    [qState, answerQuestion]
  );

  return (
    <Screen>
      <Header
        title={<StatusTitle status={status} />}
        back="/"
        right={targetEngine ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={handoff}
            disabled={handoffBusy || working || !!pending}
            aria-label={`Continue in ${targetName}`}
            title={working ? 'Stop or wait for the current turn before handing off' : `Continue in ${targetName}`}>
            {handoffBusy ? <Spinner className="size-4 text-current" /> : <ArrowRightLeft className="size-5" />}
          </Button>
        ) : null}
      />

      <Body ref={scrollRef} onScroll={onScroll} className="pt-3">
        {/* IMPORTED (PROBLEM 20). Said once, at the top, because it changes what typing here
            MEANS: the reply is appended to a conversation that also exists outside Loop-Eng,
            and will be there next time it's opened on the Mac. `truncated` is called out for
            the same reason — the agent has the whole thing even though this view doesn't. */}
        {adoptedFrom ? (
          <p className="bg-muted/60 text-muted-foreground mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[0.8125rem] leading-snug">
            <Download className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Imported from {adoptedFrom.engine === 'codex' ? 'Codex' : 'Claude Code'} — your
              replies go into that conversation too.
              {adoptedFrom.truncated ? ' Showing the most recent turns; the agent still has the full history.' : ''}
            </span>
          </p>
        ) : null}

        {handoffFrom ? (
          <p className="bg-primary/10 text-muted-foreground mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[0.8125rem] leading-snug">
            <ArrowRightLeft className="text-primary mt-0.5 size-3.5 shrink-0" />
            <span>
              Continued from {handoffFrom.engine === 'codex' ? 'Codex' : 'Claude Code'} with{' '}
              {handoffFrom.turnCount} turn{handoffFrom.turnCount === 1 ? '' : 's'} of context.{' '}
              <Link href={`/session/${handoffFrom.sessionId}`} className="text-primary font-semibold underline underline-offset-2">
                Open source session
              </Link>
            </span>
          </p>
        ) : null}

        {/* Only spin when there is genuinely nothing to show. A pending question
            with an empty transcript is the notification-tap case, and a spinner
            hovering above the decision would read as "not ready yet". */}
        {turns.length === 0 && !pending ? (
          <Centered>{error ? <p className="text-danger text-sm">{error}</p> : <Spinner />}</Centered>
        ) : (
          turns.map((turn, i) => <TurnView key={i} turn={turn} ctx={ctx} />)
        )}

        {/* IN-FLIGHT TEXT (docs/architecture.md). Rendered through the SAME TurnView
            as history, so a half-written sentence looks exactly like the sentence it
            becomes and there is no visual seam when the real turn replaces it. Never
            appended to `turns` — that's what would render it twice. */}
        {partial?.text ? (
          <div aria-live="polite" aria-busy="true">
            <TurnView
              turn={{ role: 'assistant', blocks: [{ kind: partial.kind, text: partial.text }], ts: null }}
              ctx={ctx}
            />
          </div>
        ) : null}

        {/* The decision the agent is waiting on right now — not yet in the
            transcript. Rendered last because it IS the current state. */}
        {pending ? (
          <div className="mt-2">
            <p className="text-warning mb-1.5 flex items-center gap-1.5 text-xs font-bold tracking-wider uppercase">
              <span className="bg-warning size-2 shrink-0 animate-pulse rounded-full" />
              Waiting for you
            </p>
            <PendingQuestionView question={pending} onAnswer={answerQuestion} onDecline={declineQ} />
          </div>
        ) : null}

        {/* WORKING (PROBLEM 23). Below the streaming text, like Claude Code's own spinner:
            proof the message arrived and something is happening — and, after a long silence,
            an honest "no output for 2m" instead of a screen that just looks frozen. */}
        {working && !pending ? (
          <WorkingIndicator since={busySince} lastActivity={lastActivity} partial={partial} turns={turns} />
        ) : null}

        {/* A failure must be SEEN. It used to render only on an empty transcript, so an
            agent that died after the first message just looked like it was thinking. */}
        {error && !working && turns.length > 0 ? (
          <p className="text-danger mt-3 flex items-start gap-1.5 text-[0.8125rem] leading-snug">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div ref={bottomRef} />
      </Body>

      <div className="pb-safe border-border bg-background/80 shrink-0 border-t backdrop-blur-xl">
        <div className="mx-auto w-full max-w-3xl px-3 pt-2">
          {sendError ? (
            <p className="text-danger mb-1 line-clamp-2 text-xs">{sendError}</p>
          ) : null}
          <form
            className="flex items-end gap-2 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}>
            <Textarea
              ref={composerRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends on a real keyboard; Shift+Enter is a newline. On a
                // phone the on-screen Return key inserts a newline as usual
                // (no keyboard modifier concept), so the button is the path there.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              // With a question parked, typing ANSWERS it (free text = "Other") — say so, since
              // Decline is the way to talk about something else instead.
              placeholder={pending ? 'Or type your own answer…' : `Reply to ${agentName}…`}
              rows={1}
              disabled={sending}
              className="max-h-36 min-h-11 flex-1 rounded-2xl"
            />
            {/* STOP (docs/architecture.md). Only while the agent is actually busy —
                a permanent Stop button that usually does nothing teaches you to distrust
                it. `working` rather than `partial` so it stays put through a long tool
                call, which produces no streaming text at all. Not a submit button, or
                Enter in the textarea would trigger it. */}
            {working && !pending ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={stop}
                aria-label="Stop"
                title="Stop what the agent is doing"
                className="text-danger shrink-0">
                <Square className="size-5 fill-current" />
              </Button>
            ) : null}
            <Button
              type="submit"
              size="icon"
              disabled={sending || !text.trim()}
              aria-label="Send"
              className={cn('shrink-0', !text.trim() && 'bg-muted text-muted-foreground')}>
              {sending ? <Spinner className="size-4 text-current" /> : <ArrowUp className="size-5" />}
            </Button>
          </form>
        </div>
      </div>
    </Screen>
  );
}

// The header doubles as the connection indicator: on a phone over a tailnet, "is
// this live or did my socket die?" is the question you always have.
function StatusTitle({ status }: { status: StreamStatus }) {
  const label = status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline';
  const dot =
    status === 'open' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger';
  return (
    <span className="flex items-center gap-2">
      <span className={cn('size-2 shrink-0 rounded-full', dot)} />
      {label}
    </span>
  );
}

/**
 * The "it's working, not stuck" row (docs/architecture.md).
 *
 * Says WHAT it's doing when that's knowable — a tool call with no result yet is the long,
 * silent part of most runs — and counts from the daemon's `since`, so the number is the
 * same on every client and doesn't reset on reconnect. After a stretch with no output it
 * says so, because "Working · 4m" is equally true of a long build and of a hang.
 */
function WorkingIndicator({
  since,
  lastActivity,
  partial,
  turns,
}: {
  since: string | null;
  lastActivity: number | null;
  partial: { kind: 'text' | 'thinking'; text: string } | null;
  turns: Turn[];
}) {
  const [now, setNow] = useState(() => Date.now());
  // Fallback start for a daemon that doesn't send `since`: when this row appeared.
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const started = since ? Date.parse(since) : mountedAt;
  const quietMs = lastActivity ? now - lastActivity : 0;
  const label = workingLabel(partial, turns);

  return (
    <div className="text-muted-foreground mt-3 flex items-center gap-2 text-[0.8125rem]" role="status">
      <Spinner className="text-primary size-4" />
      <span className="font-medium">{label}…</span>
      <span className="tabular-nums" aria-hidden>
        {formatElapsed(now - started)}
      </span>
      {quietMs >= QUIET_AFTER_MS ? (
        <span className="text-warning tabular-nums">· no output for {formatElapsed(quietMs)}</span>
      ) : null}
    </div>
  );
}

/** Long enough that a normal pause between tool calls never trips it. */
const QUIET_AFTER_MS = 45_000;

function workingLabel(partial: { kind: 'text' | 'thinking' } | null, turns: Turn[]): string {
  if (partial?.kind === 'thinking') return 'Thinking';
  if (partial?.kind === 'text') return 'Writing';
  // The newest tool call with no result after it is the thing running right now.
  const last = turns[turns.length - 1];
  const call = last?.role === 'assistant' ? [...last.blocks].reverse().find((b) => b.kind === 'tool_use') : null;
  if (call && call.kind === 'tool_use' && call.name !== 'AskUserQuestion')
    return `Running ${toolUseCard(call.name, call.input).title}`;
  return 'Working';
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
