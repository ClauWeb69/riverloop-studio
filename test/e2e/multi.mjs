#!/usr/bin/env node
// Due sessioni di Studio contemporanee su progetti diversi, con la porta 3000 già occupata
// da un altro server: ognuna deve avviare il proprio dev server su una porta libera.
// Uso: node test/e2e/multi.mjs --app-a <progetto> --text-a "testo" --app-b <progetto> --text-b "testo" [--chromium <percorso>]
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { processLines, stopStudio } from './platform.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const sessions = [
  { name: 'A', app: path.resolve(opt('app-a')), text: opt('text-a') },
  { name: 'B', app: path.resolve(opt('app-b')), text: opt('text-b') },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout: ${what}`);
}
let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

// Server estraneo sulla porta 3000
const foreign = http.createServer((_q, r) => {
  r.setHeader('content-type', 'text/html');
  r.end('<html><body><h1>SERVER ESTRANEO</h1></body></html>');
});
// Se la 3000 è già di un altro programma di questo computer va bene lo stesso: è occupata comunque
const foreignUp = await new Promise((resolve) => {
  foreign.once('error', () => resolve(false));
  foreign.listen(3000, () => resolve(true));
});
console.log(foreignUp ? 'Server estraneo in ascolto sulla 3000' : 'La porta 3000 è già occupata da un altro programma: va bene lo stesso');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-multi-'));
for (const s of sessions) {
  s.out = '';
  s.proc = spawn(process.execPath, [path.join(ROOT, 'dist/bin/cli.js'), '--claude-bin', path.join(ROOT, 'test/fixtures/fake-claude.mjs'), '--no-open'], {
    cwd: s.app,
    env: { ...process.env, FAKE_CLAUDE_LOG: path.join(tmp, `${s.name}.log`), NO_COLOR: '1', RIVERLOOP_STUDIO_LANG: 'it', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.proc.stdout.on('data', (d) => (s.out += d));
  s.proc.stderr.on('data', (d) => (s.out += d));
  // Avvii quasi contemporanei: la seconda sessione parte mentre la prima sceglie le porte
  await sleep(300);
}

const browser = await chromium.launch({ executablePath: opt('chromium', undefined) });
try {
  for (const s of sessions) {
    s.url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}/.exec(s.out)?.[0], 90000, `URL ${s.name}`);
    s.studioPort = Number(/127\.0\.0\.1:(\d+)\/#/.exec(s.url)[1]);
    s.proxyPort = Number(/proxy su 127\.0\.0\.1:(\d+)/.exec(s.out)[1]);
    s.devPort = Number(/App\s+http:\/\/localhost:(\d+)/.exec(s.out)[1]);
    console.log(`Sessione ${s.name}: Studio :${s.studioPort}, proxy :${s.proxyPort}, dev server :${s.devPort}`);
  }
  check(new Set(sessions.flatMap((s) => [s.studioPort, s.proxyPort, s.devPort])).size === 6, 'porte tutte diverse tra le due sessioni');
  check(
    sessions.every((s) => s.devPort !== 3000),
    'nessuna sessione si è agganciata al server estraneo sulla 3000',
  );
  check(
    sessions.every((s) => /già occupata/.test(s.out)),
    'entrambe avvisano che la 3000 è occupata',
  );

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  for (const s of sessions) {
    const page = await context.newPage();
    await page.goto(s.url);
    const frame = () => page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${s.proxyPort}`));
    const text = await waitFor(
      async () => {
        const t = await frame()?.evaluate(() => document.body.innerText);
        return t && !/In attesa del dev server/.test(t) ? t : null;
      },
      90000,
      `app ${s.name}`,
    );
    check(!text.includes('SERVER ESTRANEO') && text.includes(s.text), `sessione ${s.name}: l'iframe mostra la propria app ("${s.text}")`);
    s.page = page;
  }
} finally {
  await browser.close();
  await Promise.all(sessions.map((s) => stopStudio(s.proc, s.url)));
  await waitFor(() => sessions.every((s) => s.proc.exitCode !== null), 30000, 'chiusura').catch(() => undefined);
  if (foreignUp) foreign.close();
  await sleep(500);
  const left = processLines().filter((l) => sessions.some((s) => l.includes(s.app)) && !l.includes('multi.mjs'));
  check(left.length === 0, `nessun processo rimasto${left.length ? `: ${left.join(' | ')}` : ''}`);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `FALLITO (${failures})` : 'OK');
if (failures) for (const s of sessions) console.log(`--- ${s.name}\n${s.out.slice(-2500)}`);
process.exit(failures ? 1 : 0);
