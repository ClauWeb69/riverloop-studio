import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.js';

export const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Log nel terminale di avvio
// ---------------------------------------------------------------------------
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  magenta: paint('35'),
  cyan: paint('36'),
  brand: paint('38;2;177;37;132'),
};

export const log = {
  info: (msg: string) => console.log(`${c.brand('◆')} ${msg}`),
  ok: (msg: string) => console.log(`${c.green('✔')} ${msg}`),
  warn: (msg: string) => console.warn(`${c.yellow('▲')} ${msg}`),
  error: (msg: string) => console.error(`${c.red('✖')} ${msg}`),
  dim: (msg: string) => console.log(c.dim(msg)),
  /** Solo con --debug (o RIVERLOOP_STUDIO_DEBUG=1): dettagli utili per segnalare un problema. */
  debug: (msg: string) => {
    if (process.env.RIVERLOOP_STUDIO_DEBUG === '1') console.log(c.dim(`[debug ${new Date().toISOString().slice(11, 23)}] ${msg}`));
  },
};

/**
 * http-proxy usa ancora util._extend, deprecato in Node 22: nasconde solo quell'avviso
 * (DEP0060) senza toccare gli altri.
 */
export function silenceKnownDeprecations(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const code = typeof args[0] === 'object' && args[0] !== null ? (args[0] as { code?: string }).code : typeof args[1] === 'string' ? args[1] : undefined;
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (code === 'DEP0060' || text.includes('util._extend')) return;
    return (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

// ---------------------------------------------------------------------------
// Testo e terminale
// ---------------------------------------------------------------------------

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Rende sicuro un testo prima di scriverlo nel PTY: rimuove sequenze di escape e caratteri
 * di controllo (C0 e C1), lasciando solo a capo e tabulazioni (convertite in spazi).
 */
export function sanitizeForTerminal(text: string): string {
  return stripAnsi(String(text ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')

    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(new RegExp('[\\u2028\\u2029]', 'g'), '\n');
}

/** Come sanitizeForTerminal ma su una sola riga. */
export function sanitizeInline(text: string, max = 300): string {
  const clean = sanitizeForTerminal(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Divide una stringa di argomenti come farebbe una shell semplice (virgolette singole e doppie). */
export function splitArgs(input: string | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else if (ch === '\\' && !isWindows && i + 1 < input.length) {
      cur += input[++i];
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Ricerca degli eseguibili (claude, claude.exe, claude.cmd)
// ---------------------------------------------------------------------------
export interface ResolvedCommand {
  /** Percorso assoluto trovato. */
  path: string;
  /** Su Windows i file .cmd/.bat vanno lanciati tramite cmd.exe. */
  viaCmd: boolean;
  /**
   * Per gli shim .cmd creati da npm: lo script JavaScript che lo shim avvia con node.
   * Lo lanciamo direttamente, senza cmd.exe (che altererebbe argomenti con % o ^).
   */
  nodeScript?: string;
}

/** Legge uno shim .cmd di npm e ricava lo script avviato ("%dp0%\node_modules\...\cli.js"). */
function npmShimTarget(cmdFile: string): string | null {
  try {
    const text = readFileSync(cmdFile, 'utf8');
    const m = /"%(?:~)?dp0%\\?([^"%]+?\.(?:js|cjs|mjs))"/i.exec(text);
    if (!m) return null;
    const script = path.join(path.dirname(cmdFile), m[1]);
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

const NODE_SCRIPT_RE = /\.(?:c|m)?js$/i;

function isExecutableFile(file: string): boolean {
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    if (isWindows) return true;
    // Gli script .js/.mjs si avviano con node: non serve il permesso di esecuzione
    accessSync(file, NODE_SCRIPT_RE.test(file) ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(name: string, extraCandidates: string[] = []): ResolvedCommand | null {
  const exts = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [''];
  const wrap = (file: string): ResolvedCommand => {
    if (NODE_SCRIPT_RE.test(file)) return { path: file, viaCmd: false, nodeScript: file };
    const viaCmd = isWindows && /\.(cmd|bat)$/i.test(file);
    const nodeScript = viaCmd ? npmShimTarget(file) : null;
    return nodeScript ? { path: file, viaCmd: false, nodeScript } : { path: file, viaCmd };
  };
  const tryFile = (base: string): ResolvedCommand | null => {
    if (isWindows && path.extname(base)) {
      if (isExecutableFile(base)) return wrap(base);
    }
    for (const ext of exts) {
      const file = base + ext;
      if (isExecutableFile(file)) return wrap(file);
    }
    return null;
  };

  // Percorso esplicito (assoluto o relativo)
  if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return tryFile(path.resolve(name));
  }
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = tryFile(path.join(dir, name));
    if (found) return found;
  }
  for (const candidate of extraCandidates) {
    const found = tryFile(candidate);
    if (found) return found;
  }
  return null;
}

/** Posizioni note in cui gli installer di Claude Code mettono l'eseguibile. */
export function claudeFallbackLocations(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(home, '.local', 'bin', 'claude'), path.join(appData, 'npm', 'claude'), path.join(localAppData, 'Programs', 'claude', 'claude')];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

/** Quote per cmd.exe: raddoppia le virgolette e protegge i metacaratteri. */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Comando e argomenti da passare a spawn/node-pty per un eseguibile risolto. */
export function commandLine(cmd: ResolvedCommand, args: string[]): { file: string; args: string[] } {
  if (cmd.nodeScript) return { file: process.execPath, args: [cmd.nodeScript, ...args] };
  if (cmd.viaCmd) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = [quoteForCmd(cmd.path), ...args.map(quoteForCmd)].join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`] };
  }
  return { file: cmd.path, args };
}

export function runVersion(cmd: ResolvedCommand, timeoutMs = 20000): { ok: boolean; output: string } {
  const { file, args } = commandLine(cmd, ['--version']);
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: cmd.viaCmd,
    env: process.env,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0 && !res.error, output: output || String(res.error?.message || '') };
}

// ---------------------------------------------------------------------------
// Processi
// ---------------------------------------------------------------------------
/** Termina un processo e tutti i suoi figli. Su Unix il processo deve essere capogruppo. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  if (isWindows) {
    // Sincrono: se Node uscisse subito dopo, un taskkill avviato in background verrebbe chiuso con lui.
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    } catch {
      /* già terminato */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* già terminato */
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Rete
// ---------------------------------------------------------------------------
function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Vero se qualcosa ascolta sulla porta in locale (IPv4 o IPv6). */
export async function isPortOpen(port: number, timeoutMs = 600): Promise<boolean> {
  const results = await Promise.all([probe('127.0.0.1', port, timeoutMs), probe('::1', port, timeoutMs)]);
  return results.some(Boolean);
}

export async function waitForPort(port: number, timeoutMs: number, shouldStop: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) return false;
    if (await isPortOpen(port, 500)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Varie
// ---------------------------------------------------------------------------
export function fileTimestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Cartella privata dell'utente per i file di lavoro condivisi tra le istanze di Studio
 * (porte prenotate, progetti aperti con i loro link, log). Non sta nella /tmp condivisa:
 * altri utenti dello stesso computer non devono poter leggere i token né creare file al suo posto.
 */
export function runDir(sub?: string): string {
  let base = process.env.RIVERLOOP_STUDIO_RUN_DIR;
  if (!base) {
    if (isWindows) base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'riverloop-studio');
    else if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Caches', 'riverloop-studio');
    else if (process.env.XDG_RUNTIME_DIR) base = path.join(process.env.XDG_RUNTIME_DIR, 'riverloop-studio');
    else base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'riverloop-studio');
  }
  const dir = sub ? path.join(base, sub) : base;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) {
    // Deve essere una cartella vera, nostra e chiusa agli altri utenti
    const st = lstatSync(dir);
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw new Error(t('util.dirNotOwned', { dir }));
    }
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}

export function hasPackageJson(cwd: string): boolean {
  return existsSync(path.join(cwd, 'package.json'));
}
