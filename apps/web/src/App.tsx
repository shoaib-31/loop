import { Route, Switch } from 'wouter';

import { SessionsScreen } from '@/screens/sessions';
import { SessionScreen } from '@/screens/session';
import { NewRunScreen } from '@/screens/new-run';
import { ImportScreen } from '@/screens/import';
import { SettingsScreen } from '@/screens/settings';
import { NotFoundScreen } from '@/screens/not-found';

// Routes are hand-declared (5 screens), so wouter's ~2KB is enough — no
// file-based routing framework needed.
//
// /session/:id must stay a real URL, not client-side state: it's the deep-link
// target a notification tap opens (the service worker calls
// clients.openWindow('/session/<id>')). The daemon serves index.html for any
// unmatched path so a cold tap lands here correctly.
export function App() {
  return (
    <Switch>
      <Route path="/" component={SessionsScreen} />
      <Route path="/session/:id" component={SessionScreen} />
      <Route path="/new" component={NewRunScreen} />
      {/* Conversations started in another client, adoptable from here (PROBLEM 20). */}
      <Route path="/import" component={ImportScreen} />
      <Route path="/settings" component={SettingsScreen} />
      <Route component={NotFoundScreen} />
    </Switch>
  );
}
