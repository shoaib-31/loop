// Two things live here: where the daemon is, and the notification opt-in.
//
// When the PWA is served BY the daemon (the shipping setup) the address is already
// correct and this screen is really just the notifications card — but the field
// stays, because the dev-server case needs it and because a wrong address is
// otherwise undiagnosable from the phone.

import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';

import { NotificationsCard } from '@/components/notifications-card';
import { Body, Header, Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';
import { SectionLabel } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { health } from '@/lib/api';
import { useBaseUrl } from '@/lib/config';
import { getToken, saveToken } from '@/lib/token';

type TestState = { kind: 'idle' | 'testing' | 'ok' | 'fail'; msg?: string };

export function SettingsScreen() {
  const { baseUrl, setBaseUrl } = useBaseUrl();
  const [value, setValue] = useState(baseUrl ?? '');
  const [token, setToken] = useState(getToken() ?? '');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  useEffect(() => {
    if (baseUrl) setValue(baseUrl);
  }, [baseUrl]);

  const testConnection = async (url: string): Promise<boolean> => {
    setTest({ kind: 'testing' });
    try {
      const res = await health(url);
      if (res?.ok) {
        setTest({ kind: 'ok', msg: `Connected to ${res.service}` });
        return true;
      }
      setTest({ kind: 'fail', msg: 'Unexpected response' });
      return false;
    } catch (e: unknown) {
      setTest({ kind: 'fail', msg: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  // Save even if the health check fails: the daemon may just be asleep, and
  // refusing to remember the address would strand the user on this screen.
  // Token first, then test: a health check with a stale token would fail for the
  // wrong reason and read as "daemon unreachable".
  const save = async () => {
    const url = value.trim();
    if (!url) return;
    saveToken(token);
    await testConnection(url);
    setBaseUrl(url);
  };

  return (
    <Screen>
      <Header title="Settings" back="/" />
      <Body className="pt-4">
        <div className="flex flex-col gap-2">
          <SectionLabel>Daemon address</SectionLabel>
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTest({ kind: 'idle' });
            }}
            placeholder="http://100.x.y.z:4318"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono text-[0.9375rem]"
          />
          <p className="text-muted-foreground px-1 text-[0.8125rem] leading-relaxed">
            Your Mac&apos;s Tailscale address and the daemon port (default 4318). Find it with{' '}
            <code className="font-mono text-xs">tailscale ip -4</code> on the Mac. When Loop is
            installed from the daemon&apos;s own URL this is filled in automatically.
          </p>

          {test.kind !== 'idle' ? (
            <div className="flex min-h-6 items-center gap-1.5 px-1 text-[0.8125rem]">
              {test.kind === 'testing' ? (
                <Spinner className="size-4" />
              ) : test.kind === 'ok' ? (
                <span className="text-success flex items-center gap-1.5">
                  <Check className="size-4 shrink-0" />
                  {test.msg}
                </span>
              ) : (
                <span className="text-danger flex items-center gap-1.5">
                  <X className="size-4 shrink-0" />
                  {test.msg}
                </span>
              )}
            </div>
          ) : null}

          {/* Only needed cross-origin (dev server -> daemon elsewhere). Scanning the
              pairing QR sets an HttpOnly cookie instead, which JS can't read — so an
              empty field here is the NORMAL state for the installed app. */}
          <SectionLabel className="mt-5">Pairing token (optional)</SectionLabel>
          <Input
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTest({ kind: 'idle' });
            }}
            placeholder="paste from ~/.loop-eng/token"
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono text-[0.9375rem]"
          />
          <p className="text-muted-foreground px-1 text-[0.8125rem] leading-relaxed">
            Leave empty if you installed Loop by scanning the pairing QR — that already
            authenticated this device. Only needed when the app and daemon are on different
            addresses.
          </p>

          <div className="mt-2 flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={!value.trim()}
              onClick={() => testConnection(value.trim())}>
              Test
            </Button>
            <Button className="flex-1" disabled={!value.trim()} onClick={save}>
              Save
            </Button>
          </div>
        </div>

        {/* The USP's opt-in. */}
        <NotificationsCard baseUrl={baseUrl} />
        <LayoutReadout />
      </Body>
    </Screen>
  );
}

// Every number that decides whether the app fills an iPhone screen, in one place. The
// installed iOS app sizes its viewport unlike any browser we can test in — a bottom gap
// was invisible in desktop Chrome AND Simulator Safari, and two fixes inferred from a
// screenshot each made it differently wrong (2026-10-15). So: measure on the phone.
// Each CSS unit is measured by a throwaway probe, because JS can't read `100dvh` or
// `env(safe-area-inset-*)` directly.
function probe(css: string): number {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:0;top:0;width:0;visibility:hidden;${css}`;
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  const v = Math.round(r.height || parseFloat(getComputedStyle(el).paddingTop) || 0);
  el.remove();
  return v;
}

function LayoutReadout() {
  const [rows, setRows] = useState<[string, string][]>([]);
  useEffect(() => {
    const read = () => {
      const app = document.querySelector('[data-screen]')?.getBoundingClientRect();
      const vv = window.visualViewport;
      setRows([
        ['mode', window.matchMedia('(display-mode: standalone)').matches ? 'installed' : 'browser tab'],
        ['screen', String(window.screen.height)],
        ['innerHeight', String(window.innerHeight)],
        ['visualViewport', vv ? `${Math.round(vv.height)} @ ${Math.round(vv.offsetTop)}` : '—'],
        ['100vh / dvh / svh / lvh', ['100vh', '100dvh', '100svh', '100lvh'].map((u) => probe(`height:${u}`)).join(' / ')],
        ['fixed inset-0', String(probe('bottom:0'))],
        ['safe top / bottom', `${probe('padding-top:env(safe-area-inset-top)')} / ${probe('padding-top:env(safe-area-inset-bottom)')}`],
        ['app top → bottom', app ? `${Math.round(app.top)} → ${Math.round(app.bottom)}` : '—'],
        // What the composer actually reserves under itself — 0 while iOS's band is up.
        ['bottom padding used', String(probe('padding-top:var(--safe-bottom, 0px)'))],
      ]);
    };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  if (!rows.length) return null;
  return (
    <div className="mt-6 flex flex-col gap-1">
      <SectionLabel>Layout</SectionLabel>
      <dl className="flex flex-col gap-0.5 px-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-[0.8125rem]">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
