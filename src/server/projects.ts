import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppMode, ProjectInstance } from '../shared/protocol.js';
import { getLocale, localeChosen, t } from './i18n.js';
import { studioConfigDir } from './paths.js';
import { isWindows, killTree, runDir } from './util.js';

/**
 * Le istanze di Studio aperte su questo computer (una per progetto) si annunciano nella
 * cartella privata dell'utente: ogni pagina Studio può così elencarle, aprirle, avviarne una
 * per un altro progetto e chiuderle. Il file contiene il link con il token: è leggibile solo
 * dall'utente (che ha già accesso alle console di quelle istanze).
 */
const registryDir = () => runDir('instances');
const CLI = fileURLToPath(new URL('../../bin/cli.js', import.meta.url));
const MAX_RECENT = 12;
const OPEN_TIMEOUT_MS = 60000;

interface RegistryEntry {
  pid: number;
  project: string;
  cwd: string;
  studioPort: number;
  url: string;
  token: string;
  startedAt: number;
  log?: string;
}

/** Cartella delle preferenze di Studio (progetti recenti). */
export { studioConfigDir };

const normalize = (p: string) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a: string, b: string) => normalize(a) === normalize(b);

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* non rimovibile: lo ignoriamo */
  }
}

// ---------------------------------------------------------------------------
// Registro delle istanze
// ---------------------------------------------------------------------------
export function registerInstance(entry: Omit<RegistryEntry, 'pid'>): void {
  const file = path.join(registryDir(), `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, ...entry }), { mode: 0o600 });
}

/** Riscrive la voce di questa istanza se manca (per esempio tolta per errore da un'altra istanza). */
export function ensureRegistered(entry: Omit<RegistryEntry, 'pid'>): void {
  try {
    const file = path.join(registryDir(), `${process.pid}.json`);
    try {
      statSync(file);
    } catch {
      registerInstance(entry);
    }
  } catch {
    /* riproveremo */
  }
}

/** Toglie questa istanza dal registro. Non lancia mai: si usa anche durante la chiusura. */
export function unregisterInstance(): void {
  try {
    removeQuietly(path.join(registryDir(), `${process.pid}.json`));
  } catch {
    /* cartella non disponibile */
  }
}

function readEntries(): Array<RegistryEntry & { file: string }> {
  let dir: string;
  let names: string[];
  try {
    dir = registryDir();
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<RegistryEntry & { file: string }> = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const e = JSON.parse(readFileSync(file, 'utf8')) as RegistryEntry;
      if (!pidAlive(e.pid)) {
        removeQuietly(file);
        continue;
      }
      if (typeof e.url === 'string' && typeof e.cwd === 'string' && typeof e.token === 'string' && Number.isInteger(e.studioPort)) {
        out.push({ ...e, file });
      }
    } catch {
      /* file a metà scrittura o illeggibile */
    }
  }
  return out;
}

/**
 * L'istanza risponde davvero con quel token? (Dopo un'uscita brusca pid e porta possono
 * essere stati riusati da altri processi o da un'altra istanza.)
 * 'ok' = risponde; 'stale' = sicuramente non è lei (token rifiutato o porta chiusa);
 * 'slow' = non risponde in tempo (macchina carica, processo sospeso): la teniamo.
 */
function probe(entry: RegistryEntry): Promise<'ok' | 'stale' | 'slow'> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: entry.studioPort,
        path: '/api/config',
        method: 'GET',
        headers: { 'X-Studio-Token': entry.token },
        timeout: 800,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? 'ok' : res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404 ? 'stale' : 'slow');
      },
    );
    let timedOut = false;
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
    });
    req.on('error', (err) => {
      if (timedOut) return resolve('slow');
      resolve((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'stale' : 'slow');
    });
    req.end();
  });
}

/** Istanze attive (verificate: il processo esiste e la sua pagina risponde al suo token). */
export async function listInstances(): Promise<Array<RegistryEntry & { current: boolean }>> {
  const entries = readEntries();
  const status = await Promise.all(entries.map((e) => (e.pid === process.pid ? ('ok' as const) : probe(e))));
  return entries
    .filter((e, i) => {
      if (status[i] !== 'stale') return true;
      // Voce rimasta da un'istanza chiusa male (pid e porta riusati da altri)
      removeQuietly(e.file);
      return false;
    })
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ file: _file, ...e }) => ({ ...e, current: e.pid === process.pid }));
}

export function toPublic(e: RegistryEntry & { current: boolean }): ProjectInstance {
  return { pid: e.pid, project: e.project, cwd: e.cwd, url: e.url, startedAt: e.startedAt, current: e.current };
}

// ---------------------------------------------------------------------------
// Progetti recenti
// ---------------------------------------------------------------------------
/**
 * Come è stato avviato Studio l'ultima volta per un progetto (solo ciò che differisce dai valori
 * predefiniti): riaprendolo dal menu Progetti riparte allo stesso modo, per esempio come app
 * desktop con il suo comando di avvio. Sta nella configurazione dell'utente, non nel progetto.
 */
export interface LaunchOptions {
  mode?: AppMode;
  devCmd?: string;
  port?: number;
  appCmd?: string;
  windowTitle?: string;
  cdpPort?: number;
  noDev?: boolean;
}

export interface RecentProject {
  cwd: string;
  project: string;
  launch?: LaunchOptions;
}

function cleanLaunch(raw: unknown): LaunchOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: LaunchOptions = {};
  if (o.mode === 'web' || o.mode === 'electron' || o.mode === 'window') out.mode = o.mode;
  for (const key of ['devCmd', 'appCmd', 'windowTitle'] as const)
    if (typeof o[key] === 'string' && (o[key] as string).length <= 2000) out[key] = o[key] as string;
  for (const key of ['port', 'cdpPort'] as const)
    if (Number.isInteger(o[key]) && (o[key] as number) > 0 && (o[key] as number) < 65536) out[key] = o[key] as number;
  if (o.noDev === true) out.noDev = true;
  return Object.keys(out).length ? out : undefined;
}

/** Argomenti della riga di comando che riproducono le opzioni ricordate. */
export function launchArgs(launch: LaunchOptions | undefined): string[] {
  if (!launch) return [];
  const args: string[] = [];
  if (launch.mode) args.push('--mode', launch.mode);
  if (launch.devCmd) args.push('--dev-cmd', launch.devCmd);
  if (launch.port) args.push('--port', String(launch.port));
  if (launch.appCmd) args.push('--app-cmd', launch.appCmd);
  if (launch.windowTitle) args.push('--window-title', launch.windowTitle);
  if (launch.cdpPort) args.push('--cdp-port', String(launch.cdpPort));
  if (launch.noDev) args.push('--no-dev');
  return args;
}

export function readRecent(): RecentProject[] {
  try {
    const list = JSON.parse(readFileSync(path.join(studioConfigDir(), 'recent.json'), 'utf8')) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is RecentProject => typeof x?.cwd === 'string' && typeof x?.project === 'string')
      .slice(0, MAX_RECENT)
      .map((x) => {
        const launch = cleanLaunch(x.launch);
        return launch ? { cwd: x.cwd, project: x.project, launch } : { cwd: x.cwd, project: x.project };
      });
  } catch {
    return [];
  }
}

export function addRecent(cwd: string, launch?: LaunchOptions): void {
  try {
    const entry: RecentProject = { cwd, project: path.basename(cwd), ...(cleanLaunch(launch) ? { launch: cleanLaunch(launch) } : {}) };
    const list = [entry, ...readRecent().filter((r) => !samePath(r.cwd, cwd))].slice(0, MAX_RECENT);
    mkdirSync(studioConfigDir(), { recursive: true });
    writeFileSync(path.join(studioConfigDir(), 'recent.json'), `${JSON.stringify(list, null, 2)}\n`);
  } catch {
    /* preferenza non essenziale */
  }
}

// ---------------------------------------------------------------------------
// Avvio di Studio per un altro progetto
// ---------------------------------------------------------------------------
export class ProjectError extends Error {}

export interface OpenProjectOptions {
  /** Eseguibile di Claude Code già risolto (percorso assoluto), se indicato con --claude-bin. */
  claudeBin?: string;
}

/** Aperture in corso, per cartella: due clic ravvicinati non avviano due istanze. */
const opening = new Map<string, Promise<string>>();

/**
 * Avvia (in background, senza terminale) Studio nella cartella indicata e restituisce il
 * link della sua pagina. Se per quella cartella Studio è già aperto, restituisce quello.
 */
export async function openProject(dir: string, opts: OpenProjectOptions = {}): Promise<string> {
  const raw = dir.trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new ProjectError(t('projects.missingDir'));
  if (!path.isAbsolute(raw)) throw new ProjectError(t('projects.absolute'));
  const cwd = path.resolve(raw);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new ProjectError(t('projects.notFound', { path: cwd }));
  }
  const key = normalize(cwd);
  const pending = opening.get(key);
  if (pending) return pending;
  const task = (async () => {
    const existing = (await listInstances()).find((e) => samePath(e.cwd, cwd));
    if (existing) return existing.url;
    return startInstance(cwd, opts);
  })();
  opening.set(key, task);
  try {
    return await task;
  } finally {
    opening.delete(key);
  }
}

async function startInstance(cwd: string, opts: OpenProjectOptions): Promise<string> {
  const log = path.join(runDir('logs'), `${path.basename(cwd).replace(/[^\w.-]+/g, '_')}-${Date.now()}.log`);
  const fd = openSync(log, 'a', 0o600);
  const args = [CLI, '--no-open'];
  if (opts.claudeBin) args.push('--claude-bin', opts.claudeBin);
  // Come l'ultima volta per questo progetto (modalità, comando dell'app o del dev server...)
  args.push(...launchArgs(readRecent().find((r) => samePath(r.cwd, cwd))?.launch));
  // Una lingua scelta (--lang, pagina Studio) vale anche per il progetto aperto da qui
  if (localeChosen()) args.push('--lang', getLocale());
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, RIVERLOOP_STUDIO_LOG: log, RIVERLOOP_STUDIO_DETACHED: '1' },
  });
  closeSync(fd);
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));
  child.on('error', () => (exited = -1));
  child.unref();

  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const entry = readEntries().find((e) => e.pid === child.pid);
    if (entry) return entry.url;
    if (exited !== undefined) {
      let tail = '';
      try {
        tail = readFileSync(log, 'utf8')
          .replace(/\x1b\[[0-9;]*m/g, '')
          .trim()
          .split('\n')
          .slice(-6)
          .join('\n');
      } catch {
        /* nessun log */
      }
      const project = path.basename(cwd);
      throw new ProjectError(tail ? t('projects.startFailedLog', { project, log: tail }) : t('projects.startFailed', { project }));
    }
  }
  // Non è diventato raggiungibile: non lo lasciamo girare senza terminale e senza voce nel menu.
  // Prima la chiusura ordinata (ferma anche claude e il dev server), poi quella forzata.
  const pid = child.pid;
  if (pid) {
    if (isWindows) killTree(pid);
    else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* già terminato */
      }
      setTimeout(() => {
        if (pidAlive(pid)) killTree(pid, 'SIGKILL');
      }, 6000).unref();
    }
  }
  throw new ProjectError(t('projects.timeout', { seconds: OPEN_TIMEOUT_MS / 1000, project: path.basename(cwd), log }));
}

/** Chiede a un'altra istanza di chiudersi (come Ctrl+C nel suo terminale). */
export async function closeInstance(pid: number): Promise<void> {
  const entry = readEntries().find((e) => e.pid === pid);
  if (!entry) throw new ProjectError(t('projects.notOpen'));
  await new Promise<void>((resolve, reject) => {
    const origin = `http://127.0.0.1:${entry.studioPort}`;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: entry.studioPort,
        path: '/api/shutdown',
        method: 'POST',
        headers: { 'X-Studio-Token': entry.token, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': 2 },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new ProjectError(t('projects.refused', { status: String(res.statusCode) })));
      },
    );
    req.on('timeout', () => req.destroy(new ProjectError(t('projects.noResponse'))));
    req.on('error', (err) => reject(err instanceof ProjectError ? err : new ProjectError(t('projects.noResponseDetail', { message: err.message }))));
    req.end('{}');
  });
}
