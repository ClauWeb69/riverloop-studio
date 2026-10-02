#!/usr/bin/env node
// Più sessioni di Claude Code nella stessa pagina e più progetti dalla stessa pagina.
// Avvia Studio sul progetto A con il finto claude, apre una seconda sessione, verifica che
// ogni scheda abbia il suo processo e la sua conversazione, apre la seconda sessione in
// un'altra finestra, poi avvia Studio sul progetto B dal menu "Progetti" e lo chiude.
//
// Uso: node test/e2e/sessions.mjs --app-a <progetto> --app-b <progetto> --text-b "testo di B"
//        [--chromium <percorso>] [--shots <cartella>]
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'dist/bin/cli.js');
const FAKE = path.join(ROOT, 'test/fixtures/fake-claude.mjs');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
// Processi: su Windows non ci sono ps né processi zombie
const windows = process.platform === 'win32';
/** Il processo esiste ancora (uno zombie, già terminato, conta come chiuso). */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (windows) return true;
  try {
    return !execSync(`ps -o stat= -p ${pid}`).toString().trim().startsWith('Z');
  } catch {
    return false;
  }
};
/** Righe "pid riga di comando" di tutti i processi. */
const processLines = () =>
  windows
    ? JSON.parse(
        execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"', {
          maxBuffer: 64 * 1024 * 1024,
        }).toString(),
      ).map((p) => `${p.ProcessId} ${p.CommandLine ?? ''}`)
    : execSync('ps -eo pid=,args=').toString().split('\n');

const appA = path.resolve(opt('app-a'));
const appB = path.resolve(opt('app-b'));
const textB = opt('text-b', '');
const shotsDir = opt('shots', null);
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-sessions-'));
const fakeLog = path.join(tmp, 'fake-claude.log');
const env = {
  ...process.env,
  FAKE_CLAUDE_LOG: fakeLog,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
  RIVERLOOP_STUDIO_CONFIG_DIR: path.join(tmp, 'studio-config'),
  // Registro dei progetti, porte e log separati da quelli dell'utente
  RIVERLOOP_STUDIO_RUN_DIR: path.join(tmp, 'studio-run'),
  NO_COLOR: '1',
  // I controlli sui testi sono in italiano
  RIVERLOOP_STUDIO_LANG: 'it',
  NEXT_TELEMETRY_DISABLED: '1',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let page;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}${detail ? ` (${detail})` : ''} ${Date.now() - t0} ms`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(
      `  ✖ ${name}\n    ${String(err?.stack || err)
        .split('\n')
        .slice(0, 4)
        .join('\n    ')}`,
    );
    const toasts = await page?.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map((t) => t.textContent)).catch(() => []);
    if (toasts?.length) console.log(`    avvisi nella pagina: ${toasts.join(' | ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`timeout: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}
const events = () =>
  existsSync(fakeLog)
    ? readFileSync(fakeLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const starts = (cwd) => events().filter((e) => e.event === 'start' && path.resolve(e.cwd) === cwd);
const inputsOf = (pid) =>
  events()
    .filter((e) => e.event === 'input' && e.pid === pid)
    .map((e) => e.data)
    .join('');
const shot = async (page, name) => shotsDir && page.screenshot({ path: path.join(shotsDir, `${name}.png`) });

// ---------------------------------------------------------------------------
console.log(`\nSessioni multiple e progetti — A: ${appA}, B: ${appB}`);
const studio = spawn(process.execPath, [CLI, '--claude-bin', FAKE, '--no-open'], { cwd: appA, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
studio.stdout.on('data', (d) => (out += d));
studio.stderr.on('data', (d) => (out += d));
let studioExit = null;
studio.on('exit', (code, signal) => (studioExit = { code, signal }));
const url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}/.exec(out)?.[0], 90000, 'URL di Studio A');
const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(url)[0];

const browser = await chromium.launch({ executablePath: opt('chromium', undefined) });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(url);
await waitFor(() => page.evaluate(() => Boolean(window.__riverloopStudio)), 15000, 'pagina pronta');
const termText = (p = page) => p.evaluate(() => window.__riverloopStudio.terminalText());
const activeSession = (p = page) => p.evaluate(() => window.__riverloopStudio.session());

let pid1;
let pid2;
let conv2;

await check('una seconda sessione di Claude nella stessa pagina, con il suo processo', async () => {
  await waitFor(() => starts(appA).length === 1, 15000, 'prima sessione');
  pid1 = starts(appA)[0].pid;
  await page.click('#btn-session-new');
  await page.click('[data-session-action="new"]');
  await waitFor(() => starts(appA).length === 2, 15000, 'seconda sessione');
  const second = starts(appA)[1];
  pid2 = second.pid;
  conv2 = second.conversation;
  assert(pid2 !== pid1, 'stesso processo');
  assert(!second.argv.includes('--resume') && !second.argv.includes('--continue'), `argv ${JSON.stringify(second.argv)}`);
  await waitFor(async () => (await page.$$('.stab')).length === 2, 5000, 'due schede');
  assert((await activeSession()) === '2', 'la nuova scheda deve essere attiva');
  assert(new URL(page.url()).searchParams.get('s') === '2', `URL ${page.url()}`);
  await shot(page, 's1-due-schede');
  return `pid ${pid1} e ${pid2}`;
});

await check('ogni scheda scrive nel proprio Claude e mostra la propria console', async () => {
  await page.click('#terminal');
  await page.keyboard.type('scheda-due');
  await waitFor(() => inputsOf(pid2).includes('scheda-due'), 5000, 'input nella sessione 2');
  await page.click('.stab[data-id="1"]');
  await waitFor(async () => (await activeSession()) === '1', 5000, 'scheda 1 attiva');
  await waitFor(async () => (await termText()).includes('Fake Claude'), 5000, 'schermo della sessione 1');
  assert(!(await termText()).includes('scheda-due'), 'la console 1 mostra il testo della sessione 2');
  await page.click('#terminal');
  await page.keyboard.type('scheda-uno');
  await waitFor(() => inputsOf(pid1).includes('scheda-uno'), 5000, 'input nella sessione 1');
  assert(!inputsOf(pid1).includes('scheda-due') && !inputsOf(pid2).includes('scheda-uno'), 'input finito nella sessione sbagliata');
  // pulizia delle righe digitate
  await page.keyboard.press('Enter');
  await page.click('.stab[data-id="2"]');
  await page.click('#terminal');
  await page.keyboard.press('Enter');
});

await check('le annotazioni vanno alla scheda attiva', async () => {
  const frame = await waitFor(() => page.frames().find((f) => f.url().startsWith('http://127.0.0.1:') && f !== page.mainFrame()), 60000, 'iframe');
  await waitFor(() => frame.evaluate(() => Boolean(window.__riverloopStudioOverlay__)), 60000, 'overlay');
  assert((await activeSession()) === '2', 'scheda 2 attiva');
  await page.click('[data-mode="select"]');
  const el = await frame.waitForSelector('h1');
  const b = await el.boundingBox();
  await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 4 });
  await sleep(150);
  await page.mouse.click(b.x + 10, b.y + b.height / 2);
  await sleep(250);
  await page.keyboard.type('Annotazione per la seconda sessione');
  await page.keyboard.press('Control+Enter');
  await waitFor(() => inputsOf(pid2).includes('Annotazione per la seconda sessione'), 15000, 'incollato nella sessione 2');
  assert(!inputsOf(pid1).includes('Annotazione per la seconda sessione'), 'incollato anche nella sessione 1');
  assert((await page.getAttribute('#btn-send', 'title')).includes('Claude 2'), 'il pulsante Invia non dice a chi invia');
});

await check('"Riprendi" riprende la conversazione della propria scheda (--resume <id>)', async () => {
  await sleep(1800); // Studio legge la conversazione dal file di Claude Code
  await page.click('#terminal');
  await page.keyboard.press('Control+D');
  await waitFor(() => page.isVisible('#exit-overlay'), 8000, 'sessione terminata');
  await page.click('[data-restart="continue"]');
  await waitFor(() => starts(appA).length === 3, 10000, 'riavvio della sessione 2');
  const again = starts(appA)[2];
  const i = again.argv.indexOf('--resume');
  assert(i >= 0 && again.argv[i + 1] === conv2, `argv ${JSON.stringify(again.argv)} invece di --resume ${conv2}`);
  pid2 = again.pid;
  return `--resume ${conv2.slice(0, 8)}…`;
});

let page2;
await check("una sessione in un'altra finestra (?s=2), con la sua console", async () => {
  page2 = await context.newPage();
  await page2.goto(`${origin}/?s=2`);
  await waitFor(() => page2.evaluate(() => Boolean(window.__riverloopStudio)), 15000, 'seconda finestra');
  assert((await activeSession(page2)) === '2', 'la seconda finestra deve mostrare la sessione 2');
  await waitFor(async () => (await termText(page2)).includes('Fake Claude'), 5000, 'console della sessione 2');
  await page2.click('#terminal');
  await page2.keyboard.type('dalla-finestra');
  await waitFor(() => inputsOf(pid2).includes('dalla-finestra'), 5000, 'input dalla seconda finestra');
  await page2.keyboard.press('Enter');
  await shot(page2, 's2-seconda-finestra');
});

await check('chiudere una scheda ferma il suo Claude; le altre finestre passano a una sessione aperta', async () => {
  await page.click('.stab[data-id="2"] .sclose');
  assert(await page.isVisible('.stab.confirming'), 'manca la conferma');
  await page.click('.stab[data-id="2"] .sclose');
  await waitFor(() => events().some((e) => e.event === 'signal' && e.pid === pid2), 8000, 'claude della scheda 2 chiuso');
  await waitFor(async () => (await page.$$('.stab')).length === 1, 5000, 'una sola scheda');
  await waitFor(async () => (await activeSession(page2)) === '1', 8000, 'la seconda finestra passa alla sessione 1');
  await page.reload();
  await waitFor(() => page.evaluate(() => Boolean(window.__riverloopStudio)), 15000, 'pagina ricaricata');
  assert((await page.$$('.stab')).length === 1 && (await activeSession()) === '1', 'dopo il ricaricamento resta solo la sessione 1');
  await page2.close();
});

let pageB;
let pidB;
await check('dal menu Progetti si avvia Studio su un altro progetto, in una nuova scheda', async () => {
  await page.click('#btn-projects');
  await waitFor(() => page.isVisible('#projects-list li.current'), 5000, "progetto corrente nell'elenco");
  await page.fill('#project-path', appB);
  const [opened] = await Promise.all([context.waitForEvent('page'), page.click('#project-open')]);
  pageB = opened;
  await waitFor(() => pageB.url().startsWith('http://127.0.0.1:') && pageB.url() !== 'about:blank', 60000, 'pagina di Studio B');
  await waitFor(() => pageB.evaluate(() => Boolean(window.__riverloopStudio)), 30000, 'Studio B pronto');
  assert((await pageB.textContent('#project-name')) === path.basename(appB), 'nome del progetto B');
  if (textB) {
    await waitFor(
      async () => {
        const f = pageB.frames().find((x) => x !== pageB.mainFrame() && x.url().startsWith('http://127.0.0.1:'));
        return f && (await f.evaluate(() => document.body.innerText)).includes(textB);
      },
      90000,
      `l'app B nell'iframe ("${textB}")`,
    );
  }
  // Il nuovo progetto si è aperto in un'altra scheda: la portiamo davanti, come farebbe il browser
  await pageB.bringToFront();
  await waitFor(() => starts(appB).length === 1, 20000, 'Claude di B');
  await page.bringToFront();
  await page.click('#btn-projects');
  await page.click('#btn-projects');
  await waitFor(async () => (await page.$$('#projects-list li')).length === 2, 8000, "due progetti nell'elenco");
  const instances = await page.evaluate(async () => {
    const token = localStorage.getItem(`riverloop-studio:token:${location.port}`);
    const res = await fetch('/api/projects', { headers: { 'X-Studio-Token': token } });
    return (await res.json()).instances;
  });
  pidB = instances.find((i) => !i.current)?.pid;
  assert(pidB, 'istanza B non trovata');
  await shot(page, 's3-progetti');
  return `B su ${new URL(pageB.url()).port}`;
});

await check('lo stesso progetto non parte due volte: si riapre quello attivo', async () => {
  const [again] = await Promise.all([
    context.waitForEvent('page'),
    (async () => {
      await page.fill('#project-path', appB);
      await page.click('#project-open');
    })(),
  ]);
  await waitFor(() => again.url().startsWith('http://127.0.0.1:'), 20000, 'pagina riaperta');
  assert(new URL(again.url()).port === new URL(pageB.url()).port, 'ha avviato una seconda istanza');
  await again.close();
});

await check("dal menu Progetti si chiude l'altro progetto (Claude e dev server compresi)", async () => {
  const pidClaudeB = starts(appB)[0].pid;
  await page.click('#btn-projects');
  await page.click('#btn-projects');
  await waitFor(() => page.isVisible(`#projects-list button[data-action="close"][data-pid="${pidB}"]`), 5000, 'pulsante chiudi');
  await page.click(`#projects-list button[data-action="close"][data-pid="${pidB}"]`);
  await page.click(`#projects-list button[data-action="close"][data-pid="${pidB}"]`);
  await waitFor(() => !isAlive(pidB), 20000, 'Studio B chiuso');
  assert(!isAlive(pidClaudeB), 'Claude di B ancora attivo');
  // anche il dev server di B (e i suoi figli)
  const devB = () =>
    processLines()
      .filter((l) => l.includes(path.join(appB, 'node_modules')))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter(isAlive);
  await waitFor(() => devB().length === 0, 10000, 'dev server di B chiuso');
  await waitFor(() => pageB.isVisible('#fatal'), 8000, 'la pagina di B dice che Studio è chiuso');
  await waitFor(async () => (await page.$$('#projects-list li')).length === 1, 8000, 'elenco aggiornato');
  // B ora è tra i recenti
  await page.click('#btn-projects');
  await page.click('#btn-projects');
  // Confronto sul valore dell'attributo, non in un selettore: i percorsi di Windows hanno le barre rovesce
  await waitFor(
    () => page.evaluate((cwd) => [...document.querySelectorAll('#projects-recent button')].some((b) => b.dataset.cwd === cwd && b.offsetParent !== null), appB),
    8000,
    'B tra i recenti',
  );
  await pageB.close();
});

await check('"Chiudi" sul progetto corrente chiude Studio come Ctrl+C', async () => {
  const claudePids = starts(appA).map((e) => e.pid);
  await page.click(`#projects-list button[data-action="close"][data-pid="${studio.pid}"]`);
  await page.click(`#projects-list button[data-action="close"][data-pid="${studio.pid}"]`);
  await waitFor(() => studioExit, 20000, 'uscita di Studio A');
  assert(studioExit.code === 0, `codice ${JSON.stringify(studioExit)}`);
  await waitFor(() => page.isVisible('#fatal'), 5000, 'pagina "Studio chiuso"');
  const alive = claudePids.filter(isAlive);
  assert(alive.length === 0, `Claude ancora attivi: ${alive.join(', ')}`);
  await shot(page, 's4-chiuso');
});

if (pageErrors.length) console.log(`  Errori JavaScript: ${pageErrors.join(' | ')}`);
await browser.close();
if (!studioExit) studio.kill('SIGINT');
await sleep(500);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verifiche superate`);
if (failed.length) console.log(`\n--- output di Studio A ---\n${out.slice(-3000)}`);
const logs = path.join(env.RIVERLOOP_STUDIO_RUN_DIR, 'logs');
if (failed.length && existsSync(logs)) {
  const last = readdirSync(logs)
    .filter((f) => f.startsWith(path.basename(appB)))
    .sort()
    .at(-1);
  if (last) console.log(`\n--- log di Studio B ---\n${readFileSync(path.join(logs, last), 'utf8').slice(-3000)}`);
}
rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
