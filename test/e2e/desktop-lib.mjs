// Parti comuni ai test end-to-end delle modalità desktop (electron.mjs, window.mjs).
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = path.join(ROOT, 'dist/bin/cli.js');
export const FAKE = path.join(ROOT, 'test/fixtures/fake-claude.mjs');
export const isWindows = process.platform === 'win32';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
export const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export async function waitFor(fn, timeout = 15000, interval = 150, what = 'condizione') {
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

/** Elenco dei controlli: stampa l'esito di ognuno e ricorda i falliti. */
export function suite(title) {
  const results = [];
  console.log(`\n${title}`);
  return {
    results,
    async check(name, fn) {
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
      }
    },
    summary() {
      const failed = results.filter((r) => !r.ok);
      console.log(
        `\n${results.length - failed.length}/${results.length} controlli superati${failed.length ? `, falliti: ${failed.map((f) => f.name).join('; ')}` : ''}`,
      );
      return failed.length;
    },
  };
}

/**
 * Avvia riverloop-studio con il finto claude in una cartella di progetto.
 * Cartelle di lavoro e di Claude separate: il test non tocca quelle dell'utente.
 */
export function startStudio(cwd, args, env = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rls-desktop-'));
  const fakeLog = path.join(tmp, 'fake-claude.log');
  rmSync(path.join(cwd, '.claude', 'studio'), { recursive: true, force: true });
  const proc = spawn(process.execPath, [CLI, '--claude-bin', FAKE, '--no-open', ...args], {
    cwd,
    env: {
      ...process.env,
      FAKE_CLAUDE_LOG: fakeLog,
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
      RIVERLOOP_STUDIO_RUN_DIR: path.join(tmp, 'run'),
      RIVERLOOP_STUDIO_CONFIG_DIR: path.join(tmp, 'config'),
      NO_COLOR: '1',
      // I controlli sui testi sono in italiano
      RIVERLOOP_STUDIO_LANG: 'it',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  let exit = null;
  proc.on('exit', (code, signal) => (exit = { code, signal }));
  return {
    proc,
    tmp,
    out: () => out,
    exit: () => exit,
    url: () => waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}/.exec(out)?.[0], 90000, 200, 'URL di Studio'),
    fakeEvents: () =>
      existsSync(fakeLog)
        ? readFileSync(fakeLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    /** Chiusura ordinata come dal menu Progetti (su Windows non c'è un Ctrl+C da inviare a un processo figlio). */
    async shutdown(page) {
      await page.evaluate(async () => {
        const token = Object.entries(localStorage).find(([k]) => k.startsWith('riverloop-studio:token:'))?.[1];
        await fetch('/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: '{}' });
      });
      await waitFor(() => exit !== null, 20000, 200, 'uscita di Studio');
      return exit;
    },
    kill() {
      if (exit !== null || !proc.pid) return;
      try {
        if (isWindows) execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        else process.kill(proc.pid, 'SIGKILL');
      } catch {
        /* già terminato */
      }
    },
    cleanup() {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function findChromium() {
  const given = opt('chromium', process.env.CHROMIUM_PATH);
  if (given) return given;
  const candidates = isWindows
    ? [
        `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((c) => existsSync(c));
}

export async function openStudio(url, { args = [] } = {}) {
  const executablePath = findChromium();
  assert(executablePath, 'Chromium non trovato: indica il percorso con --chromium');
  const browser = await chromium.launch({ executablePath, headless: opt('headed') === undefined, args });
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  return { browser, context, page, errors };
}

const shotsDir = opt('shots', null);
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
export async function shot(page, name) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

/**
 * Posizione e misure della tela dell'app nella pagina Studio. logicalWidth/Height sono i px
 * dell'app (pagina o finestra) e valgono 0 finché non è arrivata la prima immagine.
 */
export async function canvasBox(page) {
  return page.evaluate(() => {
    const c = document.getElementById('app-canvas');
    const r = c.getBoundingClientRect();
    const logicalWidth = Number(c.dataset.logicalWidth) || 0;
    const logicalHeight = Number(c.dataset.logicalHeight) || 0;
    return { left: r.left, top: r.top, width: r.width, height: r.height, logicalWidth, logicalHeight, pixels: logicalWidth ? c.width * c.height : 0 };
  });
}

/** Token di sessione salvato dalla pagina Studio. */
export const tokenOf = (page) => page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('riverloop-studio:token:'))?.[1]);

/** Tenta un WebSocket verso Studio e dice come è finita ('open' oppure il codice HTTP del rifiuto). */
export function tryWebSocket(url, protocols, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, origin ? { origin } : {});
    const timer = setTimeout(() => {
      ws.terminate();
      resolve('timeout');
    }, 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode);
    });
    ws.on('error', () => undefined);
  });
}

export function post(port, pathname, headers, body = '{}') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Valuta espressioni nella pagina di un'app Chromium tramite la sua porta di debug.
 * La connessione resta aperta e viene riusata: quando un client di debug si scollega,
 * Chromium annulla gli input sintetici ancora in corso (anche quelli inviati da Studio), e un
 * test che apre e chiude una connessione a ogni controllo farebbe perdere clic e tasti.
 */
const cdpSessions = new Map();

async function cdpSession(port) {
  const existing = cdpSessions.get(port);
  if (existing && existing.ws.readyState === WebSocket.OPEN) return existing;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  // Con più finestre aperte si valuta nella prima aperta (la finestra principale dell'app)
  const target = pages.find((t) => /index\.html/.test(t.url)) ?? pages[0];
  assert(target, "nessuna pagina dell'app sulla porta di debug");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const session = { ws, nextId: 0, pending: new Map() };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const p = session.pending.get(msg.id);
    if (!p) return;
    session.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error || msg.result?.exceptionDetails) p.reject(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails.text)));
    else p.resolve(msg.result.result.value);
  });
  const drop = () => {
    for (const p of session.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP: connessione chiusa'));
    }
    session.pending.clear();
    if (cdpSessions.get(port) === session) cdpSessions.delete(port);
  };
  ws.on('close', drop);
  ws.on('error', drop);
  cdpSessions.set(port, session);
  return session;
}

export async function cdpEval(port, expression) {
  const session = await cdpSession(port);
  const id = ++session.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error('CDP: nessuna risposta'));
    }, 8000);
    session.pending.set(id, { resolve, reject, timer });
    session.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

export function cdpCloseAll() {
  for (const session of cdpSessions.values()) session.ws.close();
  cdpSessions.clear();
}

/** PNG valido? (firma e dimensione minima) */
export function isPng(file, minBytes = 500) {
  const data = readFileSync(file);
  return data.length >= minBytes && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** Scrive un commento nella casella aperta e lo salva. */
export async function comment(page, text) {
  await page.waitForSelector('#cbox:not([hidden])', { timeout: 8000 });
  await page.fill('#cbox-text', text);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#cbox', { state: 'hidden', timeout: 5000 });
}

export const pending = (page) => page.evaluate(() => window.__riverloopStudio.pending());
