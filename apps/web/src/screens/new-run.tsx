// Start a new daemon-hosted session. On success, navigate into its live view.

import { useState } from 'react';
import { useLocation } from 'wouter';

import { Body, Header, Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';
import { SectionLabel } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { startSession } from '@/lib/api';
import { useBaseUrl } from '@/lib/config';

export function NewRunScreen() {
  const [, navigate] = useLocation();
  const { baseUrl } = useBaseUrl();
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const body = prompt.trim();
    if (!body || !baseUrl) return;
    setBusy(true);
    setError(null);
    try {
      const id = await startSession(baseUrl, body, cwd.trim() || undefined);
      // `replace` so Back returns to the list, not to this compose screen.
      navigate(`/session/${id}`, { replace: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header title="New session" back="/" />
      <Body className="pt-4">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}>
          <SectionLabel>Working directory (optional)</SectionLabel>
          <Input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/Users/you/project"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            className="font-mono text-[0.9375rem]"
          />
          <p className="text-muted-foreground px-1 text-[0.8125rem]">
            Defaults to whatever directory the daemon was started in.
          </p>

          <SectionLabel className="mt-3">Prompt</SectionLabel>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should Claude do?"
            rows={6}
            autoFocus
            disabled={busy}
            className="min-h-32"
          />

          {error ? <p className="text-danger px-1 text-[0.8125rem]">{error}</p> : null}

          <Button type="submit" disabled={busy || !prompt.trim()} className="mt-3 h-12">
            {busy ? <Spinner className="text-current" /> : 'Start session'}
          </Button>
        </form>
      </Body>
    </Screen>
  );
}
