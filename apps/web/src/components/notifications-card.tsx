// The opt-in for the whole product thesis: buzz → tap → answer.
//
// This card carries more weight than a normal settings toggle, because on iOS the
// failure modes are non-obvious and look permanent when they aren't. The single
// most common state is "PushManager is missing" — which really means "you haven't
// added it to the Home Screen yet". So this deliberately reports its own
// capabilities and names the exact next action instead of just disabling a switch.
// (Diagnostics-first is what made the spike debuggable — docs/architecture.md.)

import { useCallback, useEffect, useState } from 'react';

import { Card, SectionLabel } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/cn';
import {
  currentSubscription,
  pushCapabilities,
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  type PushCapabilities,
} from '@/lib/push';

type State =
  | { kind: 'loading' }
  | { kind: 'off'; caps: PushCapabilities }
  | { kind: 'working' }
  | { kind: 'on'; host: string }
  | { kind: 'error'; message: string; caps: PushCapabilities };

export function NotificationsCard({ baseUrl }: { baseUrl: string | null }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    const caps = pushCapabilities();
    // Register eagerly so `getSubscription()` has a registration to read, and so
    // the worker is already active by the time the user taps Enable.
    if (caps.serviceWorker) await registerServiceWorker();
    const sub = await currentSubscription();
    if (sub) {
      setState({ kind: 'on', host: new URL(sub.endpoint).host });
      return;
    }
    setState({ kind: 'off', caps });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = async () => {
    if (!baseUrl) {
      setState({
        kind: 'error',
        message: 'Set the daemon address first.',
        caps: pushCapabilities(),
      });
      return;
    }
    setState({ kind: 'working' });
    try {
      // Must stay inside this handler: iOS requires requestPermission() to be
      // driven by a user gesture, and an await chain before it can break that.
      const sub = await subscribeToPush(baseUrl);
      setState({ kind: 'on', host: new URL(sub.endpoint).host });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        caps: pushCapabilities(),
      });
    }
  };

  const disable = async () => {
    setState({ kind: 'working' });
    try {
      if (baseUrl) await unsubscribeFromPush(baseUrl);
    } finally {
      await refresh();
    }
  };

  const caps = state.kind === 'off' || state.kind === 'error' ? state.caps : null;

  return (
    <section className="mt-6 flex flex-col gap-2">
      <SectionLabel>Notifications</SectionLabel>
      <Card className="flex flex-col gap-2">
        {state.kind === 'loading' || state.kind === 'working' ? (
          <Spinner />
        ) : state.kind === 'on' ? (
          <>
            <h3 className="font-bold">Notifications are on</h3>
            <p className="text-muted-foreground text-[0.875rem] leading-relaxed">
              Loop will buzz this device when an agent needs a decision. Tap the banner to answer.
            </p>
            {/* The endpoint host is the single most useful diagnostic we have:
                `web.push.apple.com` is proof iOS is genuinely wired up. */}
            <p className="text-muted-foreground font-mono text-xs">via {state.host}</p>
            <Button variant="secondary" onClick={disable} className="mt-1">
              Turn off
            </Button>
          </>
        ) : (
          <>
            <h3 className="font-bold">
              {state.kind === 'error' ? "Couldn't enable notifications" : 'Get pinged for decisions'}
            </h3>
            <p className="text-muted-foreground text-[0.875rem] leading-relaxed">
              {state.kind === 'error'
                ? state.message
                : (caps?.blocker ??
                  'Your phone buzzes the moment an agent needs an answer — even with the Mac asleep.')}
            </p>

            {caps?.ready ? (
              <Button onClick={enable} className="mt-1">
                Enable notifications
              </Button>
            ) : null}

            {caps ? <Diagnostics caps={caps} /> : null}
          </>
        )}
      </Card>
    </section>
  );
}

// Shown only when something is wrong, so the user (and we) can see WHICH link in
// the chain broke rather than guessing.
function Diagnostics({ caps }: { caps: PushCapabilities }) {
  const rows: [string, boolean, string][] = [
    ['Secure (HTTPS)', caps.secureContext, caps.secureContext ? 'yes' : 'no'],
    ['Added to Home Screen', caps.standalone, caps.standalone ? 'yes' : 'no'],
    ['Push support', caps.pushManager, caps.pushManager ? 'yes' : 'no'],
    ['Permission', caps.permission === 'granted', String(caps.permission)],
  ];
  return (
    <dl className="border-border mt-2 flex flex-col gap-0.5 border-t pt-3">
      {rows.map(([k, ok, v]) => (
        <div key={k} className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground text-[0.8125rem]">{k}</dt>
          <dd className={cn('font-mono text-[0.8125rem]', ok ? 'text-success' : 'text-warning')}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
