// Argv parsing — tiny by design, no dependency for six flags.
//
// Its own module (rather than living in main.mjs) so tests can import it: main.mjs
// dispatches on import, so importing it from a test would launch the CLI.

// Which flags take a value MUST be declared. Guessing from "does the next arg look
// like a flag?" silently eats the prompt: `loop --no-expose "fix the tests"` made
// --no-expose swallow the prompt, so no session was ever created and the dashboard
// just sat there empty. A boolean flag never consumes the following argument.
export const VALUE_FLAGS = new Set(["port", "engine", "cwd", "model", "resume"]);

/** `{ _: [positionals], flags: {name: value|true} }` */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.flags[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) out.flags[name] = argv[++i];
      else out.flags[name] = true;
    } else out._.push(a);
  }
  return out;
}
