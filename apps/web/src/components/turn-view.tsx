// One assistant/user turn = a stack of block views. Assistant text is markdown;
// tool calls/results are compact cards you can tap to expand; thinking is dim and
// collapsed by default. AskUserQuestion is special: it renders as tappable option
// buttons — that IS the product (buzz → tap → answer).

import { useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Globe,
  Pencil,
  Plug,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';

import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/cn';
import { parseQuestions, toolResultPreview, toolUseCard, type ToolIcon } from '@/lib/tool-cards';
import type { Block, PendingQuestion, Turn } from '@/lib/types';

// Session-wide question state, threaded down so a question knows whether it's
// still pending (tappable) or already answered (shown, disabled), and so the raw
// tool_result that answers it can be suppressed (the card shows the answer).
export type QuestionCtx = {
  askIds: Set<string>; // ids of AskUserQuestion tool_use blocks
  answered: Map<string, string>; // askId -> the answer result text
  // askIds whose answer was a REFUSAL (an is_error result): declined here (PROBLEM 23), or
  // rejected in Claude's own TUI before the conversation was imported — both read the same.
  declined?: Set<string>;
  onAnswer: (optionNumber: number) => void | Promise<void>;
};

// Build QuestionCtx (minus onAnswer) from all turns: which AskUserQuestion tool
// calls exist, and which have a matching tool_result (= already answered).
export function buildQuestionState(turns: Turn[]): {
  askIds: Set<string>;
  answered: Map<string, string>;
  declined: Set<string>;
} {
  const askIds = new Set<string>();
  for (const t of turns)
    for (const b of t.blocks)
      if (b.kind === 'tool_use' && b.name === 'AskUserQuestion' && b.id) askIds.add(b.id);
  const answered = new Map<string, string>();
  const declined = new Set<string>();
  for (const t of turns)
    for (const b of t.blocks)
      if (b.kind === 'tool_result' && b.tool_use_id && askIds.has(b.tool_use_id)) {
        answered.set(b.tool_use_id, b.text ?? '');
        if (b.is_error) declined.add(b.tool_use_id);
      }
  return { askIds, answered, declined };
}

const TOOL_ICONS: Record<ToolIcon, typeof Terminal> = {
  terminal: Terminal,
  file: FileText,
  pencil: Pencil,
  search: Search,
  globe: Globe,
  bot: Bot,
  check: Check,
  question: CircleHelp,
  plug: Plug,
  tool: Wrench,
};

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="text-muted-foreground hover:text-foreground block w-full text-left transition">
      <span className="inline-flex items-center gap-1 text-xs italic">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        thinking
      </span>
      {open ? <p className="mt-1 text-[0.8125rem] leading-relaxed italic">{text}</p> : null}
    </button>
  );
}

// The decision UI. One AskUserQuestion tool_use → one or more questions, each a
// set of tappable options. Tapping option i sends its 1-based number, which is
// what the daemon's reply path expects. Disabled once answered.
function QuestionCard({
  block,
  ctx,
  onDecline,
}: {
  block: Extract<Block, { kind: 'tool_use' }>;
  ctx?: QuestionCtx;
  /** Only the LIVE card can be declined — a decline goes to the question that's parked. */
  onDecline?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const questions = parseQuestions(block.input);
  const answerText = block.id ? ctx?.answered.get(block.id) : undefined;
  const isAnswered = answerText != null;
  const isDeclined = isAnswered && !!block.id && !!ctx?.declined?.has(block.id);

  const decline = async () => {
    if (isAnswered || busy || !onDecline) return;
    setBusy(true);
    try {
      await onDecline();
    } finally {
      setBusy(false);
    }
  };

  const pick = async (optionNumber: number) => {
    if (isAnswered || busy || !ctx) return;
    setBusy(true);
    try {
      await ctx.onAnswer(optionNumber);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-card border p-4',
        // An unanswered question is the one thing in the app that must never be
        // scrolled past. It gets the accent ring; everything else stays grey.
        isAnswered ? 'bg-card border-border' : 'bg-card border-primary/40 ring-primary/10 ring-4'
      )}>
      {questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? 'mt-5' : undefined}>
          {q.header ? (
            <p className="text-muted-foreground mb-1 text-[0.6875rem] font-bold tracking-wider uppercase">
              {q.header}
            </p>
          ) : null}
          <p className="mb-3 text-base leading-snug font-bold">{q.question}</p>

          <div className="flex flex-col gap-2">
            {/* The daemon numbers each question's options from 1, so an option's
                number is its index WITHIN its question, not a running total. */}
            {q.options.map((opt, oi) => {
              const n = oi + 1;
              // A refusal's text is not an answer, so it must never light an option up.
              const chosen = isAnswered && !isDeclined && answerText!.includes(opt.label);
              return (
                <button
                  key={n}
                  disabled={isAnswered || busy || !ctx}
                  onClick={() => pick(n)}
                  className={cn(
                    'rounded-xl border px-4 py-3 text-left transition',
                    'disabled:cursor-default',
                    chosen
                      ? 'border-success bg-success/10'
                      : isAnswered
                        ? 'border-border opacity-40'
                        : 'border-border hover:border-primary/60 hover:bg-muted/50 active:bg-muted'
                  )}>
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-[0.9375rem] font-semibold',
                      chosen && 'text-success'
                    )}>
                    {chosen ? <Check className="size-4 shrink-0" /> : null}
                    {opt.label}
                  </span>
                  {opt.description ? (
                    <span className="text-muted-foreground mt-0.5 block text-[0.8125rem] leading-snug">
                      {opt.description}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {!isAnswered ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs italic">
            {ctx ? (busy ? 'Sending…' : 'Tap an option to answer') : 'Read-only'}
          </p>
          {/* DECLINE (PROBLEM 23): "wrong question" is a real answer to a question, and the
              only other way out used to be answering it with free text — which the agent
              then treats AS the answer and carries on. This stops it instead. */}
          {onDecline ? (
            <button
              type="button"
              onClick={decline}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground active:bg-muted -my-1 -mr-2 shrink-0 rounded-lg px-2 py-1 text-xs font-semibold transition disabled:opacity-50">
              Decline
            </button>
          ) : null}
        </div>
      ) : isDeclined ? (
        <p className="text-muted-foreground mt-3 flex items-center gap-1 text-xs font-semibold">
          <X className="size-3.5" />
          Declined
        </p>
      ) : null}
    </div>
  );
}

// A question the agent is waiting on RIGHT NOW (a live `pending` frame — it isn't
// in the transcript yet). Rendered through the very same QuestionCard by
// synthesizing a tool_use block in the shape parseQuestions() expects, plus a
// fresh ctx with nothing answered so every option is tappable.
export function PendingQuestionView({
  question,
  onAnswer,
  onDecline,
}: {
  question: PendingQuestion;
  onAnswer: (optionNumber: number) => void | Promise<void>;
  onDecline?: () => void | Promise<void>;
}) {
  const block: Extract<Block, { kind: 'tool_use' }> = {
    kind: 'tool_use',
    id: '__pending__',
    name: 'AskUserQuestion',
    input: { questions: [question] },
  };
  const ctx: QuestionCtx = { askIds: new Set(), answered: new Map(), onAnswer };
  return <QuestionCard block={block} ctx={ctx} onDecline={onDecline} />;
}

function ToolUseBlock({ block }: { block: Extract<Block, { kind: 'tool_use' }> }) {
  const [open, setOpen] = useState(false);
  const card = toolUseCard(block.name, block.input);
  const Icon = TOOL_ICONS[card.icon];
  const inputStr = safeJson(block.input);

  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="bg-card hover:bg-muted/50 block w-full rounded-xl px-3 py-2.5 text-left transition">
      <span className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-[0.8125rem] font-bold">{card.title}</span>
        {card.subtitle ? (
          <span
            className={cn(
              'text-muted-foreground min-w-0 flex-1 font-mono text-[0.8125rem]',
              open ? 'break-all' : 'truncate'
            )}>
            {card.subtitle}
          </span>
        ) : null}
      </span>
      {open && inputStr ? (
        <pre className="text-muted-foreground mt-2 overflow-x-auto font-mono text-[0.75rem] leading-relaxed whitespace-pre-wrap">
          {inputStr}
        </pre>
      ) : null}
    </button>
  );
}

function ToolResultBlock({ block }: { block: Extract<Block, { kind: 'tool_result' }> }) {
  const [open, setOpen] = useState(false);
  const multiline = (block.text ?? '').split('\n').length > 1;

  return (
    <button
      onClick={() => multiline && setOpen((o) => !o)}
      className={cn(
        'block w-full border-l-2 py-0.5 pl-3 text-left',
        block.is_error ? 'border-danger' : 'border-border',
        multiline && 'hover:border-muted-foreground transition'
      )}>
      <span
        className={cn(
          'flex items-center gap-1 text-[0.6875rem] font-semibold tracking-wider uppercase',
          block.is_error ? 'text-danger' : 'text-muted-foreground'
        )}>
        {block.is_error ? <TriangleAlert className="size-3" /> : null}
        result
        {multiline ? (
          open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )
        ) : null}
      </span>
      <span
        className={cn(
          'text-muted-foreground mt-0.5 block font-mono text-[0.78125rem] leading-relaxed',
          open ? 'whitespace-pre-wrap' : 'line-clamp-2'
        )}>
        {open ? block.text : toolResultPreview(block.text, block.is_error)}
      </span>
    </button>
  );
}

function BlockView({ block, ctx }: { block: Block; ctx?: QuestionCtx }) {
  switch (block.kind) {
    case 'text':
      return <Markdown content={block.text} />;
    case 'thinking':
      return <ThinkingBlock text={block.text} />;
    case 'tool_use':
      // The decision moment gets buttons, not a JSON card.
      if (block.name === 'AskUserQuestion') return <QuestionCard block={block} ctx={ctx} />;
      return <ToolUseBlock block={block} />;
    case 'tool_result':
      // The tool_result that answers a question is shown inside the QuestionCard
      // (as the highlighted choice) — don't also dump its raw JSON here.
      if (block.tool_use_id && ctx?.askIds.has(block.tool_use_id)) return null;
      return <ToolResultBlock block={block} />;
    default:
      return null;
  }
}

export function TurnView({ turn, ctx }: { turn: Turn; ctx?: QuestionCtx }) {
  const isUser = turn.role === 'user';
  // A user turn that's only a tool_result is really part of the assistant's tool
  // loop, not a human message — render it plainly, not as a "you" bubble. (An
  // answer to a question is a tool_result too, so it also stays non-human.)
  const onlyToolResults =
    turn.blocks.length > 0 && turn.blocks.every((b) => b.kind === 'tool_result');
  const showAsHuman = isUser && !onlyToolResults;

  if (showAsHuman) {
    return (
      <div className="mb-4 flex justify-end">
        <div className="bg-muted max-w-[88%] rounded-2xl px-3.5 py-2">
          {turn.blocks.map((b, i) => (
            <BlockView key={i} block={b} ctx={ctx} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      {turn.blocks.map((b, i) => (
        <BlockView key={i} block={b} ctx={ctx} />
      ))}
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
