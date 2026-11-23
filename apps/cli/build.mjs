#!/usr/bin/env bun
// Build the released `loop` — ONE self-contained executable (docs/architecture.md).
//
//   bun apps/cli/build.mjs            -> dist/loop
//   bun apps/cli/build.mjs --target bun-linux-x64
//
// WHY THIS IS A SCRIPT AND NOT A `bun build` ONE-LINER. The one-liner in package.json
// never worked, for a reason no flag can fix:
//
//   Ink's reconciler does `await import('./devtools.js')` behind a `process.env.DEV ===
//   'true'` guard, and that module statically imports `react-devtools-core` — an optional
//   dev dependency that isn't installed. Bun's bundler follows the dynamic import
//   regardless of the guard, so the build fails with "Could not resolve". `--external`
//   moves the failure to RUNTIME (the binary dies on startup, because bun hoists the
//   hoisted import) and `--define process.env.DEV="false"` doesn't help either, because
//   resolution happens before dead-code elimination.
//
//   The fix is a resolver plugin that answers with a no-op module. Ink only ever touches
//   it when DEV=true, which a shipped binary never is.
//
// WHAT ELSE IS LOAD-BEARING HERE:
//   * The binary contains the DAEMON too, reached via the hidden `loop __daemon`
//     subcommand — a released `loop` has no `server.mjs` on disk to spawn.
//   * It does NOT contain Claude Code. Bun cannot embed the SDK's ~280MB native CLI, and
//     inside the binary `import.meta.url` is a `$bunfs` path so the SDK's own lookup
//     throws. `engines/claude-code.mjs` therefore points the SDK at the `claude` on PATH,
//     which the user must have anyway because that install holds the login. Result: ~62MB,
//     not ~350MB.

import { rm, mkdir, stat, chmod } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT_DIR = join(ROOT, "dist");

const argv = process.argv.slice(2);
const targetFlag = argv.indexOf("--target");
const target = targetFlag >= 0 ? argv[targetFlag + 1] : undefined;
// Cross-compiled artifacts get a suffixed name so several can sit in dist/ at once.
const name = target ? `loop-${target.replace(/^bun-/, "")}` : "loop";
const outfile = join(OUT_DIR, name + (target?.includes("windows") ? ".exe" : ""));

/**
 * Answer `react-devtools-core` with a no-op. See the header for why this is required
 * rather than nice-to-have.
 */
const devtoolsStub = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents:
        "const noop = () => {};\n" +
        "export default { initialize: noop, connectToDevTools: noop };\n",
      loader: "js",
    }));
  },
};

await mkdir(OUT_DIR, { recursive: true });
await rm(outfile, { force: true });

const started = Date.now();
const result = await Bun.build({
  entrypoints: [join(HERE, "src", "main.mjs")],
  compile: target ? { outfile, target } : { outfile },
  plugins: [devtoolsStub],
  // The TUI reads its own version, and a sourcemap in a 60MB binary is dead weight.
  sourcemap: "none",
  minify: false, // stack traces from a released binary should still be readable
});

if (!result.success) {
  console.error("build failed:");
  for (const log of result.logs) console.error(" ", log.message ?? log);
  process.exit(1);
}

await chmod(outfile, 0o755).catch(() => {});
const { size } = await stat(outfile);
console.log(`built ${outfile}  ${(size / 1024 / 1024).toFixed(1)}MB  in ${Date.now() - started}ms`);
console.log(`\nsmoke test it:\n  ${outfile} doctor\n`);
