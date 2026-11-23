// The home screen: every Claude session the daemon can see, newest first. Tapping
// one opens the live view. Refreshes on mount and whenever the app regains focus,
// so coming back from a session (or from a notification) shows current state.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Download, GitBranch, Plus, Settings } from 'lucide-react';

import { InlineMarkdown } from '@/components/markdown';
import { Body, Centered, Header, Screen } from '@/components/screen';
import { buttonClass } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { listSessions } from '@/lib/api';
import { useBaseUrl } from '@/lib/config';
import { baseName, timeAgo } from '@/lib/format';
import type { SessionSummary } from '@/lib/types';

export function SessionsScreen() {
  const { baseUrl } = useBaseUrl();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!baseUrl) return;
    setLoading(true);
    setError(null);
    try {
      setSessions(await listSessions(baseUrl, 50));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  // Reload on mount and whenever the app comes back to the foreground — the
  // standalone PWA is resumed far more often than it's cold-started, and a stale
  // list is how you miss that an agent is now waiting on you.
  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const gear = (
    <Link href="/settings" aria-label="Settings" className={buttonClass({ variant: 'ghost', size: 'icon' })}>
      <Settings className="size-5" />
    </Link>
  );

  // No daemon address yet → the app can't do anything, so say so plainly and
  // point at the one screen that fixes it.
  if (!baseUrl) {
    return (
      <Screen>
        <Header title="Loop" right={gear} />
        <Body>
          <Centered>
            <h2 className="text-xl font-bold">Connect your Mac</h2>
            <p className="text-muted-foreground max-w-xs text-[0.9375rem] leading-relaxed">
              Set your daemon address to see your Claude sessions and get pinged for decisions.
            </p>
            <Link href="/settings" className={buttonClass({ className: 'mt-1' })}>
              Open Settings
            </Link>
          </Centered>
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="Loop"
        right={
          <>
            <Link
              href="/new"
              aria-label="New session"
              className={buttonClass({ variant: 'ghost', size: 'icon' })}>
              <Plus className="size-6" />
            </Link>
            {gear}
          </>
        }
      />
      <Body>
        {error ? (
          <p className="bg-danger/15 text-danger mt-3 rounded-xl px-3 py-2 text-[0.8125rem]">
            {error}
          </p>
        ) : null}

        {sessions.length === 0 ? (
          <Centered>
            {loading ? (
              <Spinner />
            ) : (
              <>
                <p className="text-muted-foreground text-[0.9375rem]">No sessions yet.</p>
                <Link href="/new" className={buttonClass()}>
                  Start one
                </Link>
                {/* The empty state is exactly where importing matters most: a fresh install
                    has no sessions of its own, but the Mac is usually full of conversations
                    already (PROBLEM 20). */}
                <Link href="/import" className={buttonClass({ variant: 'ghost' })}>
                  Import an existing one
                </Link>
              </>
            )}
          </Centered>
        ) : (
          <>
            <ul className="mt-3 flex flex-col gap-2">
              {sessions.map((s) => (
                <li key={s.id}>
                  <SessionRow session={s} />
                </li>
              ))}
            </ul>
            <Link
              href="/import"
              className={buttonClass({ variant: 'ghost', className: 'mt-3 w-full' })}>
              <Download className="size-4" />
              Import a conversation
            </Link>
          </>
        )}
      </Body>
    </Screen>
  );
}

function SessionRow({ session }: { session: SessionSummary }) {
  const project = session.projectName ?? baseName(session.cwd) ?? session.projectLabel;
  // Claude's own title when it has one, so the row reads like `claude --resume` does;
  // the project then moves down to the meta line instead of disappearing.
  const name = session.title || project;
  const when = timeAgo(session.lastTs ?? null);
  const speaker = session.lastRole === 'assistant'
    ? session.engine === 'codex' ? 'Codex' : 'Claude'
    : 'You';

  return (
    <Link
      href={`/session/${session.id}`}
      className="bg-card hover:bg-muted/60 active:bg-muted block rounded-xl p-3 transition">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-bold">{name}</span>
        {when ? (
          <span className="text-muted-foreground shrink-0 text-[0.8125rem]">{when}</span>
        ) : null}
      </div>
      {session.title || session.gitBranch ? (
        <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1 font-mono text-xs">
          {session.title ? <span className="shrink-0">{project}</span> : null}
          {session.gitBranch ? (
            <>
              <GitBranch className="ml-1 size-3 shrink-0" />
              <span className="truncate">{session.gitBranch}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {session.preview ? (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-[0.875rem] leading-snug">
          <span className="font-bold">{speaker}: </span>
          <InlineMarkdown content={session.preview} />
        </p>
      ) : null}
    </Link>
  );
}
