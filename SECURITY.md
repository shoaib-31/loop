# Security

Loop is intended for a trusted, single-user machine. Coding agents can execute commands and
modify files inside the directory used to launch a session. Treat that directory as a permission
boundary: never launch Loop from your home directory, a credentials directory, or a worktree
whose secrets and deployment access the agent should not have.

## Network exposure

- Prefer Tailscale Serve, which is restricted to authenticated devices on your tailnet.
- `loop share` and `--funnel` expose the service to the public internet. The pairing token then
  becomes the primary application-level guard. End public exposure as soon as it is no longer
  needed.
- Do not disable authentication on a non-loopback interface.
- Session snapshots under `~/.loop-eng/` can contain prompts, normalized transcripts, working
  directories, and push-subscription data. Protect that directory like other local application
  data.

## Reporting a vulnerability

Please use GitHub's private security-advisory reporting for this repository. Do not open a public
issue containing credentials, exploit details, private transcripts, or infrastructure identifiers.
If a credential was committed or exposed, revoke or rotate it immediately; removing it from Git
history is not sufficient.
