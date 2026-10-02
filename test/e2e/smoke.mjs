#!/usr/bin/env node
// Prova rapida su qualunque progetto web: overlay, HMR tramite proxy, un'annotazione, chiusura.
// Uso: node test/e2e/smoke.mjs --app <cartella> --file src/App.tsx --find "Get started" --replace "Ciao Studio"
//        [--target h1] [--dev-cmd "npm run dev"] [--port 3000] [--chromium <percorso>] [--shot file.png]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { stopStudio } from './platform.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const app = path.resolve(opt('app', '.'));
const file = path.join(app, opt('file', 'app/page.tsx'));
const find = opt('find', '');
const replace = opt('replace', 'Riverloop Studio HMR');
const target = opt('target', 'h1');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-smoke-'));
const fakeLog = path.join(tmp, 'fake.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = () =>
  existsSync(fakeLog)
    ? readFileSync(fakeLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
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

const args = [path.join(ROOT, 'dist/bin/cli.js'), '--claude-bin', path.join(ROOT, 'test/fixtures/fake-claude.mjs'), '--no-open'];
if (opt('dev-cmd')) args.push('--dev-cmd', opt('dev-cmd'));
if (opt('port')) args.push('--port', opt('port'));
rmSync(path.join(app, '.claude', 'studio'), { recursive: true, force: true });
const studio = spawn(process.execPath, args, {
  cwd: app,
  env: { ...process.env, FAKE_CLAUDE_LOG: fakeLog, NO_COLOR: '1', RIVERLOOP_STUDIO_LANG: 'it' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
studio.stdout.on('data', (d) => (out += d));
studio.stderr.on('data', (d) => (out += d));
const original = readFileSync(file, 'utf8');
let ok = true;
const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log(`  ✔ ${name}${r ? ` (${r})` : ''}`);
  } catch (err) {
    ok = false;
    console.log(`  ✖ ${name}: ${err.message}`);
  }
};

console.log(`Smoke test: ${app}`);
const url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}/.exec(out)?.[0], 90000, 'URL Studio');
const proxyPort = Number(/proxy su 127\.0\.0\.1:(\d+)/.exec(out)[1]);
const browser = await chromium.launch({ executablePath: opt('chromium', undefined) });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(url);
const frame = () => page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${proxyPort}`));

await step("overlay attivo nell'app", async () => {
  await waitFor(async () => frame() && (await frame().evaluate(() => Boolean(window.__riverloopStudioOverlay__))), 90000, 'overlay');
  const port = /App\s+http:\/\/localhost:(\d+)/.exec(out)?.[1];
  return `dev server su :${port}`;
});
await step('HMR tramite il proxy', async () => {
  // Il client HMR si collega dopo il caricamento: un aggiornamento precedente andrebbe perso.
  await sleep(3000);
  await frame().evaluate(() => (window.__hmr = 7));
  const updated = original.replace(find, replace);
  if (updated === original) throw new Error(`testo "${find}" non trovato`);
  writeFileSync(file, updated);
  await waitFor(async () => (await frame().evaluate(() => document.body.innerText)).includes(replace), 45000, 'testo aggiornato');
  const marker = await frame().evaluate(() => window.__hmr);
  if (marker !== 7) throw new Error('pagina ricaricata invece di HMR');
});
await step(`annotazione su ${target} e invio`, async () => {
  await page.click('[data-mode="select"]');
  const el = await frame().waitForSelector(target);
  const b = await el.boundingBox();
  await page.mouse.move(b.x + Math.min(20, b.width / 2), b.y + b.height / 2, { steps: 4 });
  await sleep(200);
  await page.mouse.click(b.x + Math.min(20, b.width / 2), b.y + b.height / 2);
  await sleep(250);
  await page.keyboard.type('Cambia il colore in verde');
  await page.keyboard.press('Control+Enter');
  // Il finto claude registra l'incolla completo anche se arriva a pezzi (ConPTY su Windows)
  const paste = await waitFor(() => events().find((e) => e.event === 'paste'), 20000, 'prompt nel PTY');
  if (!paste.raw.includes('Elemento `')) throw new Error('prompt senza elemento');
  const dir = path.join(app, '.claude', 'studio', 'annotations');
  const json = JSON.parse(
    readFileSync(
      path.join(
        dir,
        readdirSync(dir).find((f) => f.endsWith('.json')),
      ),
      'utf8',
    ),
  );
  const a = json.annotations[0];
  if (opt('shot')) await page.screenshot({ path: opt('shot') });
  return `selettore "${a.selector}", componenti ${JSON.stringify(a.components)}, sorgente ${a.source ?? '-'}, screenshot ${a.screenshot ? 'sì' : `no (${a.screenshotError})`}`;
});

writeFileSync(file, original);
await browser.close();
await stopStudio(studio, url);
await waitFor(() => studio.exitCode !== null, 20000, 'chiusura').catch(() => studio.kill('SIGKILL'));
rmSync(tmp, { recursive: true, force: true });
console.log(ok ? 'OK' : `FALLITO\n${out.slice(-3000)}`);
process.exit(ok ? 0 : 1);
