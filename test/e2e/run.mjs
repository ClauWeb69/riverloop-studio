#!/usr/bin/env node
// Test end-to-end di Riverloop Studio su un progetto Next.js reale.
// Avvia riverloop-studio con un finto "claude" che registra l'input del PTY, apre Chromium
// e verifica: console, ricaricamento, proxy + HMR, annotazioni, sicurezza e chiusura.
//
// Uso: node test/e2e/run.mjs --app <cartella progetto Next.js> [--dev-cmd "npm run dev"]
//        [--shots <cartella screenshot>] [--chromium <percorso>] [--port 3000]
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'dist/bin/cli.js');
const FAKE = path.join(ROOT, 'test/fixtures/fake-claude.mjs');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const appDir = path.resolve(opt('app', process.env.E2E_APP || ''));
const devCmd = opt('dev-cmd', 'npm run dev');
const devPort = Number(opt('port', '3000'));
const shotsDir = opt('shots', null);
const chromiumPath = opt('chromium', process.env.CHROMIUM_PATH || undefined);
if (!appDir || !existsSync(path.join(appDir, 'package.json'))) {
  console.error('Specifica un progetto Next.js con --app <cartella>');
  process.exit(2);
}
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-e2e-'));
const fakeLog = path.join(tmp, 'fake-claude.log');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''} \x1b[2m${Date.now() - t0} ms\x1b[0m`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(
      `  \x1b[31m✖ ${name}\x1b[0m\n    ${String(err?.stack || err)
        .split('\n')
        .slice(0, 4)
        .join('\n    ')}`,
    );
    // Errori del browser (pagina Studio e app nell'iframe) arrivati finora: spesso sono la causa
    for (const e of consoleErrors.splice(0)) console.log(`    \x1b[2mbrowser: ${e.split('\n')[0]}\x1b[0m`);
    // Avvisi mostrati nella pagina in quel momento (spesso spiegano il rifiuto)
    const toasts = await page.evaluate(() => document.getElementById('toasts')?.innerText ?? '').catch(() => '');
    if (toasts.trim()) console.log(`    \x1b[2mavvisi: ${toasts.trim().replace(/\n+/g, ' | ')}\x1b[0m`);
  }
}

/** Argomenti di claude senza --settings <file> (hook e status line che Studio aggiunge sempre). */
const withoutSettings = (argv) => argv.filter((a, i, all) => a !== '--settings' && all[i - 1] !== '--settings');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function fakeEvents() {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function waitFor(fn, timeout = 15000, interval = 150, what = 'condizione') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timeout in attesa di: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function shot(page, name) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

// ---------------------------------------------------------------------------
// Avvio di riverloop-studio
// ---------------------------------------------------------------------------
rmSync(path.join(appDir, '.claude', 'studio'), { recursive: true, force: true });
const studio = spawn(
  process.execPath,
  [CLI, '--claude-bin', FAKE, '--no-open', '--dev-cmd', devCmd, '--port', String(devPort), '--claude-args', '--model "fake model"'],
  {
    cwd: appDir,
    // Il finto claude assorbe un Invio che arriva entro 700 ms dall'incolla (come un Claude Code lento)
    // e, dopo l'invio di un messaggio di Studio, apre una richiesta di permesso.
    env: {
      ...process.env,
      FAKE_CLAUDE_LOG: fakeLog,
      FAKE_CLAUDE_PASTE_DELAY_MS: '700',
      FAKE_CLAUDE_DIALOG: '1',
      NO_COLOR: '1',
      // I controlli sui testi sono in italiano
      RIVERLOOP_STUDIO_LANG: 'it',
      // Progetti recenti, lingua e permessi salvati: in una cartella del test, non in quella dell'utente
      RIVERLOOP_STUDIO_CONFIG_DIR: path.join(tmp, 'config'),
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let studioOut = '';
studio.stdout.on('data', (d) => (studioOut += d));
studio.stderr.on('data', (d) => (studioOut += d));
let studioExit = null;
studio.on('exit', (code, signal) => (studioExit = { code, signal }));

console.log(`\nRiverloop Studio e2e — ${appDir} (${devCmd})`);
const t0 = Date.now();
const studioUrl = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}/.exec(studioOut)?.[0], 90000, 200, 'URL di Studio');
const token = /t=([0-9a-f]{64})/.exec(studioUrl)[1];
const studioPort = Number(/127\.0\.0\.1:(\d+)/.exec(studioUrl)[1]);
const proxyPort = Number(/proxy su 127\.0\.0\.1:(\d+)/.exec(studioOut)?.[1] ?? studioPort + 1);
const wsProtocols = ['riverloop-studio', `rls-token.${token}`];
console.log(`  Studio pronto in ${Date.now() - t0} ms su :${studioPort} (proxy :${proxyPort})`);

const browser = await chromium.launch({ executablePath: chromiumPath, headless: !argv.includes('--headed') });
const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(`${msg.text()} (${msg.location()?.url?.split('/').pop() ?? ''})`);
});
const appFrame = () => page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${proxyPort}`));
const terminalText = () => page.evaluate(() => window.__riverloopStudio?.terminalText() ?? '');

// ---------------------------------------------------------------------------
// 1. Pagina Studio e console
// ---------------------------------------------------------------------------
await check('il token resta fuori dalle richieste HTTP e dai cookie', async () => {
  const t = Date.now();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(studioUrl);
  await waitFor(() => page.evaluate(() => Boolean(window.__riverloopStudio)), 15000, 100, 'pagina pronta');
  assert(page.url() === `http://127.0.0.1:${studioPort}/`, `URL finale ${page.url()}`);
  assert(!requests.some((u) => u.includes(token)), 'il token è finito in una richiesta HTTP');
  const cookies = await context.cookies();
  assert(!cookies.some((c) => c.value === token), 'il token è in un cookie');
  const proxyCookie = cookies.find((x) => x.name === `rls_proxy_${studioPort}`);
  assert(proxyCookie && proxyCookie.httpOnly && proxyCookie.sameSite === 'Strict', 'cookie del proxy HttpOnly/Strict mancante');
  return `${Date.now() - t} ms`;
});

await check('la console mostra claude avviato nella cartella del progetto', async () => {
  await waitFor(async () => (await terminalText()).includes('Fake Claude'), 20000, 200, 'banner del finto claude');
  const start = fakeEvents().find((e) => e.event === 'start');
  assert(start, 'claude non avviato');
  assert(path.resolve(start.cwd) === appDir, `cwd ${start.cwd}`);
  assert(JSON.stringify(withoutSettings(start.argv)) === JSON.stringify(['--model', 'fake model']), `argv ${JSON.stringify(start.argv)}`);
  assert(start.cols > 40 && start.rows > 10, `dimensione iniziale ${start.cols}x${start.rows}`);
  return `PTY ${start.cols}x${start.rows}`;
});

await check("l'app si carica nell'iframe tramite il proxy con l'overlay", async () => {
  await waitFor(
    async () => {
      const f = appFrame();
      return f && (await f.evaluate(() => document.querySelector('h1')?.textContent || '')).length > 0;
    },
    90000,
    300,
    "h1 dell'app nell'iframe",
  );
  const f = appFrame();
  await waitFor(() => f.evaluate(() => Boolean(window.__riverloopStudioOverlay__)), 10000, 150, 'overlay attivo');
  const scriptGone = await f.evaluate(() => !document.querySelector('script[data-riverloop-studio]'));
  assert(scriptGone, 'lo script iniettato è ancora nel DOM');
  await waitFor(async () => (await page.inputValue('#url-input')) === '/', 5000, 100, 'percorso nella barra URL');
  await sleep(600);
  await shot(page, '01-studio');
});

// Suggerimenti per il progetto: il riquadro compare da solo, spiega cosa chiederà e si può rimandare
let suggested = null;
await check('suggerimenti: il riquadro propone la modifica e "Non ora" la rimanda', async () => {
  const list = await page.evaluate(async (t) => (await (await fetch('/api/suggestions', { headers: { 'X-Studio-Token': t } })).json()).suggestions, token);
  if (!list.length) return 'nessun suggerimento per questo progetto (già configurato)';
  await page.waitForSelector('#suggest:not([hidden])', { timeout: 8000 });
  const shown = await page.evaluate(() => ({
    title: document.getElementById('suggest-title').textContent,
    prompt: document.getElementById('suggest-text').textContent,
    count: document.getElementById('suggest-count').textContent,
  }));
  assert(shown.title === list[0].title && shown.prompt === list[0].prompt, `riquadro: ${JSON.stringify(shown).slice(0, 200)}`);
  assert(shown.count === String(list.length), `conteggio ${shown.count}`);
  await shot(page, '01b-suggerimento');
  // Finché non si clicca, a Claude non arriva nulla
  assert(!fakeEvents().some((e) => e.event === 'input' && e.data.includes(list[0].prompt.slice(0, 20))), 'richiesta partita senza clic');
  for (let i = 0; i < list.length; i++) await page.click('#suggest-later');
  await waitFor(() => page.evaluate(() => document.getElementById('suggest').hidden), 3000, 100, 'riquadro chiuso');
  assert(await page.isVisible('#btn-suggest'), 'pulsante dei suggerimenti mancante');
  suggested = {
    title: list[0].title,
    start: list[0].prompt.split('\n')[0].slice(0, 40),
    marker: list[0].prompt.split('\n')[0].slice(0, 30),
    others: list.length - 1,
  };
  return `${list.length}: ${list.map((x) => x.id).join(', ')}`;
});

await check('scrivere nella console arriva al PTY (Shift+Enter = nuova riga)', async () => {
  await page.click('#terminal');
  await page.keyboard.type('ciao');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('mondo');
  await page.keyboard.press('Enter');
  const submit = await waitFor(() => fakeEvents().find((e) => e.event === 'submit'), 8000, 100, 'invio dal terminale');
  const inputs = fakeEvents()
    .filter((e) => e.event === 'input')
    .map((e) => e.data)
    .join('');
  assert(inputs.includes('\x1b\r'), 'Shift+Enter non inviato come ESC+CR');
  return JSON.stringify(submit.line);
});

await check('ricaricare Studio non riavvia claude e ripristina lo schermo', async () => {
  const startsBefore = fakeEvents().filter((e) => e.event === 'start').length;
  await page.reload();
  await waitFor(async () => (await terminalText()).includes('ricevuto'), 15000, 200, 'schermo ripristinato');
  const startsAfter = fakeEvents().filter((e) => e.event === 'start').length;
  assert(startsBefore === startsAfter, 'claude è stato riavviato');
  const text = await terminalText();
  assert(text.includes('Fake Claude'), 'banner iniziale perso');
  await waitFor(() => appFrame(), 20000, 200, 'iframe dopo il ricaricamento');
});

await check('una seconda scheda vede la stessa sessione', async () => {
  const second = await context.newPage();
  await second.goto(`http://127.0.0.1:${studioPort}/`);
  await waitFor(
    async () => (await second.evaluate(() => window.__riverloopStudio?.terminalText() ?? '')).includes('Fake Claude'),
    15000,
    200,
    'seconda scheda',
  );
  await second.close();
  const starts = fakeEvents().filter((e) => e.event === 'start').length;
  assert(starts === 1, `claude avviato ${starts} volte`);
});

// ---------------------------------------------------------------------------
// 2. HMR attraverso il proxy
// ---------------------------------------------------------------------------
const pageFile = ['app/page.tsx', 'src/app/page.tsx', 'app/page.jsx', 'app/page.js'].map((p) => path.join(appDir, p)).find(existsSync);
// Un'esecuzione precedente interrotta può aver lasciato la pagina modificata: si riparte dal testo originale
const originalPage = pageFile
  ? readFileSync(pageFile, 'utf8').replace(/(?:Benvenuti in Riverloop Studio|Titolo cambiato da Claude), modifica il/, 'To get started, edit the')
  : null;
if (pageFile && originalPage !== readFileSync(pageFile, 'utf8')) writeFileSync(pageFile, originalPage);
await check('le modifiche al codice arrivano via HMR senza ricaricare la pagina', async () => {
  assert(pageFile, 'page.tsx non trovato');
  const f = appFrame();
  await f.evaluate(() => {
    window.__hmrMarker = 42;
  });
  const updated = originalPage.replace(/To get started, edit the/, 'Benvenuti in Riverloop Studio, modifica il');
  assert(updated !== originalPage, 'testo da sostituire non trovato');
  writeFileSync(pageFile, updated);
  await waitFor(
    async () => (await appFrame().evaluate(() => document.querySelector('h1')?.textContent || '')).includes('Benvenuti'),
    45000,
    250,
    'aggiornamento HMR',
  );
  const marker = await appFrame().evaluate(() => window.__hmrMarker);
  assert(marker === 42, 'la pagina è stata ricaricata invece di aggiornarsi via HMR');
});

// ---------------------------------------------------------------------------
// 3. Annotazioni
// ---------------------------------------------------------------------------
async function box(selector) {
  const f = appFrame();
  const el = await f.waitForSelector(selector, { timeout: 10000 });
  const b = await el.boundingBox();
  assert(b, `nessun riquadro per ${selector}`);
  return b;
}

await check('Elemento: hover, clic, commento e badge numerato', async () => {
  await page.click('[data-mode="select"]');
  const b = await box('h1');
  await page.mouse.move(b.x + 20, b.y + b.height / 2, { steps: 6 });
  await sleep(250);
  await shot(page, '02-hover');
  await page.mouse.click(b.x + 20, b.y + b.height / 2);
  await sleep(300);
  await page.keyboard.type('Rendi il titolo più piccolo e allinealo a sinistra');
  await shot(page, '03-commento');
  await page.keyboard.press('Enter');
  await waitFor(() => page.evaluate(() => document.querySelectorAll('#tray-list li').length === 1), 5000, 100, 'voce nel vassoio');
  await waitFor(() => page.evaluate(() => !document.querySelector('#tray-list .thumb.loading')), 20000, 150, 'screenshot');
  const state = await page.textContent('#tray-list li .state');
  assert(state?.includes('in sospeso'), `stato ${state}`);
});

await check('Riquadro: trascinamento su una zona', async () => {
  await page.click('[data-mode="area"]');
  const f = appFrame();
  const links = await f.$$('main a');
  const last = links[links.length - 1];
  const lb = await last.boundingBox();
  const fb = await (await f.$('main a.rounded-full')).boundingBox();
  const x0 = Math.min(fb.x, lb.x) - 12;
  const y0 = Math.min(fb.y, lb.y) - 12;
  const x1 = Math.max(fb.x + fb.width, lb.x + lb.width) + 12;
  const y1 = Math.max(fb.y + fb.height, lb.y + lb.height) + 12;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 });
  await page.mouse.move(x1, y1, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.type("I pulsanti devono essere verdi come quello dell'header");
  await page.keyboard.press('Enter');
  await waitFor(() => page.evaluate(() => document.querySelectorAll('#tray-list li').length === 2), 5000, 100, 'seconda voce');
});

await check('Disegno: tratto libero, Ctrl+Invio salva e invia tutto', async () => {
  await page.click('[data-mode="draw"]');
  const b = await box('main p');
  const pts = [
    [b.x + 10, b.y + b.height + 6],
    [b.x + b.width * 0.3, b.y + b.height + 10],
    [b.x + b.width * 0.6, b.y + b.height + 4],
    [b.x + b.width * 0.9, b.y + b.height + 8],
  ];
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.type('Sottolinea questa frase');
  await shot(page, '04-annotazioni');
  await page.keyboard.press('Control+Enter');
  // Il finto claude registra l'incolla completo (bracketed paste), anche se è arrivato a pezzi
  const paste = await waitFor(() => fakeEvents().find((e) => e.event === 'paste'), 20000, 150, 'testo incollato nel PTY (bracketed paste)');
  const text = paste.raw;
  assert(!text.includes('\n'), 'a capo non convertiti in CR');
  for (const needle of [
    'Modifiche richieste sulla pagina / (viewport',
    '1. Elemento `',
    'Richiesta: Rendi il titolo più piccolo',
    '2. Zona di ',
    '   Posizione nella pagina: x ',
    '   Si trova: ',
    '   Contiene: `',
    '3. Disegno su una zona di ',
    '   Passa sopra: `',
    'Screenshot: @.claude/studio/annotations/',
    'Dettagli completi (HTML, stili, posizione): @.claude/studio/annotations/',
    'Negli screenshot ogni annotazione è evidenziata con il suo numero.',
  ]) {
    assert(text.includes(needle), `manca "${needle}" nel prompt`);
  }
  const submitted = fakeEvents().filter((e) => e.event === 'submit' && e.line.includes('Modifiche richieste'));
  assert(submitted.length === 0, 'con Invio automatico spento il prompt non deve essere inviato');
  await sleep(400);
  await shot(page, '05-inviato');
  const lines = text.split('\r');
  return lines.filter((l) => /^(\d\. Zona| {3}Posizione| {3}Si trova| {3}Contiene)/.test(l)).join(' | ');
});

await check('file salvati in .claude/studio/annotations (3 PNG + JSON)', async () => {
  const dir = path.join(appDir, '.claude', 'studio', 'annotations');
  const files = readdirSync(dir);
  const pngs = files.filter((f) => f.endsWith('.png'));
  const jsons = files.filter((f) => f.endsWith('.json'));
  assert(pngs.length === 3, `PNG trovati: ${pngs.join(', ')}`);
  assert(jsons.length === 1, `JSON trovati: ${jsons.join(', ')}`);
  for (const p of pngs) assert(statSync(path.join(dir, p)).size > 1500, `PNG troppo piccolo: ${p}`);
  const json = JSON.parse(readFileSync(path.join(dir, jsons[0]), 'utf8'));
  const [el, area, drawing] = json.annotations;
  assert(el.kind === 'element' && el.selector && el.html && el.styles && el.text?.includes('Benvenuti'), 'dati elemento incompleti');
  assert(area.kind === 'area' && area.contains?.length >= 1, 'zona senza elementi contenuti');
  assert(drawing.kind === 'drawing' && drawing.path?.length > 2, 'disegno senza tratto');
  if (shotsDir) for (const p of pngs) writeFileSync(path.join(shotsDir, `annotazione-${p}`), readFileSync(path.join(dir, p)));
  return `selettore "${el.selector}", componenti ${JSON.stringify(el.components)}`;
});

await check('Invio automatico: il prompt viene anche inviato', async () => {
  await page.click('label.switch:has(#auto-send)');
  assert(await page.isChecked('#auto-send'), 'interruttore non attivo');
  await page.click('[data-mode="select"]');
  const b = await box('main p a');
  await page.mouse.move(b.x + 5, b.y + b.height / 2, { steps: 4 });
  await sleep(150);
  await page.mouse.click(b.x + 5, b.y + b.height / 2);
  await sleep(250);
  await page.keyboard.type('Link in grassetto');
  await page.keyboard.press('Enter');
  await waitFor(() => page.evaluate(() => window.__riverloopStudio.pending() === 1), 5000, 100, 'annotazione in sospeso');
  await page.click('#btn-send');
  const sub = await waitFor(() => fakeEvents().find((e) => e.event === 'submit' && e.line.includes('4. Elemento')), 20000, 150, 'invio automatico');
  const absorbed = fakeEvents().filter((e) => e.event === 'absorbed-enter').length;
  // Subito dopo l'invio il finto claude chiede un permesso (con la prima riga del messaggio nel
  // testo): l'invio automatico non deve premere Invio un'altra volta, altrimenti lo approverebbe.
  await waitFor(async () => (await terminalText()).includes('Do you want to proceed?'), 5000, 100, 'richiesta di permesso');
  await sleep(4500);
  const approved = fakeEvents().filter((e) => e.event === 'approved').length;
  assert(approved === 0, "l'invio automatico ha approvato una richiesta di permesso");
  const extra = fakeEvents().filter((e) => e.event === 'input' && e.data === '\r' && e.t > sub.t).length;
  assert(extra === 0, `Invio ripetuti dopo l'invio: ${extra}`);
  await shot(page, '06-permesso');
  return `${sub.line.length} caratteri; Invio assorbiti dal finto claude lento e ripetuti: ${absorbed}; nessun Invio sulla richiesta di permesso`;
});

await check('con una richiesta di permesso aperta Studio non incolla: prima si risponde nella console', async () => {
  // La richiesta di permesso del test precedente è ancora aperta
  await page.click('[data-mode="select"]');
  const b = await box('main p');
  await page.mouse.move(b.x + 5, b.y + b.height / 2, { steps: 4 });
  await sleep(150);
  await page.mouse.click(b.x + 5, b.y + b.height / 2);
  await sleep(250);
  await page.keyboard.type('Testo più grande');
  await page.keyboard.press('Enter');
  await waitFor(() => page.evaluate(() => window.__riverloopStudio.pending() === 1), 5000, 100, 'annotazione in sospeso');
  const pastesBefore = fakeEvents().filter((e) => e.event === 'input' && e.data.includes('\x1b[200~')).length;
  await page.click('#btn-send');
  await waitFor(
    () => page.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast.error')).some((t) => t.textContent.includes('aspettando una tua risposta'))),
    8000,
    100,
    'avviso "Claude Code sta aspettando una tua risposta"',
  );
  await sleep(500);
  const pastesAfter = fakeEvents().filter((e) => e.event === 'input' && e.data.includes('\x1b[200~')).length;
  assert(pastesAfter === pastesBefore, 'il messaggio è stato incollato sopra la richiesta di permesso');
  assert(!fakeEvents().some((e) => e.event === 'approved'), 'richiesta di permesso approvata');
  assert((await page.evaluate(() => window.__riverloopStudio.pending())) === 1, "l'annotazione deve restare da inviare");
  // Risposta nella console (Esc = annulla), poi il nuovo invio passa
  await page.click('#terminal');
  await page.keyboard.press('Escape');
  await waitFor(() => fakeEvents().filter((e) => e.event === 'dialog-cancelled').length === 1, 5000, 100, 'richiesta annullata');
  await page.click('#btn-send');
  await waitFor(() => fakeEvents().some((e) => e.event === 'submit' && e.line.includes('Testo più grande')), 15000, 150, 'invio dopo la risposta');
  const tail = async () => (await terminalText()).split('\n').slice(-14).join('\n');
  await waitFor(async () => (await tail()).includes('Do you want to proceed?'), 5000, 100, 'nuova richiesta di permesso');
  await sleep(2500);
  assert(!fakeEvents().some((e) => e.event === 'approved'), 'richiesta di permesso approvata');
  await page.click('#terminal');
  await page.keyboard.press('Escape');
  await waitFor(() => fakeEvents().filter((e) => e.event === 'dialog-cancelled').length === 2, 5000, 100, 'seconda richiesta annullata');
});

await check('Esc torna a Naviga; S/R/D cambiano strumento anche dal pannello', async () => {
  await page.click('[data-mode="area"]');
  await page.keyboard.press('Escape');
  await waitFor(() => page.evaluate(() => document.querySelector('[data-mode="navigate"]').classList.contains('active')), 3000, 100, 'Naviga');
  await page.focus('#pane-app');
  await page.keyboard.press('d');
  await waitFor(() => page.evaluate(() => document.querySelector('[data-mode="draw"]').classList.contains('active')), 3000, 100, 'Disegno');
  await page.keyboard.press('Escape');
});

await check('viewport Mobile (390 px)', async () => {
  await page.click('[data-viewport="mobile"]');
  await sleep(500);
  const w = await appFrame().evaluate(() => innerWidth);
  assert(w === 390, `larghezza ${w}`);
  await shot(page, '06-mobile');
  await page.click('[data-viewport="desktop"]');
});

// ---------------------------------------------------------------------------
// 4. Sicurezza
// ---------------------------------------------------------------------------
function tryWs(url, protocols, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, { headers });
    const done = (v) => {
      try {
        ws.terminate();
      } catch {}
      resolve(v);
    };
    ws.on('open', () => done('open'));
    ws.on('unexpected-response', (_req, res) => done(`http ${res.statusCode}`));
    ws.on('error', (e) => done(`error ${e.message}`));
  });
}

await check('WebSocket della console: rifiutato senza token o con Origin/Host sbagliati', async () => {
  const url = `ws://127.0.0.1:${studioPort}/ws/term`;
  const origin = `http://127.0.0.1:${studioPort}`;
  const proxyCookie = (await context.cookies()).find((c) => c.name === `rls_proxy_${studioPort}`);
  const cases = {
    senzaToken: await tryWs(url, ['riverloop-studio'], { Origin: origin }),
    soloCookieProxy: await tryWs(url, ['riverloop-studio'], { Origin: origin, Cookie: `${proxyCookie.name}=${proxyCookie.value}` }),
    originProxy: await tryWs(url, wsProtocols, { Origin: `http://127.0.0.1:${proxyPort}` }),
    originEsterna: await tryWs(url, wsProtocols, { Origin: 'http://evil.example' }),
    hostEsterno: await tryWs(url, wsProtocols, { Origin: origin, Host: `evil.example:${studioPort}` }),
    corretto: await tryWs(url, wsProtocols, { Origin: origin }),
  };
  assert(cases.senzaToken.startsWith('http 401'), `senza token: ${cases.senzaToken}`);
  assert(cases.soloCookieProxy.startsWith('http 401'), `cookie del proxy: ${cases.soloCookieProxy}`);
  assert(cases.originProxy.startsWith('http 403'), `origin proxy: ${cases.originProxy}`);
  assert(cases.originEsterna.startsWith('http 403'), `origin esterna: ${cases.originEsterna}`);
  assert(cases.hostEsterno.startsWith('http 403'), `host esterno: ${cases.hostEsterno}`);
  assert(cases.corretto === 'open', `corretto: ${cases.corretto}`);
  return Object.entries(cases)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
});

await check("l'app nell'iframe non può aprire la console né inviare annotazioni", async () => {
  const f = appFrame();
  const wsResult = await f.evaluate(
    (port) =>
      new Promise((r) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term`);
        ws.onopen = () => r('open');
        ws.onerror = () => r('error');
        ws.onclose = () => r('closed');
        setTimeout(() => r('timeout'), 4000);
      }),
    studioPort,
  );
  assert(wsResult !== 'open', `WebSocket: ${wsResult}`);
  const post = await f.evaluate(async (port) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/annotation`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: [] }),
      });
      return `http ${res.status}`;
    } catch (err) {
      return `bloccato (${err.message})`;
    }
  }, studioPort);
  assert(!post.startsWith('http 200'), `POST: ${post}`);
  return `ws=${wsResult}, post=${post}`;
});

await check("gli script dell'app non possono creare né inviare annotazioni via postMessage", async () => {
  const inputsBefore = fakeEvents().filter((e) => e.event === 'input').length;
  const pendingBefore = await page.evaluate(() => window.__riverloopStudio.pending());
  await appFrame().evaluate((origin) => {
    const msg = (m) => window.parent.postMessage({ ...m, source: 'riverloop-studio' }, origin);
    msg({
      type: 'annotation:create',
      localId: 'evil1',
      data: { kind: 'element', url: '/', comment: 'INIETTATO', rect: {}, viewportRect: {}, viewport: {}, anchor: {} },
    });
    msg({ type: 'annotation:create', localId: 'evil2', data: { kind: 'element', url: {}, comment: 1 } });
    msg({ type: 'send' });
  }, `http://127.0.0.1:${studioPort}`);
  await sleep(1500);
  const pendingAfter = await page.evaluate(() => window.__riverloopStudio.pending());
  const inputsAfter = fakeEvents().filter((e) => e.event === 'input').length;
  assert(pendingAfter === pendingBefore, `annotazioni create dall'app: ${pendingAfter - pendingBefore}`);
  assert(inputsAfter === inputsBefore, 'qualcosa è arrivato al PTY');
  assert(!fakeEvents().some((e) => e.event === 'input' && e.data.includes('INIETTATO')), 'testo iniettato nel PTY');
});

await check('proxy e API: Host non ammesso, richieste senza credenziali rifiutate', async () => {
  const proxyCookie = (await context.cookies()).find((c) => c.name === `rls_proxy_${studioPort}`);
  const pc = `${proxyCookie.name}=${proxyCookie.value}`;
  // Richieste "a mano" (come curl): l'header Host si può falsificare, a differenza di fetch
  const code = (port, pathname, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(String(res.statusCode)));
      });
      req.on('error', reject);
      req.end();
    });
  const r = {
    proxyHostEsterno: await code(proxyPort, '/', { Host: 'attacker.example', Cookie: pc }),
    proxySenzaCookie: await code(proxyPort, '/'),
    proxyCookieFalso: await code(proxyPort, '/', { Cookie: `rls_proxy_${studioPort}=${token}` }),
    apiSenzaToken: await code(studioPort, '/api/config'),
    apiConCookieProxy: await code(studioPort, '/api/config', { Cookie: pc }),
    apiConToken: await code(studioPort, '/api/config', { 'X-Studio-Token': token }),
  };
  assert(r.proxyHostEsterno === '403' && r.proxySenzaCookie === '403' && r.proxyCookieFalso === '403', JSON.stringify(r));
  assert(r.apiSenzaToken === '401' && r.apiConCookieProxy === '401' && r.apiConToken === '200', JSON.stringify(r));
  const leaked = await appFrame().evaluate(() => document.cookie);
  assert(!leaked.includes('rls_'), "un cookie di Studio è leggibile dall'app");
  return Object.entries(r)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
});

await check('suggerimenti: un clic manda la richiesta a Claude Code, senza toccare i file del progetto', async () => {
  if (!suggested) return 'nessun suggerimento per questo progetto (già configurato)';
  const configBefore = pageFile ? readFileSync(pageFile, 'utf8') : '';
  await page.click('[data-viewport="desktop"]');
  // Rimandato con "Non ora": resta disponibile dal pulsante in alto
  await page.click('#btn-suggest');
  await page.waitForSelector('#suggest:not([hidden])', { timeout: 5000 });
  assert((await page.textContent('#suggest-apply')).includes('Chiedi a Claude'), 'pulsante sbagliato');
  await page.click('#suggest-apply');
  const sent = await waitFor(
    () => fakeEvents().find((e) => e.event === 'submit' && e.line.includes(suggested.marker)),
    20000,
    150,
    'richiesta arrivata a Claude e inviata',
  );
  assert(sent.line.startsWith(suggested.start), `testo della richiesta: ${sent.line.slice(0, 80)}`);
  await waitFor(
    () => page.evaluate(() => document.getElementById('suggest').hidden && document.getElementById('btn-suggest').hidden),
    5000,
    100,
    'riquadro e pulsante spariti',
  );
  // Studio non ha modificato nulla: lo farà Claude (qui è finto, quindi i file restano uguali)
  assert(!pageFile || readFileSync(pageFile, 'utf8') === configBefore, 'file del progetto modificati da Studio');
  // chiesto una volta, non si ripropone al ricaricamento
  const again = await page.evaluate(
    async (t) => (await (await fetch('/api/suggestions', { headers: { 'X-Studio-Token': t } })).json()).suggestions.length,
    token,
  );
  assert(again === suggested.others, `suggerimenti rimasti: ${again}`);
  return suggested.title;
});

await check('Annulla e Ripeti: i file tornano a prima della richiesta, e poi di nuovo avanti', async () => {
  assert(pageFile, 'page.tsx non trovato');
  await page.click('[data-viewport="desktop"]');
  const before = readFileSync(pageFile, 'utf8');
  assert(before.includes('Benvenuti in Riverloop Studio'), 'testo di partenza non trovato');
  // Le richieste inviate finora hanno lasciato un punto a cui tornare
  await waitFor(
    () => page.evaluate(() => !document.getElementById('history').hidden && !document.getElementById('code-undo').disabled),
    8000,
    150,
    'Annulla disponibile',
  );
  assert(await page.evaluate(() => document.getElementById('code-redo').disabled), 'Ripeti attivo senza nulla da ripetere');
  // Ciò che farebbe Claude dopo la richiesta: modifica un file e ne crea uno
  const changed = before.replace('Benvenuti in Riverloop Studio', 'Titolo cambiato da Claude');
  const extra = path.join(path.dirname(pageFile), 'creato-da-claude.txt');
  writeFileSync(pageFile, changed);
  writeFileSync(extra, 'nuovo file\n');
  await waitFor(
    async () => (await appFrame().evaluate(() => document.querySelector('h1')?.textContent || '')).includes('Titolo cambiato'),
    30000,
    250,
    'modifica visibile',
  );
  await sleep(1700);
  await page.click('#code-undo');
  await waitFor(() => readFileSync(pageFile, 'utf8') === before && !existsSync(extra), 15000, 150, 'file ripristinati');
  await waitFor(
    async () => (await appFrame().evaluate(() => document.querySelector('h1')?.textContent || '')).includes('Benvenuti'),
    30000,
    250,
    'app tornata a prima',
  );
  await waitFor(() => page.evaluate(() => !document.getElementById('code-redo').disabled), 5000, 100, 'Ripeti disponibile');
  await page.click('#code-redo');
  await waitFor(() => readFileSync(pageFile, 'utf8') === changed && existsSync(extra), 15000, 150, 'modifiche rimesse');
  // Si torna allo stato di partenza per i controlli che seguono
  await sleep(600);
  await page.click('#code-undo');
  await waitFor(() => readFileSync(pageFile, 'utf8') === before && !existsSync(extra), 15000, 150, 'di nuovo ripristinati');
  // Il repository del progetto, se c'è, non è stato toccato; nel progetto non compaiono file di Studio oltre a .claude/studio
  assert(!existsSync(path.join(appDir, '.riverloop')), 'cartella di Studio nel progetto');
});

await check('schede: doppio clic sul nome per rinominarla, Esc annulla, nome vuoto torna quello standard', async () => {
  const api = async () => (await (await fetch(`http://127.0.0.1:${studioPort}/api/sessions`, { headers: { 'X-Studio-Token': token } })).json()).sessions[0];
  await page.dblclick('#session-tabs .stab .sname');
  await page.waitForSelector('#session-tabs .srename', { timeout: 3000 });
  await page.keyboard.type('Bug urgenti');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await api()).name === 'Bug urgenti', 5000, 100, 'nome salvato');
  await waitFor(async () => (await page.textContent('#session-tabs .stab .sname')) === 'Bug urgenti', 5000, 100, 'nome nella scheda');
  // Esc lascia tutto com'era
  await page.dblclick('#session-tabs .stab .sname');
  await page.keyboard.type(' altro');
  await page.keyboard.press('Escape');
  await sleep(300);
  assert((await api()).name === 'Bug urgenti', 'Esc ha cambiato il nome');
  // Nome vuoto: si torna a quello standard
  await page.dblclick('#session-tabs .stab .sname');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await waitFor(async () => !(await api()).renamed, 5000, 100, 'nome standard');
  assert((await page.textContent('#session-tabs .stab .sname')) === 'Claude Code', 'etichetta della scheda unica');
});

await check('barra di Claude: modello, effort, modalità, goal e utilizzo dalla status line; comandi solo a riquadro libero', async () => {
  const commands = () => fakeEvents().filter((e) => e.event === 'command');
  const label = (id) => page.evaluate((sel) => document.querySelector(sel).selectedOptions[0]?.textContent ?? '', id);
  // I dati arrivano dalla status line (script di Studio passato a Claude Code con --settings)
  await waitFor(async () => (await label('#cb-model')).includes('Fake Opus'), 15000, 200, 'modello dalla status line');
  await waitFor(async () => (await page.textContent('#cb-usage')).includes('5h 12%'), 5000, 200, 'utilizzo');
  assert((await label('#cb-effort')).includes('medium'), `effort: ${await label('#cb-effort')}`);
  assert((await label('#cb-mode')).includes('manuale'), `modalità: ${await label('#cb-mode')}`);

  // Con del testo non inviato nel riquadro di input il comando non parte
  await page.click('#terminal');
  await page.keyboard.type('bozza');
  await sleep(400);
  const before = commands().length;
  await page.selectOption('#cb-model', 'sonnet');
  await waitFor(
    () => page.evaluate(() => [...document.querySelectorAll('.toast.error')].some((el) => el.textContent.includes('non inviato'))),
    5000,
    100,
    'avviso testo nel riquadro',
  );
  assert(commands().length === before, 'comando inviato con del testo nel riquadro');
  await page.click('#terminal');
  // Cancella la bozza (e quel che resta dai passi precedenti)
  for (let i = 0; i < 40; i++) await page.keyboard.press('Backspace');
  await sleep(400);

  await page.selectOption('#cb-model', 'sonnet');
  await waitFor(() => commands().some((c) => c.name === 'model' && c.arg === 'sonnet'), 8000, 150, '/model sonnet');
  await waitFor(async () => (await label('#cb-model')).includes('Fake Sonnet'), 8000, 200, 'nuovo modello nella barra');
  await page.selectOption('#cb-effort', 'high');
  await waitFor(() => commands().some((c) => c.name === 'effort' && c.arg === 'high'), 8000, 150, '/effort high');
  await waitFor(async () => (await label('#cb-effort')).includes('high'), 8000, 200, 'effort nella barra');

  // Ultracode dalla barra: "/effort ultracode on"; non è nella status line, la barra lo legge dallo schermo
  await page.selectOption('#cb-effort', 'ultracode:on');
  await waitFor(() => commands().some((c) => c.name === 'effort' && c.arg === 'ultracode on'), 8000, 150, '/effort ultracode on');
  await waitFor(async () => (await label('#cb-effort')).includes('high · ultracode'), 8000, 200, 'ultracode nella barra');
  assert(
    await page.evaluate(() => [...document.querySelector('#cb-effort').options].some((o) => o.value === 'ultracode:off')),
    'manca la voce per spegnere ultracode',
  );

  // Comandi scritti direttamente nella console: la barra li segue senza essere usata
  const typeInConsole = async (text) => {
    await page.click('#terminal');
    await page.keyboard.type(text);
    await sleep(200);
    await page.keyboard.press('Enter');
  };
  await typeInConsole('/effort low');
  await waitFor(() => commands().some((c) => c.name === 'effort' && c.arg === 'low'), 8000, 150, '/effort low nella console');
  await waitFor(async () => (await label('#cb-effort')).includes('low · ultracode'), 8000, 200, 'effort low dalla console');
  await typeInConsole('/effort ultracode off');
  await waitFor(() => commands().some((c) => c.name === 'effort' && c.arg === 'ultracode off'), 8000, 150, '/effort ultracode off nella console');
  // Spento, non sconosciuto: lo stato della sessione dice false e il menu offre di nuovo di accenderlo
  const claudeStatus = async () =>
    (await (await fetch(`http://127.0.0.1:${studioPort}/api/sessions`, { headers: { 'X-Studio-Token': token } })).json()).sessions[0].claude;
  await waitFor(async () => (await claudeStatus()).ultracode === false, 8000, 200, 'ultracode spento dalla console');
  await waitFor(async () => !(await label('#cb-effort')).includes('ultracode'), 8000, 200, 'ultracode spento nella barra');
  assert((await label('#cb-effort')).includes('low'), `effort: ${await label('#cb-effort')}`);
  assert(
    await page.evaluate(() => [...document.querySelector('#cb-effort').options].some((o) => o.value === 'ultracode:on')),
    'manca la voce per accendere ultracode',
  );
  await typeInConsole('/model haiku');
  await waitFor(async () => (await label('#cb-model')).includes('Fake Haiku'), 8000, 200, 'modello dalla console');

  // Modalità: Studio preme Shift+Tab finché Claude Code non mostra quella scelta
  await page.selectOption('#cb-mode', 'plan');
  await waitFor(
    () =>
      fakeEvents()
        .filter((e) => e.event === 'mode')
        .at(-1)?.mode === 'plan',
    8000,
    150,
    'modalità piano',
  );
  await waitFor(async () => (await label('#cb-mode')).includes('piano'), 8000, 200, 'modalità nella barra');
  await page.selectOption('#cb-mode', 'default');
  await waitFor(
    () =>
      fakeEvents()
        .filter((e) => e.event === 'mode')
        .at(-1)?.mode === 'default',
    8000,
    150,
    'ritorno a manuale',
  );

  // Goal
  await page.click('#cb-goal');
  await page.fill('#goal-text', 'tutti i test passano');
  await page.click('#goal-set');
  await waitFor(() => commands().some((c) => c.name === 'goal' && c.arg === 'tutti i test passano'), 8000, 150, '/goal');
  await page.click('#cb-usage');
  await waitFor(() => commands().some((c) => c.name === 'usage'), 8000, 150, '/usage');
  return commands()
    .map((c) => `/${c.name}${c.arg ? ' ' + c.arg : ''}`)
    .join(', ');
});

// ---------------------------------------------------------------------------
// 5. Uscita di claude e riavvio
// ---------------------------------------------------------------------------
await check('claude termina → "Sessione terminata" → Riprendi (--continue)', async () => {
  await page.click('#terminal');
  await page.keyboard.press('Control+D');
  await waitFor(() => page.isVisible('#exit-overlay'), 8000, 100, 'overlay di uscita');
  await shot(page, '07-terminata');
  await page.click('[data-restart="continue"]');
  await waitFor(() => fakeEvents().filter((e) => e.event === 'start').length === 2, 10000, 150, 'riavvio');
  const last = fakeEvents()
    .filter((e) => e.event === 'start')
    .at(-1);
  assert(JSON.stringify(withoutSettings(last.argv)) === JSON.stringify(['--continue', '--model', 'fake model']), `argv ${JSON.stringify(last.argv)}`);
  await waitFor(async () => !(await page.isVisible('#exit-overlay')), 5000, 100, 'console di nuovo attiva');
});

await check('permessi: "Salta tutte le conferme" riavvia claude con --continue e resta salvato', async () => {
  const startsBefore = fakeEvents().filter((e) => e.event === 'start').length;
  await page.click('#btn-perms');
  await page.check('input[name="perm"][value="skip"]');
  await shot(page, '08-permessi');
  await page.click('#perm-apply');
  await waitFor(() => fakeEvents().filter((e) => e.event === 'start').length === startsBefore + 1, 10000, 150, 'riavvio con i nuovi permessi');
  const last = fakeEvents()
    .filter((e) => e.event === 'start')
    .at(-1);
  assert(
    JSON.stringify(withoutSettings(last.argv)) === JSON.stringify(['--dangerously-skip-permissions', '--continue', '--model', 'fake model']),
    `argv ${JSON.stringify(last.argv)}`,
  );
  await waitFor(async () => (await page.textContent('#perm-label')) === 'Senza conferme', 5000, 100, 'etichetta dei permessi');
  assert(!(await page.isVisible('#exit-overlay')), 'il riavvio voluto non deve mostrare "Sessione terminata"');
  // La scelta resta per l'utente, fuori dal progetto: un file del progetto non deve poterla decidere
  const saved = JSON.parse(readFileSync(path.join(tmp, 'config', 'projects.json'), 'utf8'));
  assert(
    Object.values(saved).some((p) => p.permissions === 'skip'),
    `projects.json: ${JSON.stringify(saved)}`,
  );
  const stateFile = path.join(appDir, '.claude', 'studio', 'state.json');
  assert(!existsSync(stateFile) || !('permissions' in JSON.parse(readFileSync(stateFile, 'utf8'))), 'permessi salvati nel progetto');
  // e ritorno alle conferme
  await page.click('#btn-perms');
  await page.check('input[name="perm"][value="ask"]');
  await page.click('#perm-apply');
  await waitFor(() => fakeEvents().filter((e) => e.event === 'start').length === startsBefore + 2, 10000, 150, 'ritorno alle conferme');
  const again = fakeEvents()
    .filter((e) => e.event === 'start')
    .at(-1);
  assert(!again.argv.includes('--dangerously-skip-permissions'), `argv ${JSON.stringify(again.argv)}`);
  await waitFor(async () => (await page.textContent('#perm-label')) === 'Permessi standard', 5000, 100, 'etichetta dei permessi standard');
  return `argv con conferme saltate: ${JSON.stringify(last.argv)}`;
});

// ---------------------------------------------------------------------------
// 6. Chiusura ordinata
// ---------------------------------------------------------------------------
if (pageFile && originalPage) writeFileSync(pageFile, originalPage);
await browser.close();

await check('Ctrl+C chiude claude, dev server e companion senza processi orfani', async () => {
  const claudePid = fakeEvents()
    .filter((e) => e.event === 'start')
    .at(-1).pid;
  const windows = process.platform === 'win32';
  const ps = () => execSync('ps -eo pid=,pgid=,ppid=,args=').toString();
  let devPids;
  // Windows: processo → "nome|ora di avvio", per non scambiare un numero riusato per lo stesso processo
  const winProcesses = () =>
    JSON.parse(
      execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, @{n=\'Created\';e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress"',
        { maxBuffer: 32 * 1024 * 1024 },
      ).toString(),
    );
  let identity = new Map();
  if (windows) {
    // Su Windows non ci sono gruppi di processi: il dev server è l'albero dei figli di riverloop-studio (tolto claude).
    // Il padre indicato da Windows può essere un numero riusato: un figlio conta solo se è nato dopo il padre.
    const rows = winProcesses();
    const created = new Map(rows.map((r) => [r.ProcessId, r.Created]));
    identity = new Map(rows.map((r) => [r.ProcessId, `${r.Name}|${r.Created}`]));
    const children = (pid) => rows.filter((r) => r.ParentProcessId === pid && r.Created >= (created.get(pid) ?? 0)).map((r) => r.ProcessId);
    const tree = (pid) => [pid, ...children(pid).flatMap(tree)];
    const claudeTree = new Set(tree(claudePid));
    devPids = children(studio.pid)
      .flatMap(tree)
      .filter((pid) => !claudeTree.has(pid));
  } else {
    const rows = ps()
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((r) => r.length >= 4)
      .map(([pid, pgid, ppid, ...cmd]) => ({ pid: Number(pid), pgid: Number(pgid), ppid: Number(ppid), cmd: cmd.join(' ') }));
    // Il dev server avviato da Studio è figlio diretto di riverloop-studio e capogruppo dei suoi processi
    const devLeaders = rows.filter((r) => r.ppid === studio.pid && r.pid !== claudePid).map((r) => r.pgid);
    devPids = rows.filter((r) => devLeaders.includes(r.pgid)).map((r) => r.pid);
  }
  assert(devPids.length > 0, 'processi del dev server non trovati');
  if (windows) {
    // A un processo figlio su Windows non si può inviare Ctrl+C: la stessa chiusura ordinata si chiede dall'API
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: studioPort,
          path: '/api/shutdown',
          method: 'POST',
          headers: { 'X-Studio-Token': token, Origin: `http://127.0.0.1:${studioPort}`, 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
  } else {
    studio.kill('SIGINT');
  }
  await waitFor(() => studioExit, 20000, 100, 'uscita di riverloop-studio');
  await sleep(500);
  // Un processo zombie (già terminato, in attesa che init lo raccolga) conta come chiuso.
  const after = windows ? new Map(winProcesses().map((r) => [r.ProcessId, `${r.Name}|${r.Created}`])) : null;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (windows) return !identity.has(pid) || after.get(pid) === identity.get(pid);
    try {
      return !execSync(`ps -o stat= -p ${pid}`).toString().trim().startsWith('Z');
    } catch {
      return false;
    }
  };
  assert(!alive(claudePid), `claude (${claudePid}) ancora attivo`);
  const orphans = devPids.filter(alive);
  assert(orphans.length === 0, `processi rimasti: ${orphans.join(', ')}`);
  const signal = fakeEvents().find((e) => e.event === 'signal');
  return `uscita ${JSON.stringify(studioExit)}, claude ha ricevuto ${signal?.sig ?? 'kill'}; ${devPids.length} processi del dev server chiusi`;
});

if (consoleErrors.length) console.log(`\n  Errori JavaScript nella pagina Studio:\n    ${consoleErrors.join('\n    ')}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} verifiche superate${failed.length ? ` — fallite: ${failed.map((f) => f.name).join('; ')}` : ''}`,
);
if (failed.length) console.log(`\n--- output di riverloop-studio ---\n${studioOut.slice(-4000)}`);
if (!studioExit) studio.kill('SIGKILL');
rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
