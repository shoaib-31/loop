#!/usr/bin/env node
// Verify the PWA in a REAL browser — render, console errors, screenshots, clicks.
//
// WHY THIS EXISTS: a clean `tsc -b` and a successful `vite build` once shipped a
// COMPLETELY BLANK PAGE (two React copies -> null hook dispatcher, docs/architecture.md
// PROBLEM 10). Type-checking and bundling cannot catch that class of bug; only
// loading the page can. So "it builds" is not evidence — this is.
//
// Deliberately dependency-free: it speaks the Chrome DevTools Protocol over
// Node's native WebSocket. No puppeteer/playwright, nothing to keep updated, and
// it drives the same Chrome already on the machine.
//
// Usage (daemon or `vite preview` must already be serving):
//   node tools/browser-check.mjs http://localhost:4318/ http://localhost:4318/new
//   node tools/browser-check.mjs --shot=home http://localhost:4318/
//   node tools/browser-check.mjs --expand=Bash --shot=tools http://localhost:4318/session/<id>
//   node tools/browser-check.mjs --click=Mango --shot=answered http://localhost:4318/session/<id>
//
// Flags (all optional, apply to every URL given):
//   --shot=<name>    write /tmp/<name>.png (full page). With >1 URL, an index is appended.
//   --click=<text>   click the first <button> whose text contains <text>, then re-read.
//                    REPEATABLE: --click=A --click=B walks a confirm step (PROBLEM 20).
//   --expand=<regex> click every button whose text matches <regex> before shooting
//   --wait=<ms>      settle time before reading (default 3000; a live WS needs more)
//   --port=<n>       CDP port (default 9333) — bump it to run two checks at once
//
// Exit code is 1 if ANY page logged an error/exception or rendered an empty root,
// so this is usable as a gate, not just something to eyeball.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const urls = argv.filter((a) => !a.startsWith('--'));
if (!urls.length) {
  console.error('usage: node tools/browser-check.mjs [--shot=name] [--click=text] [--expand=re] [--wait=ms] <url...>');
  process.exit(2);
}

const SHOT = flag('shot');
/**
 * REPEATABLE: `--click=A --click=B` clicks A, waits, then clicks B.
 *
 * Needed for any flow with a confirm step — the import screen deliberately asks before
 * adopting a conversation (PROBLEM 20), so a single click only ever reaches the question.
 * The waits between are what let React re-render the newly revealed button.
 */
const CLICKS = argv.filter((a) => a.startsWith('--click=')).map((a) => a.slice('--click='.length));
const EXPAND = flag('expand');
const WAIT = Number(flag('wait', 3000));
const PORT = Number(flag('port', 9333));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A throwaway profile per port: a shared one makes concurrent runs fight over the
// lock file, which fails as a mysterious startup timeout.
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=/tmp/loop-cdp-${PORT}`,
    '--window-size=390,844', // iPhone-ish, since every screen here is phone-first
  ],
  { stdio: 'ignore' }
);

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250);
  try {
    await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    up = true;
  } catch {}
}
if (!up) {
  console.error(`could not start Chrome on :${PORT} (is ${CHROME} present?)`);
  chrome.kill();
  process.exit(2);
}

let failed = false;

for (const [i, url] of urls.entries()) {
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const errs = [];
  let id = 0;

  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push('EXCEPTION: ' + (d.exception?.description ?? d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      errs.push(
        m.params.type.toUpperCase() +
          ': ' +
          m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
      );
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      // Catches what Runtime misses: failed requests, bad MIME types, SW errors.
      errs.push('LOG: ' + m.params.entry.text + ' ' + (m.params.entry.url ?? ''));
    }
  });

  const call = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      const handler = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === myId) {
          ws.removeEventListener('message', handler);
          resolve(m.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const evaluate = async (expression) =>
    (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result
      ?.value;
  const rendered = () => evaluate('document.getElementById("root").innerText');

  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await sleep(WAIT);

  console.log(`\n===== ${url} =====`);

  if (EXPAND) {
    const n = await evaluate(`(() => {
      const bs = [...document.querySelectorAll('button')].filter(b => /${EXPAND}/.test(b.textContent));
      bs.forEach(b => b.click());
      return bs.length;
    })()`);
    console.log(`[expand] clicked ${n} button(s) matching /${EXPAND}/`);
    await sleep(600);
  }

  if (CLICKS.length) {
    console.log('--- before click ---');
    console.log(String(await rendered()).trim() || '(EMPTY)');
    for (const [i, target] of CLICKS.entries()) {
      // A real DOM click, not a synthetic fetch: the whole React handler -> HTTP ->
      // daemon -> canUseTool resolution path runs exactly as it does on the phone.
      const result = await evaluate(`(() => {
        const bs = [...document.querySelectorAll('button')];
        const b = bs.find(x => x.textContent.includes(${JSON.stringify(target)}));
        if (!b) return 'NOT FOUND. buttons: ' + bs.map(x => x.textContent.slice(0, 30)).join(' | ');
        if (b.disabled) return 'DISABLED';
        b.click();
        return 'clicked: ' + b.textContent.slice(0, 40);
      })()`);
      console.log(`--- click ${i + 1}/${CLICKS.length} (${target}) ---`);
      console.log(result);
      if (String(result).startsWith('NOT FOUND') || result === 'DISABLED') { failed = true; break; }
      // Long enough for an agent to take a whole turn after the LAST click; short between
      // clicks, where all that's needed is a re-render revealing the next button.
      await sleep(i === CLICKS.length - 1 ? 9000 : 900);
    }
  }

  const text = String(await rendered()).trim();
  console.log('--- rendered text ---');
  console.log(text || '(EMPTY — nothing mounted; see PROBLEM 10 before debugging anything else)');
  if (!text) failed = true;

  if (SHOT) {
    const name = urls.length > 1 ? `${SHOT}-${i + 1}` : SHOT;
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (shot?.data) {
      writeFileSync(`/tmp/${name}.png`, Buffer.from(shot.data, 'base64'));
      // Worth actually LOOKING at: a stray spinner above a pending question was
      // invisible in the DOM text and obvious in the screenshot.
      console.log(`[shot] /tmp/${name}.png`);
    }
  }

  console.log('--- console errors/warnings ---');
  console.log(errs.length ? errs.join('\n') : '(none)');
  if (errs.length) failed = true;

  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
}

chrome.kill();
console.log(failed ? '\n❌ problems found (see above)' : '\n✅ all pages rendered, no console errors');
process.exit(failed ? 1 : 0);
