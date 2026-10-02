import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import getPort, { portNumbers } from 'get-port';
import { t } from './i18n.js';
import { isPortOpen, runDir } from './util.js';

/**
 * Prenotazione delle porte tra più sessioni di Studio sulla stessa macchina.
 * Due sessioni avviate quasi insieme vedrebbero libera la stessa porta (il dev server della
 * prima non l'ha ancora aperta): ogni sessione prenota le sue porte con un file di lock nella
 * cartella privata dell'utente, e le altre le saltano. I lock di processi terminati vengono
 * ignorati e rimossi. Le porte usate davvero (da chiunque) si riconoscono comunque perché
 * sono in ascolto.
 */
const lockDir = () => runDir('ports');
const held = new Set<number>();

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* non rimovibile: lo ignoriamo */
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockFile(port: number): string {
  return path.join(lockDir(), `${port}.lock`);
}

/** Porte prenotate da sessioni ancora attive (comprese le nostre). */
export function lockedPorts(): number[] {
  let names: string[];
  let dir: string;
  try {
    dir = lockDir();
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const name of names) {
    const m = /^(\d+)\.lock$/.exec(name);
    if (!m) continue;
    const port = Number(m[1]);
    let pid = 0;
    try {
      pid = Number(readFileSync(path.join(dir, name), 'utf8').trim());
    } catch {
      continue;
    }
    if (pid === process.pid || pidAlive(pid)) out.push(port);
    else removeQuietly(path.join(dir, name));
  }
  return out;
}

function tryLock(port: number): boolean {
  let file: string;
  try {
    file = lockFile(port);
  } catch {
    return true; // cartella non disponibile: niente prenotazione, si usa solo il controllo della porta
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      held.add(port);
      return true;
    } catch (err) {
      // Cartella non scrivibile: niente prenotazione, resta il controllo della porta in ascolto
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true;
      // Lock di un processo terminato: lo togliamo e riproviamo una volta
      let pid = 0;
      try {
        pid = Number(readFileSync(file, 'utf8').trim());
      } catch {
        /* illeggibile */
      }
      if (pid === process.pid) return true;
      if (pidAlive(pid)) return false;
      removeQuietly(file);
    }
  }
  return false;
}

export function releasePort(port: number): void {
  if (!held.has(port)) return;
  held.delete(port);
  try {
    if (readFileSync(lockFile(port), 'utf8').trim() === String(process.pid)) removeQuietly(lockFile(port));
  } catch {
    /* già rimosso */
  }
}

export function releaseAllPorts(): void {
  for (const port of [...held]) releasePort(port);
}

export interface ClaimOptions {
  /** Interfaccia su cui verificare la porta (default: tutte, come un dev server). */
  host?: string;
  exclude?: number[];
  /**
   * Ruolo della porta su 127.0.0.1: la pagina Studio e il proxy dell'app sono due origini che
   * non devono mai scambiarsi. Il browser conserva ciò che un'origine ha salvato (Service
   * Worker, localStorage): se una porta usata dall'app diventasse quella della pagina Studio,
   * l'app potrebbe leggere il token. Ogni porta resta legata al primo ruolo avuto.
   */
  role?: PortRole;
}

export type PortRole = 'studio' | 'proxy';
const MAX_ROLES = 400;

function rolesFile(): string {
  return path.join(lockDir(), 'roles.json');
}

/** Porte già usate con ciascun ruolo (da questa o da altre sessioni, anche passate). */
export function portRoles(): Record<PortRole, number[]> {
  try {
    const data = JSON.parse(readFileSync(rolesFile(), 'utf8')) as Partial<Record<PortRole, unknown>>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is number => Number.isInteger(p)) : []);
    return { studio: list(data.studio), proxy: list(data.proxy) };
  } catch {
    return { studio: [], proxy: [] };
  }
}

function rememberRole(port: number, role: PortRole): void {
  try {
    const roles = portRoles();
    if (roles[role].includes(port)) return;
    roles[role] = [...roles[role], port].slice(-MAX_ROLES);
    writeFileSync(rolesFile(), JSON.stringify(roles), { mode: 0o600 });
  } catch {
    /* non salvabile: vale comunque il controllo sulle sessioni attive */
  }
}

/**
 * Prenota la porta preferita se è libera, altrimenti la prima libera dopo di essa.
 * "Libera" = nessuno in ascolto, non prenotata da un'altra sessione di Studio.
 */
export async function claimPort(preferred: number, opts: ClaimOptions = {}): Promise<number> {
  const exclude = new Set(opts.exclude ?? []);
  if (opts.role) for (const p of portRoles()[opts.role === 'studio' ? 'proxy' : 'studio']) exclude.add(p);
  const from = Math.max(1024, Math.min(preferred, 65535));
  for (let i = 0; i < 40; i++) {
    for (const p of lockedPorts()) exclude.add(p);
    const port = await getPort({ port: portNumbers(from, Math.min(from + 300, 65535)), host: opts.host, exclude: [...exclude] });
    // get-port verifica di poter aprire la porta; controlliamo anche che nessuno risponda in locale.
    if (await isPortOpen(port, 300)) {
      exclude.add(port);
      continue;
    }
    if (tryLock(port)) {
      if (opts.role) rememberRole(port, opts.role);
      return port;
    }
    exclude.add(port);
  }
  throw new Error(t('ports.none', { port: preferred }));
}

process.on('exit', releaseAllPorts);
