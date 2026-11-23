# Contributor guidance

Loop-Eng is a local-first remote control for Claude Code and Codex. The daemon owns agent
processes and normalized session history; the terminal UI and PWA are clients of its HTTP and
WebSocket API.

## Before submitting a change

1. Run `npm test` for the deterministic suite.
2. Run `npm run typecheck --workspace @loop-eng/web` for web changes.
3. Run `npm run build:pwa` when the PWA or its API types change.
4. Keep real credentials, transcripts, hostnames, infrastructure identifiers, and personal
   operational notes out of fixtures and documentation.

Real-provider suites spend account usage and run only with `npm run test:agent`. Never run them
implicitly from the free suite. Preserve the provider-neutral session boundary: engine adapters
normalize events; UI code must not depend on a vendor's raw protocol.
