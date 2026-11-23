# Contributing

Issues and focused pull requests are welcome.

1. Fork the repository and create a short-lived branch.
2. Install dependencies with `npm install`.
3. Keep provider-specific protocol handling inside its engine adapter.
4. Add deterministic tests for behavior changes. Real-agent tests must remain opt-in.
5. Run `npm test`; for PWA changes also run its typecheck and production build.
6. Explain user-visible behavior and security tradeoffs in the pull request.

Never commit real credentials, provider transcripts, account identifiers, private hostnames, or
operator runbooks. Use obviously synthetic fixtures. By contributing, you agree that your work is
licensed under the repository's MIT License.
