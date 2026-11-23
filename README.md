# Loop-Eng

Run Claude Code or Codex on your Mac, follow the work from another device, and continue a
session in the other provider without losing the useful context.

Loop-Eng is local-first: agents run on your machine, in the working directory you choose. A
terminal dashboard and installable PWA connect to the local daemon. Tailscale Serve provides the
recommended tailnet-only path from your phone; public Funnel exposure is explicit and temporary.

## What works

- Start, watch, interrupt, hibernate, resume, and delete Claude Code or Codex sessions.
- Stream text, tool calls, tool results, and structured questions to the terminal and PWA.
- Answer an agent's question from your phone and receive web-push notifications.
- Import existing provider conversations when their native client exposes them.
- Hand work from Claude Code to Codex, or back again. A handoff starts a new native provider
  conversation in the same directory with a bounded, provider-neutral transcript and Git-state
  brief. The source session remains intact.
- Restore normalized session history after the daemon restarts.

## Requirements

- macOS or Linux
- Node.js 22+ and npm for development
- Claude Code and/or Codex installed and authenticated
- Tailscale on the computer and phone for remote access and push notifications

Loop-Eng does not proxy provider credentials. Each engine uses the corresponding locally
installed and authenticated coding-agent client.

## Run from source

```bash
npm install
npm run build:pwa
node apps/cli/src/main.mjs
```

Start it from the project directory the agents are allowed to modify. To stay local-only:

```bash
node apps/cli/src/main.mjs --no-expose
```

Useful commands:

```bash
node apps/cli/src/main.mjs doctor
node apps/cli/src/main.mjs --engine codex
node apps/cli/src/main.mjs serve
node apps/cli/src/main.mjs stop
```

Inside a session, press `Ctrl+T` twice to hand the work to the other provider. In the PWA, use
the handoff button in the session header.

## Development

```bash
npm test
npm run typecheck --workspace @loop-eng/web
npm run build:pwa
```

`npm run test:agent` runs real-provider suites. They require authenticated clients, spend account
usage, and are intentionally excluded from `npm test`.

See [the architecture](docs/architecture.md), [security guidance](SECURITY.md), and
[contribution guide](CONTRIBUTING.md).

## License

[MIT](LICENSE)
