// Import a conversation that started somewhere else (docs/architecture.md).
//
// Every Claude Code / Codex conversation on that machine, listed here so one can be adopted
// and continued from the phone. Adopting writes back INTO the original conversation, which is
// the point — start in the terminal, continue from bed — and is also why this screen makes
// two things unmissable:
//
//   1. THE WORKING DIRECTORY, on every row. Continuing a conversation runs the agent in that
//      directory and the daemon auto-allows every tool, so "which repo am I about to point
//      this at" is the most important fact on screen — not the title.
//   2. A CONFIRM STEP. Everywhere else in this app a tap navigates; here it asks first, for
//      the same reason. On a phone a mis-tap is one thumb-width away.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { AlertTriangle, Check, Download, FolderOpen, GitBranch, Search } from 'lucide-react';

import { Body, Centered, Header, Screen } from '@/components/screen';
import { Button, buttonClass } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { adoptConversation, listConversations, listEngines } from '@/lib/api';
import { useBaseUrl } from '@/lib/config';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import type { ForeignConversation } from '@/lib/types';

/** Runaway guards for the page walk below. Generous — these are local filesystem reads. */
const MAX_ROWS = 500;
const MAX_PAGES = 12;

export function ImportScreen() {
  const { baseUrl } = useBaseUrl();
  const [, navigate] = useLocation();
  const [rows, setRows] = useState<ForeignConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the page walk stopped early — a short list must not look complete. */
  const [capped, setCapped] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** The ref awaiting confirmation. Only one row can be armed at a time. */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Load EVERY page from every engine that can list conversations.
   *
   * All pages, not the first, because the search box below filters what was loaded — and a
   * search that only looks at the newest 50 of 179 conversations silently fails to find
   * things, which is worse than offering no search at all.
   */
  const load = useCallback(async () => {
    if (!baseUrl) return;
    setLoading(true);
    setError(null);
    setCapped(null);
    try {
      const engines = await listEngines(baseUrl);
      const usable = engines.filter((e) => e.available && e.canListConversations);
      if (usable.length === 0) {
        setRows([]);
        setError('No engine on this machine can list conversations.');
        return;
      }

      const all: ForeignConversation[] = [];
      let stoppedEarly = false;
      for (const e of usable) {
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          // The cursor is OPAQUE — hand back exactly what arrived, never build one.
          const r = await listConversations(baseUrl, { engine: e.id, cursor, limit: 100 });
          all.push(...r.conversations);
          cursor = r.nextCursor;
          if (!cursor) break;
          if (all.length >= MAX_ROWS || page === MAX_PAGES - 1) {
            stoppedEarly = true;
            break;
          }
        }
      }
      all.sort((a, b) => Date.parse(b.lastTs ?? '') - Date.parse(a.lastTs ?? ''));
      setRows(all);
      if (stoppedEarly) setCapped(`Showing the ${all.length} most recent — older ones aren't listed.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
  }, [load]);

  // Matching the DIRECTORY as well as the title is the point: "the daemon conversation" and
  // "everything in Loop" are both things you'd search for, and only one is a title.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => `${c.title} ${c.cwd ?? ''} ${c.engine}`.toLowerCase().includes(q));
  }, [rows, query]);

  const adopt = useCallback(
    async (c: ForeignConversation) => {
      if (!baseUrl || busy) return;
      setBusy(true);
      setError(null);
      try {
        const r = await adoptConversation(baseUrl, { engine: c.engine, ref: c.ref });
        navigate(`/session/${r.id}`);
      } catch (e: unknown) {
        // A 409 is the conversation's directory having gone away — a fact about state, shown
        // verbatim because the message names the path and what to do about it.
        setError(e instanceof Error ? e.message : String(e));
        setArmed(null);
      } finally {
        setBusy(false);
      }
    },
    [baseUrl, busy, navigate]
  );

  if (!baseUrl) {
    return (
      <Screen>
        <Header title="Import" back="/" />
        <Body>
          <Centered>
            <p className="text-muted-foreground text-[0.9375rem]">Set your daemon address first.</p>
          </Centered>
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Import a conversation" back="/" />
      <Body>
        <p className="text-muted-foreground mt-3 text-[0.875rem] leading-snug">
          Conversations you started elsewhere. Importing one lets you read it here and keep
          going — your replies go into that same conversation.
        </p>

        <label className="bg-card mt-3 flex items-center gap-2 rounded-xl px-3 py-2">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or folder"
            className="min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        {error ? (
          <p className="bg-danger/15 text-danger mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[0.8125rem]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        {capped ? (
          <p className="text-muted-foreground mt-3 rounded-xl px-1 text-[0.8125rem]">{capped}</p>
        ) : null}

        {filtered.length === 0 ? (
          <Centered>
            {loading ? (
              <Spinner />
            ) : (
              <p className="text-muted-foreground text-[0.9375rem]">
                {rows.length === 0 ? 'No conversations found.' : 'Nothing matches that search.'}
              </p>
            )}
          </Centered>
        ) : (
          <>
            <p className="text-muted-foreground mt-3 px-1 text-[0.75rem] font-bold tracking-wider uppercase">
              {filtered.length === rows.length
                ? `${rows.length} conversation${rows.length === 1 ? '' : 's'}`
                : `${filtered.length} of ${rows.length}`}
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {filtered.map((c) => (
                <li key={`${c.engine}:${c.ref}`}>
                  <ConversationRow
                    conversation={c}
                    armed={armed === c.ref}
                    busy={busy}
                    onArm={() => setArmed(c.ref)}
                    onCancel={() => setArmed(null)}
                    onConfirm={() => adopt(c)}
                    onOpen={() => navigate(`/session/${c.adoptedAs}`)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </Body>
    </Screen>
  );
}

/**
 * A path whose END survives narrowing: the leading segments ellipsize, the last two always
 * show. Two flex spans, not `dir="rtl"`.
 *
 * `dir="rtl"` is the tempting one-liner and it is WRONG — it reorders the leading slash to
 * the end, so `/tmp/loop-fixture` renders as `tmp/loop-fixture/`. That was invisible in the
 * DOM text and obvious the moment the screenshot was looked at, which is the whole reason
 * browser-check writes PNGs. Getting a path subtly wrong is not acceptable on the one field
 * that says which directory an agent is about to be pointed at.
 */
function PathTail({ path }: { path: string | null }) {
  if (!path) return <span className="truncate">no folder recorded</span>;
  const parts = path.split('/').filter(Boolean);
  const keep = parts.slice(-2);
  const head = parts.slice(0, -2);
  return (
    <span className="flex min-w-0 items-center">
      {head.length ? <span className="truncate">/{head.join('/')}</span> : null}
      <span className="shrink-0">/{keep.join('/')}</span>
    </span>
  );
}

function ConversationRow({
  conversation: c,
  armed,
  busy,
  onArm,
  onCancel,
  onConfirm,
  onOpen,
}: {
  conversation: ForeignConversation;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOpen: () => void;
}) {
  const when = timeAgo(c.lastTs);
  const imported = !!c.adoptedAs;

  return (
    <div
      className={cn(
        'bg-card rounded-xl p-3 transition',
        armed && 'border-primary/40 ring-primary/10 border ring-4'
      )}>
      {/* The whole row is the tap target, so the confirm is reachable one-handed. Already
          imported → tapping OPENS it: nothing is being pointed anywhere new, and adopting
          twice would only return the same session anyway. */}
      <button
        type="button"
        onClick={imported ? onOpen : armed ? onCancel : onArm}
        className="block w-full text-left">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-bold">{c.title}</span>
          {when ? (
            <span className="text-muted-foreground shrink-0 text-[0.8125rem]">{when}</span>
          ) : null}
        </div>

        <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 font-bold',
              c.engine === 'codex' ? 'bg-muted text-foreground/80' : 'bg-primary/15 text-primary'
            )}>
            {c.engine === 'codex' ? 'Codex' : 'Claude'}
          </span>
          {imported ? (
            <span className="text-success inline-flex items-center gap-1 font-bold">
              <Check className="size-3" /> imported
            </span>
          ) : null}
          {c.gitBranch ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{c.gitBranch}</span>
            </span>
          ) : null}
        </div>

        {/* THE DIRECTORY. Shown on every row, and it's the TAIL that must survive narrowing —
            `/Users/you/Developer` identifies nothing; the last segments identify everything. */}
        <div className="text-muted-foreground mt-1 flex items-center gap-1 font-mono text-xs">
          <FolderOpen className="size-3 shrink-0" />
          <PathTail path={c.cwd} />
        </div>
      </button>

      {armed && !imported ? (
        <div className="border-border mt-3 border-t pt-3">
          <p className="text-[0.875rem] leading-snug">
            Import this and run the agent in{' '}
            <span className="font-mono font-bold break-all">{c.cwd ?? 'an unknown folder'}</span>?
          </p>
          <p className="text-muted-foreground mt-1 text-[0.8125rem] leading-snug">
            Your replies are added to this conversation, so they'll be there next time you open
            it on your Mac too.
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={onConfirm} disabled={busy} className="flex-1">
              {busy ? <Spinner /> : <Download className="size-4" />}
              Import
            </Button>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className={buttonClass({ variant: 'ghost' })}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
