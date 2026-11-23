// The daemon serves index.html for any unmatched path, so a typo'd or stale URL
// lands here rather than on a server 404. Keep the escape hatch obvious: in a
// standalone PWA there is no address bar to fix it with.

import { Link } from 'wouter';

import { Body, Centered, Header, Screen } from '@/components/screen';
import { buttonClass } from '@/components/ui/button';

export function NotFoundScreen() {
  return (
    <Screen>
      <Header title="Not found" />
      <Body>
        <Centered>
          <h2 className="text-xl font-bold">Nothing here</h2>
          <p className="text-muted-foreground max-w-xs text-[0.9375rem] leading-relaxed">
            That link doesn&apos;t match a screen in Loop.
          </p>
          <Link href="/" className={buttonClass({ className: 'mt-1' })}>
            Go to sessions
          </Link>
        </Centered>
      </Body>
    </Screen>
  );
}
